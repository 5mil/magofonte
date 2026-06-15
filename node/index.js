/**
 * MagoFonte — node module
 *
 * Coin daemon process manager.
 * Reads a coin definition, writes the daemon config,
 * spawns the process, monitors sync, and emits lifecycle events.
 *
 * Events emitted on registry:
 *   node:starting  — daemon launched
 *   node:syncing   — { height, progress } during IBD
 *   node:ready     — RPC available, fully synced (or caught up enough)
 *   node:stopped   — daemon exited
 *   node:error     — daemon crashed
 */

import { spawn }       from 'node:child_process';
import { execSync }    from 'node:child_process';
import fs              from 'node:fs';
import path            from 'node:path';
import os              from 'node:os';
import http            from 'node:http';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function rpcCall(host, port, user, pass, method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '1.0', id: 1, method, params });
    const auth = Buffer.from(`${user}:${pass}`).toString('base64');
    const req  = http.request({ host, port, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Basic ${auth}`
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { const r = JSON.parse(d); r.error ? reject(r.error) : resolve(r.result); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

// ─── CoinNode ───────────────────────────────────────────────────────────────────

export class CoinNode {
  constructor(coinDef, rpcCredentials, registry) {
    this.coin       = coinDef;
    this.creds      = rpcCredentials;   // { user, pass }
    this.registry   = registry;
    this.process    = null;
    this.status     = 'stopped';        // stopped | starting | syncing | ready | error
    this.syncHeight = 0;
    this.syncPct    = 0;
    this.peers      = 0;
    this.logs       = [];               // rolling last 200 lines
    this._readyTimer = null;
    this._syncRegex  = coinDef.daemon.syncPattern
      ? new RegExp(coinDef.daemon.syncPattern) : null;
  }

  // ── Config file generation ─────────────────────────────────────────
  writeConfig() {
    const d    = this.coin.daemon;
    const dir  = expandHome(d.configDir);
    const file = expandHome(d.configFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const lines = [
      `# MagoFonte generated — ${new Date().toISOString()}`,
      `# Coin: ${this.coin.name} (${this.coin.ticker})`,
      '',
      ...Object.entries(d.rpcConfig).map(([k, v]) => `${k}=${v}`),
      `rpcport=${d.rpcPort}`,
      `port=${d.p2pPort}`,
      `rpcuser=${this.creds.user}`,
      `rpcpassword=${this.creds.pass}`,
      ''
    ];

    fs.writeFileSync(file, lines.join('\n'));
    console.log(`[node:${this.coin.id}] wrote config: ${file}`);
    return file;
  }

  // ── Spawn ─────────────────────────────────────────────────────────────
  start() {
    if (this.process) { console.warn(`[node:${this.coin.id}] already running`); return; }

    this.writeConfig();
    this._setStatus('starting');

    const binary  = this.coin.daemon.binary;
    const args    = ['-printtoconsole'];
    console.log(`[node:${this.coin.id}] spawning: ${binary} ${args.join(' ')}`);

    this.process = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });

    this.process.stdout.setEncoding('utf8');
    this.process.stderr.setEncoding('utf8');
    this.process.stdout.on('data', d => this._onLog(d));
    this.process.stderr.on('data', d => this._onLog(d));

    this.process.on('exit', (code, signal) => {
      console.log(`[node:${this.coin.id}] exited code=${code} signal=${signal}`);
      this.process = null;
      this._setStatus(code === 0 ? 'stopped' : 'error');
      this.registry.emit('node:stopped', { coin: this.coin.id, code });
    });

    this.registry.emit('node:starting', { coin: this.coin.id });

    // Poll RPC until available — then emit node:ready
    this._pollRpcReady();
  }

  stop() {
    if (!this.process) return;
    console.log(`[node:${this.coin.id}] stopping...`);
    // Send RPC stop first (clean shutdown)
    rpcCall('127.0.0.1', this.coin.daemon.rpcPort,
            this.creds.user, this.creds.pass, 'stop')
      .catch(() => {
        // If RPC stop fails, kill the process
        this.process?.kill('SIGTERM');
      });
    clearTimeout(this._readyTimer);
  }

  restart() { this.stop(); setTimeout(() => this.start(), 3000); }

  async rpc(method, params = []) {
    return rpcCall('127.0.0.1', this.coin.daemon.rpcPort,
                   this.creds.user, this.creds.pass, method, params);
  }

  // ── Internal ───────────────────────────────────────────────────────────────
  _onLog(raw) {
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines) {
      this.logs.push(line);
      if (this.logs.length > 200) this.logs.shift();
      this.registry.emit('node:log', { coin: this.coin.id, line });

      // Detect sync progress
      if (this._syncRegex) {
        const m = line.match(this._syncRegex);
        if (m) {
          this.syncHeight = parseInt(m[1]);
          this.registry.emit('node:syncing', {
            coin: this.coin.id, height: this.syncHeight
          });
          if (this.status === 'starting') this._setStatus('syncing');
        }
      }

      // Detect ready string
      if (this.coin.daemon.readyString &&
          line.includes(this.coin.daemon.readyString)) {
        this._setReady();
      }
    }
  }

  _pollRpcReady() {
    const attempt = async () => {
      try {
        await this.rpc('getblockchaininfo');
        this._setReady();
      } catch {
        if (this.process) this._readyTimer = setTimeout(attempt, 3000);
      }
    };
    this._readyTimer = setTimeout(attempt, 5000);
  }

  _setReady() {
    if (this.status === 'ready') return;
    clearTimeout(this._readyTimer);
    this._setStatus('ready');
    console.log(`[node:${this.coin.id}] ✅ RPC ready`);
    this.registry.emit('node:ready', { coin: this.coin.id, node: this });
  }

  _setStatus(s) {
    this.status = s;
    this.registry.emit('node:status', { coin: this.coin.id, status: s });
  }

  getInfo() {
    return {
      coin:       this.coin.id,
      status:     this.status,
      syncHeight: this.syncHeight,
      pid:        this.process?.pid ?? null,
      recentLogs: this.logs.slice(-10)
    };
  }
}

