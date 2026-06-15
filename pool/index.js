/**
 * MagoFonte — pool module
 *
 * Three roles in one:
 *   1. Stratum SERVER  — accepts inbound miner connections on TCP
 *   2. Stratum PROXY   — relays jobs from upstream pool(s), submits shares back
 *   3. REST API        — pool list CRUD, live status
 *
 * Exports the standard module shape:
 *   { name, init(config, registry) }
 *     → returns { name, routes, api }
 */

import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

// ─── Upstream connection ────────────────────────────────────────────────────

class UpstreamConn extends EventEmitter {
  constructor(upstream) {
    super();
    this.upstream = upstream;   // { id, url, priority }
    this.socket   = null;
    this.buf      = '';
    this.msgId    = 1;
    this.pending  = {};         // id → { resolve, reject }
    this.alive    = false;
    this.jobs     = {};         // jobId → job params
    this.difficulty = 1;
    this.extranonce1     = '';
    this.extranonce2size = 4;
  }

  // Parse stratum+tcp://host:port
  static parseUrl(url) {
    const m = url.match(/stratum\+tcp:\/\/([^:]+):(\d+)/);
    if (!m) throw new Error(`Invalid stratum URL: ${url}`);
    return { host: m[1], port: parseInt(m[2]) };
  }

  connect() {
    const { host, port } = UpstreamConn.parseUrl(this.upstream.url);
    console.log(`[pool:upstream] connecting to ${this.upstream.name} (${host}:${port})`);

    this.socket = net.createConnection({ host, port }, () => {
      console.log(`[pool:upstream] connected → ${this.upstream.name}`);
      this.alive = true;
      this._subscribe();
    });

    this.socket.setEncoding('utf8');
    this.socket.on('data', d => this._onData(d));
    this.socket.on('error', err => {
      console.error(`[pool:upstream] error: ${err.message}`);
      this.alive = false;
      this.emit('disconnected');
    });
    this.socket.on('close', () => {
      this.alive = false;
      this.emit('disconnected');
      // Reconnect after 10s
      setTimeout(() => this.connect(), 10_000);
    });
  }

  _send(obj) {
    if (!this.socket || !this.alive) return;
    this.socket.write(JSON.stringify(obj) + '\n');
  }

  _rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      this.pending[id] = { resolve, reject };
      this._send({ id, method, params });
      setTimeout(() => {
        if (this.pending[id]) {
          delete this.pending[id];
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 15_000);
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this._onMessage(JSON.parse(line));
      } catch { /* ignore malformed */ }
    }
  }

  _onMessage(msg) {
    // Response to our RPC
    if (msg.id && this.pending[msg.id]) {
      const { resolve, reject } = this.pending[msg.id];
      delete this.pending[msg.id];
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    // Server push
    if (msg.method === 'mining.notify') {
      const [jobId, prevHash, coinb1, coinb2, merkleBranches,
             version, nbits, ntime, cleanJobs] = msg.params;
      this.jobs[jobId] = msg.params;
      this.emit('job', {
        jobId, prevHash, coinb1, coinb2, merkleBranches,
        version, nbits, ntime, cleanJobs,
        extranonce1:     this.extranonce1,
        extranonce2size: this.extranonce2size,
        difficulty:      this.difficulty
      });
    } else if (msg.method === 'mining.set_difficulty') {
      this.difficulty = msg.params[0];
      this.emit('difficulty', this.difficulty);
    } else if (msg.method === 'mining.set_extranonce') {
      this.extranonce1     = msg.params[0];
      this.extranonce2size = msg.params[1];
    }
  }

  async _subscribe() {
    try {
      const res = await this._rpc('mining.subscribe', ['magofonte/0.1']);
      // res = [ [["mining.set_difficulty",".."],["mining.notify",".."]], extranonce1, size ]
      if (Array.isArray(res) && res.length >= 3) {
        this.extranonce1     = res[1];
        this.extranonce2size = res[2];
      }
      console.log(`[pool:upstream] subscribed, extranonce1=${this.extranonce1}`);
      this.emit('subscribed');
    } catch (err) {
      console.error(`[pool:upstream] subscribe failed: ${err.message}`);
    }
  }

  async authorize(user, pass = 'x') {
    try {
      const ok = await this._rpc('mining.authorize', [user, pass]);
      console.log(`[pool:upstream] authorize(${user}): ${ok}`);
      return ok;
    } catch (err) {
      console.error(`[pool:upstream] authorize failed: ${err.message}`);
      return false;
    }
  }

  async submit(user, jobId, extranonce2, ntime, nonce) {
    try {
      const ok = await this._rpc('mining.submit', [user, jobId, extranonce2, ntime, nonce]);
      return ok;
    } catch {
      return false;
    }
  }

  getLatestJob() {
    const ids = Object.keys(this.jobs);
    if (!ids.length) return null;
    return this.jobs[ids[ids.length - 1]];
  }
}