// ─── Node module ───────────────────────────────────────────────────────────────────
// Manages multiple coin nodes. Each coin def → one CoinNode instance.

const NodeModule = {
  name: 'node',

  async init(config, registry) {
    this.config   = config;
    this.registry = registry;
    this.nodes    = new Map();   // coinId → CoinNode

    // Auto-start nodes listed in config
    for (const entry of (config.autoStart || [])) {
      await this.launch(entry.coin, entry.rpcuser, entry.rpcpass);
    }

    return this;
  },

  // Launch a coin node from a coin definition file/object
  async launch(coinId, rpcuser, rpcpass) {
    const def = await this._loadCoinDef(coinId);
    const node = new CoinNode(def, { user: rpcuser, pass: rpcpass }, this.registry);
    this.nodes.set(coinId, node);
    node.start();
    return node;
  },

  // Load coin definition from coins/<id>.json
  async _loadCoinDef(coinIdOrPath) {
    let defPath;
    if (coinIdOrPath.endsWith('.json')) {
      defPath = coinIdOrPath;
    } else {
      defPath = new URL(`../coins/${coinIdOrPath}.json`, import.meta.url).pathname;
    }
    const raw = fs.readFileSync(defPath, 'utf8');
    return JSON.parse(raw);
  },

  // Register a coin definition from raw JSON string (console paste flow)
  async registerFromJson(jsonStr, rpcuser, rpcpass) {
    const def = JSON.parse(jsonStr);
    // Validate minimal required fields
    const required = ['id', 'name', 'ticker', 'daemon'];
    for (const f of required) {
      if (!def[f]) throw new Error(`coin definition missing field: ${f}`);
    }
    // Write to coins/ for persistence
    const outPath = new URL(`../coins/${def.id}.json`, import.meta.url).pathname;
    fs.writeFileSync(outPath, JSON.stringify(def, null, 2));
    console.log(`[node] registered coin: ${def.name} (${def.ticker}) → ${outPath}`);
    return this.launch(def.id, rpcuser, rpcpass);
  },

  get routes() {
    return [
      ['GET', '/status', (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([...this.nodes.values()].map(n => n.getInfo())));
      }],

      ['GET', '/status/:coin', (req, res) => {
        const n = this.nodes.get(req.params.coin);
        if (!n) { res.writeHead(404); return res.end(JSON.stringify({ error: 'not found' })); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(n.getInfo()));
      }],

      ['POST', '/start', async (req, res) => {
        let body = ''; req.on('data', d => body += d);
        req.on('end', async () => {
          try {
            const { coin, rpcuser, rpcpass } = JSON.parse(body);
            const node = await this.launch(coin, rpcuser, rpcpass);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, coin, pid: node.process?.pid }));
          } catch (e) {
            res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
          }
        });
      }],

      ['POST', '/stop', (req, res) => {
        let body = ''; req.on('data', d => body += d);
        req.on('end', () => {
          const { coin } = JSON.parse(body);
          this.nodes.get(coin)?.stop();
          res.writeHead(200); res.end(JSON.stringify({ ok: true }));
        });
      }],

      ['POST', '/register', async (req, res) => {
        let body = ''; req.on('data', d => body += d);
        req.on('end', async () => {
          try {
            const { coinJson, rpcuser, rpcpass } = JSON.parse(body);
            const node = await this.registerFromJson(coinJson, rpcuser, rpcpass);
            res.writeHead(201); res.end(JSON.stringify({ ok: true, coin: node.coin.id }));
          } catch(e) {
            res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
          }
        });
      }],

      ['GET', '/logs/:coin', (req, res) => {
        const n = this.nodes.get(req.params.coin);
        if (!n) { res.writeHead(404); return res.end(JSON.stringify({ error: 'not found' })); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(n.logs.slice(-50)));
      }]
    ];
  }
};

export default NodeModule;