// ─── Miner session (inbound worker) ────────────────────────────────────────

class MinerSession {
  constructor(socket, pool) {
    this.id         = crypto.randomUUID();
    this.socket     = socket;
    this.pool       = pool;
    this.buf        = '';
    this.msgId      = 1;
    this.authorized = false;
    this.user       = null;
    this.shares     = 0;
    this.hashrate   = 0;
    this._shareTs   = []; // timestamps for hashrate estimation
    this._attach();
  }

  _attach() {
    this.socket.setEncoding('utf8');
    this.socket.on('data', d => this._onData(d));
    this.socket.on('error', () => this._cleanup());
    this.socket.on('close', () => this._cleanup());
  }

  _cleanup() {
    this.pool.removeMiner(this.id);
  }

  send(obj) {
    try {
      this.socket.write(JSON.stringify(obj) + '\n');
    } catch { /* socket may be closed */ }
  }

  _onData(chunk) {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { this._onMessage(JSON.parse(line)); } catch { /* ignore */ }
    }
  }

  _onMessage(msg) {
    const id = msg.id;
    switch (msg.method) {
      case 'mining.subscribe': {
        const up = this.pool.activeUpstream;
        this.send({
          id,
          result: [
            [['mining.set_difficulty', this.id], ['mining.notify', this.id]],
            up ? up.extranonce1 : '00000000',
            up ? up.extranonce2size : 4
          ],
          error: null
        });
        // Send current difficulty
        this.send({ id: null, method: 'mining.set_difficulty',
                    params: [up ? up.difficulty : this.pool.config.defaultDifficulty] });
        // Send latest job if available
        const job = up?.getLatestJob();
        if (job) this._sendJob(job, false);
        break;
      }
      case 'mining.authorize': {
        const [user, pass] = msg.params || [];
        this.user       = user;
        this.authorized = true;
        this.send({ id, result: true, error: null });
        console.log(`[pool:miner] authorized: ${user} (${this.socket.remoteAddress})`);
        this.pool.registry.emit('miner:authorized', { id: this.id, user, session: this });
        break;
      }
      case 'mining.submit': {
        if (!this.authorized) {
          this.send({ id, result: false, error: [24, 'Unauthorized', null] });
          return;
        }
        const [user, jobId, extranonce2, ntime, nonce] = msg.params || [];
        this._handleShare(id, user, jobId, extranonce2, ntime, nonce);
        break;
      }
    }
  }

  _sendJob(jobParams, clean = true) {
    const [jobId, prevHash, coinb1, coinb2, merkleBranches,
           version, nbits, ntime] = jobParams;
    this.send({
      id: null,
      method: 'mining.notify',
      params: [jobId, prevHash, coinb1, coinb2, merkleBranches,
               version, nbits, ntime, clean]
    });
  }

  async _handleShare(msgId, user, jobId, extranonce2, ntime, nonce) {
    // Track share timing for hashrate
    const now = Date.now();
    this._shareTs.push(now);
    this._shareTs = this._shareTs.filter(t => now - t < 60_000);
    this.shares++;

    // Estimate hashrate: shares/min × difficulty × 2^32
    const up = this.pool.activeUpstream;
    const diff = up?.difficulty ?? this.pool.config.defaultDifficulty;
    this.hashrate = (this._shareTs.length / 60) * diff * 4_294_967_296;

    // Relay share upstream
    let accepted = false;
    if (up?.alive) {
      accepted = await up.submit(user, jobId, extranonce2, ntime, nonce);
    }

    this.send({ id: msgId, result: accepted, error: accepted ? null : [23, 'Not accepted', null] });

    this.pool.registry.emit('share', {
      minerId: this.id, user, jobId, accepted,
      shares: this.shares, hashrate: this.hashrate
    });

    console.log(`[pool:miner] share from ${user}: ${accepted ? 'ACCEPTED' : 'rejected'}`);
  }
}

// ─── Pool module ────────────────────────────────────────────────────────────

const Pool = {
  name: 'pool',

  async init(config, registry) {
    this.config   = config;
    this.registry = registry;
    this.miners   = new Map();    // id → MinerSession
    this.upstreams = [];           // UpstreamConn[]
    this.activeUpstream = null;

    // Load upstreams from config
    for (const u of (config.upstreams || [])) {
      if (u.enabled) this._addUpstream(u);
    }

    // Start stratum TCP server
    this.stratumServer = net.createServer(socket => {
      const session = new MinerSession(socket, this);
      this.miners.set(session.id, session);
      console.log(`[pool] miner connected: ${socket.remoteAddress} (total: ${this.miners.size})`);
    });

    const stratumPort = config.stratumPort || 3333;
    this.stratumServer.listen(stratumPort, '0.0.0.0', () => {
      console.log(`[pool] stratum server listening on :${stratumPort}`);
    });

    return this;
  },

  _addUpstream(upstreamCfg) {
    const conn = new UpstreamConn(upstreamCfg);

    conn.on('job', job => {
      // Fan out new jobs to all connected miners
      for (const miner of this.miners.values()) {
        if (miner.authorized) miner._sendJob(Object.values(job), job.cleanJobs);
      }
      this.registry.emit('pool:job', job);
    });

    conn.on('difficulty', diff => {
      for (const miner of this.miners.values()) {
        miner.send({ id: null, method: 'mining.set_difficulty', params: [diff] });
      }
    });

    conn.on('subscribed', () => {
      // Authorize with a placeholder — real wallet comes from vault module
      const wallet = process.env.STRATUM_USER || 'magofonte.worker';
      conn.authorize(wallet);
      if (!this.activeUpstream) this.activeUpstream = conn;
    });

    conn.on('disconnected', () => {
      if (this.activeUpstream === conn) {
        // Failover: pick next alive upstream
        this.activeUpstream = this.upstreams.find(u => u !== conn && u.alive) || null;
        console.warn('[pool] upstream disconnected, active:', this.activeUpstream?.upstream.name ?? 'none');
      }
    });

    this.upstreams.push(conn);
    conn.connect();
    return conn;
  },

  removeMiner(id) {
    const m = this.miners.get(id);
    if (m) {
      this.miners.delete(id);
      console.log(`[pool] miner disconnected: ${m.user ?? id} (total: ${this.miners.size})`);
      this.registry.emit('miner:disconnected', { id, user: m.user });
    }
  },

  // ── REST routes ────────────────────────────────────────────────────────────
  // Registered by core as: /api/v1/pool/<path>
  get routes() {
    return [
      ['GET', '/status', (req, res) => {
        const miners = [...this.miners.values()].map(m => ({
          id: m.id, user: m.user, authorized: m.authorized,
          shares: m.shares, hashrate: Math.round(m.hashrate)
        }));
        const upstreams = this.upstreams.map(u => ({
          id: u.upstream.id, name: u.upstream.name,
          url: u.upstream.url, alive: u.alive,
          active: u === this.activeUpstream,
          difficulty: u.difficulty
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ miners, upstreams, totalHashrate: miners.reduce((s,m) => s + m.hashrate, 0) }));
      }],

      ['GET', '/miners', (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([...this.miners.values()].map(m => ({
          id: m.id, user: m.user, authorized: m.authorized,
          shares: m.shares, hashrate: Math.round(m.hashrate)
        }))));
      }],

      ['GET', '/upstreams', (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.upstreams.map(u => ({
          id: u.upstream.id, name: u.upstream.name,
          url: u.upstream.url, alive: u.alive,
          active: u === this.activeUpstream,
          difficulty: u.difficulty
        }))));
      }],

      ['POST', '/upstreams', async (req, res) => {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { id, name, url, priority = 99 } = JSON.parse(body);
            if (!id || !url) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: 'id and url required' }));
            }
            const conn = this._addUpstream({ id, name: name || id, url, priority, enabled: true });
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, id: conn.upstream.id }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid JSON' }));
          }
        });
      }],

      ['DELETE', '/upstreams/:id', (req, res) => {
        const { id } = req.params;
        const idx = this.upstreams.findIndex(u => u.upstream.id === id);
        if (idx === -1) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'upstream not found' }));
        }
        const [conn] = this.upstreams.splice(idx, 1);
        conn.socket?.destroy();
        if (this.activeUpstream === conn) {
          this.activeUpstream = this.upstreams.find(u => u.alive) || null;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }]
    ];
  }
};

export default Pool;
