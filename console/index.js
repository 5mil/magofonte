/**
 * MagoFonte — console module
 *
 * Terminal control plane. Renders live status and handles
 * keyboard input to start/stop modules, launch coins, view logs.
 *
 * Keyboard controls:
 *   q         — quit
 *   s         — status overview
 *   p         — pool stats + earnings
 *   m         — monetization panel (active pool)
 *   n         — node manager
 *   c         — coin launch (paste JSON)
 *   l         — live node logs
 *   r         — force new pool job
 *   x         — pool switcher (cycle active pool)
 *   h / ?     — help
 *
 * Monetization panel (mode = 'monetization'):
 *   1–8       — toggle monetization type on/off
 *   e         — edit config for selected type
 *   s         — back to status
 */

import readline from 'node:readline';
import fs       from 'node:fs';

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const GOLD   = '\x1b[33m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const BLUE   = '\x1b[34m';
const YELLOW = '\x1b[33m';
const MAGENTA= '\x1b[35m';
const CLEAR  = '\x1b[2J\x1b[H';
const UP     = '\x1b[A';

function c(color, str) { return `${color}${str}${RESET}`; }
function hr(len = 64)  { return c(DIM, '─'.repeat(len)); }
function tag(enabled)  { return enabled ? c(GREEN, ' ● ON ') : c(DIM,  ' ○ off'); }
function badge(str, color) { return `${color}[${str}]${RESET}`; }

// ─── Monetization type display metadata ────────────────────────────────────
// Mirrors settings.js MONETIZATION_TYPES but adds console-specific display info.
const MON_META = {
  mining:            { icon: '⛏ ', color: CYAN,    shortLabel: 'PoW Mining'          },
  lightning_routing: { icon: '⚡', color: YELLOW,  shortLabel: 'Lightning Routing'    },
  rpc_endpoint:      { icon: '🔌', color: BLUE,    shortLabel: 'Public RPC Endpoint'  },
  staking:           { icon: '🥩', color: GREEN,   shortLabel: 'PoS Staking'          },
  channel_leasing:   { icon: '💧', color: MAGENTA, shortLabel: 'Channel Leasing'      },
  masternode:        { icon: '🖥 ', color: CYAN,   shortLabel: 'Masternode'           },
  merge_mining:      { icon: '⛓ ', color: YELLOW, shortLabel: 'Merge Mining'         },
  mempool_services:  { icon: '🔍', color: BLUE,   shortLabel: 'Mempool Services'     }
};

const Console = {
  name: 'console',

  async init(config, registry) {
    this.config    = config;
    this.registry  = registry;
    this.mode      = 'status';
    this.coinInput = '';
    this.logBuffer = [];
    this._statusTimer = null;
    // Monetization panel state
    this._monCursor   = 0;   // currently highlighted row (0-indexed)
    this._monOptions  = [];  // cached options from settings
    this._monPoolId   = null;

    // ── Event listeners ──────────────────────────────────────────────────
    registry.on('node:log', ({ coin, line }) => {
      this.logBuffer.push(`${c(DIM, coin)} ${line}`);
      if (this.logBuffer.length > 500) this.logBuffer.shift();
      if (this.mode === 'logs') this._renderLogs();
    });

    registry.on('block:found', ({ user, height }) =>
      this._alert(c(GOLD, BOLD + `🎉 BLOCK FOUND  height=${height}  miner=${user}`)));
    registry.on('node:ready',   ({ coin }) =>
      this._alert(c(GREEN, `✅ node:${coin} ready — pool starting`)));
    registry.on('node:stopped', ({ coin }) =>
      this._alert(c(RED,   `■  node:${coin} stopped`)));
    registry.on('pool:started', ({ coin }) =>
      this._alert(c(CYAN,  `⛏  pool:${coin} mining started`)));
    registry.on('settings:monetization:changed', ({ poolId, typeId, enabled }) => {
      this._alert(c(enabled ? GREEN : DIM, `${enabled ? '●' : '○'} ${typeId} ${enabled ? 'enabled' : 'disabled'} on pool ${poolId}`));
      // Refresh monetization panel if open
      if (this.mode === 'monetization') this._renderMonetization();
    });
    registry.on('settings:activePool:changed', ({ poolId }) => {
      this._alert(c(CYAN, `↔ active pool → ${poolId}`));
      if (this.mode === 'monetization') {
        this._monPoolId = poolId;
        this._renderMonetization();
      }
    });

    this._startInput();
    this._renderStatus();
    this._statusTimer = setInterval(() => {
      if (this.mode === 'status') this._renderStatus();
    }, 5000);

    return this;
  },

  // ── Input ────────────────────────────────────────────────────────────────

  _startInput() {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', key => this._onKey(key));
  },

  _onKey(key) {
    if (key === '\x03' || (key === 'q' && !['coin-input','mon-config'].includes(this.mode))) {
      process.stdout.write('\nShutting down...\n');
      process.exit(0);
    }

    if (this.mode === 'coin-input')  { this._handleCoinInput(key); return; }
    if (this.mode === 'monetization') { this._onMonKey(key);        return; }
    if (this.mode === 'mon-config')   { /* handled by readline */    return; }

    switch (key) {
      case 's': this.mode = 'status';         this._renderStatus();      break;
      case 'p':                               this._renderPool();         break;
      case 'm':                               this._enterMonetization();  break;
      case 'n':                               this._renderNodeMenu();     break;
      case 'c':                               this._enterCoinInput();     break;
      case 'l': this.mode = 'logs';           this._renderLogs();        break;
      case 'r':                               this._forceNewJob();        break;
      case 'x':                               this._cycleActivePool();   break;
      case 'h': case '?':                     this._renderHelp();        break;
    }
  },

  // ── Monetization panel ───────────────────────────────────────────────────

  _enterMonetization() {
    const pool = this.registry.get('pool');
    if (!pool) { this._alert(c(RED, 'pool module not running')); return; }
    const active = pool.settings?.getActivePool();
    if (!active) { this._alert(c(RED, 'no active pool — launch a coin first (c)')); return; }
    this._monPoolId  = active.id;
    this._monCursor  = 0;
    this._monOptions = pool.settings.getMonetizationOptions(active.id);
    this.mode        = 'monetization';
    this._renderMonetization();
  },

  _onMonKey(key) {
    const opts   = this._monOptions;
    const pool   = this.registry.get('pool');
    const poolId = this._monPoolId;

    // Number keys 1–8: toggle that type
    const n = parseInt(key);
    if (!isNaN(n) && n >= 1 && n <= opts.length) {
      const opt = opts[n - 1];
      if (!opt.available) {
        this._alert(c(RED, `${opt.id} not available for this coin`));
        return;
      }
      const newState = !opt.enabled;
      pool.settings.setMonetization(poolId, opt.id, newState);
      // Refresh options from settings
      this._monOptions = pool.settings.getMonetizationOptions(poolId);
      this._monCursor  = n - 1;
      this._renderMonetization();
      return;
    }

    // Arrow keys: move cursor
    if (key === '\x1b[A') { this._monCursor = Math.max(0, this._monCursor - 1);             this._renderMonetization(); return; }
    if (key === '\x1b[B') { this._monCursor = Math.min(opts.length - 1, this._monCursor + 1); this._renderMonetization(); return; }

    // Enter / space: toggle highlighted row
    if (key === '\r' || key === ' ') {
      const opt = opts[this._monCursor];
      if (opt && opt.available) {
        pool.settings.setMonetization(poolId, opt.id, !opt.enabled);
        this._monOptions = pool.settings.getMonetizationOptions(poolId);
        this._renderMonetization();
      }
      return;
    }

    // e: open config editor for highlighted row
    if (key === 'e') {
      const opt = opts[this._monCursor];
      if (opt) this._editMonConfig(poolId, opt);
      return;
    }

    // x: switch active pool
    if (key === 'x') { this._cycleActivePool(); return; }

    // s / Escape: back to status
    if (key === 's' || key === '\x1b') {
      this.mode = 'status';
      this._renderStatus();
    }
  },

  _renderMonetization() {
    const pool   = this.registry.get('pool');
    const opts   = this._monOptions;
    const poolId = this._monPoolId;
    const active = pool?.settings?.getActivePool();
    const allPools = pool?.settings?.listPools() ?? [];

    process.stdout.write(CLEAR);
    const lines = [
      c(GOLD, BOLD + 'Monetization')  + '  ' + c(DIM, `pool: ${c(CYAN, poolId ?? '—')}`),
      hr(),
    ];

    // Pool switcher row
    if (allPools.length > 1) {
      const poolRow = allPools.map(p =>
        p.id === poolId
          ? badge(` ${p.coin.toUpperCase()} `, CYAN + BOLD)
          : badge(` ${p.coin.toUpperCase()} `, DIM)
      ).join('  ');
      lines.push('  Pools: ' + poolRow + c(DIM, '  (x to cycle)'));
      lines.push(hr());
    }

    // Header row
    lines.push(
      c(DIM, '  #   Status  Avail  Type                      Description')
    );
    lines.push(hr());

    opts.forEach((opt, i) => {
      const meta      = MON_META[opt.id] || { icon: '  ', color: RESET, shortLabel: opt.id };
      const cursor    = i === this._monCursor ? c(CYAN, '▶') : ' ';
      const num       = c(DIM, `${i + 1}`);
      const status    = tag(opt.enabled);
      const avail     = opt.available ? c(GREEN, '  ✓  ') : c(RED, '  ✗  ');
      const typeLabel = c(meta.color, (meta.icon + ' ' + meta.shortLabel).padEnd(26));
      const desc      = c(DIM, opt.description.slice(0, 34) + (opt.description.length > 34 ? '…' : ''));

      lines.push(`  ${cursor} ${num}  ${status}  ${avail}  ${typeLabel}  ${desc}`);

      // Show active config inline if enabled
      if (opt.enabled && Object.keys(opt.config).length > 0) {
        const cfgStr = Object.entries(opt.config)
          .slice(0, 3)
          .map(([k, v]) => `${k}=${v}`)
          .join('  ');
        lines.push(c(DIM, `          ↳ ${cfgStr}`));
      }
    });

    lines.push(hr());

    // Selected type detail
    const sel = opts[this._monCursor];
    if (sel) {
      lines.push(c(BOLD, `  ${sel.id}`) + '  ' + c(DIM, sel.description));
      if (sel.available && sel.enabled) {
        lines.push(c(DIM, '  Config fields:'));
        Object.entries(sel.settings).slice(0, 5).forEach(([k, s]) => {
          const val = sel.config[k] ?? s.default ?? '—';
          lines.push(c(DIM, `    ${k.padEnd(20)} = `) + c(CYAN, String(val)));
        });
      } else if (!sel.available) {
        lines.push(c(RED, '  ✗ Not available for this coin'));
      }
      lines.push('');
    }

    lines.push(
      c(DIM, '  1–8 toggle  ↑↓ cursor  Enter/Space toggle  e) edit config  x) switch pool  s/Esc) back')
    );

    process.stdout.write(lines.join('\n') + '\n');
  },

  // Edit config for a monetization type — readline prompt for each field
  async _editMonConfig(poolId, opt) {
    if (!opt.available) { this._alert(c(RED, 'not available for this coin')); return; }
    this.mode = 'mon-config';
    if (process.stdin.isTTY) process.stdin.setRawMode(false);

    process.stdout.write(CLEAR);
    process.stdout.write([
      c(GOLD, BOLD + `Configure: ${opt.id}`),
      hr(),
      c(DIM, 'Enter value for each field. Press Enter to keep current value.'),
      ''
    ].join('\n') + '\n');

    const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(r => rl.question(q, r));
    const newConfig = { ...(opt.config || {}) };

    for (const [key, schema] of Object.entries(opt.settings)) {
      const current = newConfig[key] ?? schema.default ?? '';
      const optStr  = schema.options ? ` (${schema.options.join('|')})` : '';
      const prompt  = `  ${c(CYAN, key)}${c(DIM, optStr)} ${c(DIM, `[${current}]`)}: `;
      const answer  = await ask(prompt);
      if (answer.trim() !== '') {
        // Coerce type
        if (schema.type === 'number')  newConfig[key] = parseFloat(answer);
        else if (schema.type === 'boolean') newConfig[key] = answer.trim().toLowerCase() === 'true';
        else newConfig[key] = answer.trim();
      } else {
        newConfig[key] = current;
      }
    }

    rl.close();

    const pool = this.registry.get('pool');
    pool.settings.setMonetization(poolId, opt.id, opt.enabled, newConfig);
    this._monOptions = pool.settings.getMonetizationOptions(poolId);

    this._alert(c(GREEN, `✓ Config saved for ${opt.id}`));
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    this.mode = 'monetization';
    this._renderMonetization();
  },

  // ── Pool switcher ────────────────────────────────────────────────────────

  _cycleActivePool() {
    const pool  = this.registry.get('pool');
    if (!pool?.settings) { this._alert(c(RED, 'no pool settings')); return; }
    const pools  = pool.settings.listPools();
    if (pools.length < 2) { this._alert(c(DIM, 'only one pool configured')); return; }
    const active = pool.settings.getActivePool();
    const idx    = pools.findIndex(p => p.id === active?.id);
    const next   = pools[(idx + 1) % pools.length];
    pool.settings.setActivePool(next.id);
    if (this.mode === 'monetization') {
      this._monPoolId  = next.id;
      this._monOptions = pool.settings.getMonetizationOptions(next.id);
      this._renderMonetization();
    }
  },

  // ── Status ───────────────────────────────────────────────────────────────

  _renderStatus() {
    const pool    = this.registry.get('pool');
    const nodemod = this.registry.get('node');
    const miners  = pool ? [...pool.miners.values()] : [];
    const nodes   = nodemod ? [...nodemod.nodes.values()] : [];
    const job     = pool?.jobEngine?.currentJob;
    const active  = pool?.settings?.getActivePool();

    // Summarise active monetization for status bar
    const monSummary = active
      ? Object.entries(active.monetization || {})
          .filter(([, v]) => v.enabled)
          .map(([k]) => (MON_META[k]?.icon ?? k).trim())
          .join(' ')
      : '';

    process.stdout.write(CLEAR);
    process.stdout.write([
      c(GOLD, BOLD + 'MagoFonte') + c(DIM, '  home mining server'),
      hr(),

      c(BOLD, 'NODES'),
      nodes.length === 0
        ? c(DIM, '  none running  (press n to launch)')
        : nodes.map(n => [
            `  ${c(CYAN, n.coin.id.toUpperCase())}`,
            c(n.status === 'ready' ? GREEN : n.status === 'error' ? RED : GOLD, n.status),
            n.syncHeight ? `height=${n.syncHeight}` : '',
            n.process?.pid ? c(DIM, `pid=${n.process.pid}`) : ''
          ].filter(Boolean).join('  ')).join('\n'),

      '',
      c(BOLD, 'POOL') + (monSummary ? '  ' + c(DIM, monSummary) : ''),
      job
        ? `  ${c(CYAN, (active?.coin ?? '?').toUpperCase())} ${(active?.algo ?? '').toUpperCase()}` +
          `  height=${job.height}  miners=${miners.length}` +
          `  ${_fmt(miners.reduce((s, m) => s + m.hashrate, 0))}` +
          `  blocks=${pool.payout?.getStats().blocksFound ?? 0}`
        : c(DIM, '  waiting for node…'),

      miners.length ? '\n' + c(BOLD, 'MINERS') : '',
      ...miners.map(m =>
        `  ${c(CYAN, (m.user ?? m.id.slice(0, 8)).padEnd(20))}` +
        `  diff=${m.difficulty.toFixed(4)}` +
        `  ✓${m.accepted}  ✗${m.rejected}` +
        `  ${_fmt(m.hashrate)}`
      ),

      '',
      hr(),
      c(DIM, 's)tatus  p)ool  m)onetize  n)ode  c)oin  l)ogs  r)job  x)pool  q)uit  ?)help')
    ].join('\n') + '\n');
  },

  // ── Pool stats ───────────────────────────────────────────────────────────

  _renderPool() {
    const pool = this.registry.get('pool');
    if (!pool) { process.stdout.write(c(RED, 'pool module not running\n')); return; }
    const stats  = pool.payout?.getStats() ?? {};
    const active = pool.settings?.getActivePool();
    process.stdout.write(CLEAR);
    process.stdout.write([
      c(GOLD, BOLD + 'Pool Stats'),
      hr(),
      `  pool:         ${active?.id ?? '—'}`,
      `  coin:         ${active?.coin ?? '—'}`,
      `  algo:         ${active?.algo ?? '—'}`,
      `  mode:         party`,
      `  miners:       ${pool.miners.size}`,
      `  window shares: ${stats.windowShares ?? 0}`,
      `  blocks found: ${stats.blocksFound ?? 0}`,
      '',
      c(BOLD, 'Earnings (pending):'),
      ...Object.entries(stats.earnings ?? {}).map(([u, e]) => `  ${c(CYAN, u)}: ${e.toFixed(0)} sat`),
      stats.earnings && Object.keys(stats.earnings).length === 0 ? c(DIM, '  none yet') : '',
      '',
      c(BOLD, 'Recent blocks:'),
      ...(stats.recentBlocks ?? []).map(b =>
        `  height=${b.height}  reward=${b.reward} sat  ${new Date(b.ts).toLocaleTimeString()}`
      ),
      (stats.recentBlocks ?? []).length === 0 ? c(DIM, '  none yet') : '',
      '',
      hr(),
      c(DIM, 'Press m) for monetization  s) to return')
    ].join('\n') + '\n');
  },

  // ── Node menu ────────────────────────────────────────────────────────────

  _renderNodeMenu() {
    const nodemod = this.registry.get('node');
    process.stdout.write(CLEAR);
    process.stdout.write([
      c(GOLD, BOLD + 'Node Manager'),
      hr(),
      c(BOLD, 'Running nodes:'),
      ...(nodemod ? [...nodemod.nodes.values()].map(n =>
        `  ${c(CYAN, n.coin.id)}  ${c(n.status === 'ready' ? GREEN : GOLD, n.status)}  pid=${n.process?.pid ?? '-'}`
      ) : [c(DIM, '  none')]),
      '',
      c(BOLD, 'Available coin definitions:'),
      ...this._availableCoins().map(f => `  ${c(CYAN, f.replace('.json', ''))}`),
      '',
      c(DIM, 'POST /api/v1/node/start { coin, rpcuser, rpcpass }'),
      c(DIM, 'Or press c to paste a new coin definition'),
      '',
      hr(),
      c(DIM, 'Press s to return')
    ].join('\n') + '\n');
  },

  _availableCoins() {
    try {
      const dir = new URL('../coins', import.meta.url).pathname;
      return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch { return []; }
  },

  // ── Coin launch ──────────────────────────────────────────────────────────

  _enterCoinInput() {
    this.mode = 'coin-input';
    this.coinInput = '';
    process.stdout.write(CLEAR);
    process.stdout.write([
      c(GOLD, BOLD + 'Launch New Coin'),
      hr(),
      c(DIM, 'Paste a coin definition JSON below.'),
      c(DIM, 'Press Enter twice when done. Ctrl+C to cancel.'),
      ''
    ].join('\n') + '\n');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    this._rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this._rl.on('line', line => {
      if (line === '' && this.coinInput.trim()) {
        this._rl.close(); this._rl = null;
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        this.mode = 'status';
        this._launchFromInput(this.coinInput.trim());
      } else {
        this.coinInput += line + '\n';
      }
    });
    this._rl.on('close', () => {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      this.mode = 'status';
    });
  },

  async _launchFromInput(json) {
    process.stdout.write(c(CYAN, 'Validating coin definition…\n'));
    try {
      const nodemod = this.registry.get('node');
      if (!nodemod) throw new Error('node module not running');
      const rl      = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask     = q => new Promise(r => rl.question(q, r));
      const rpcuser = await ask(c(GOLD, 'RPC username: '));
      const rpcpass = await ask(c(GOLD, 'RPC password: '));
      rl.close();
      process.stdout.write(c(CYAN, 'Writing config and launching node…\n'));
      await nodemod.registerFromJson(json, rpcuser, rpcpass);
      process.stdout.write(c(GREEN, '✓ Node launched. Pool starts when node:ready fires.\n'));
    } catch (err) {
      process.stdout.write(c(RED, `Error: ${err.message}\n`));
    }
    setTimeout(() => { this.mode = 'status'; this._renderStatus(); }, 2000);
  },

  // ── Logs ─────────────────────────────────────────────────────────────────

  _renderLogs() {
    process.stdout.write(CLEAR);
    process.stdout.write(c(GOLD, BOLD + 'Node Logs') + '\n' + hr() + '\n');
    process.stdout.write(this.logBuffer.slice(-40).join('\n') + '\n');
    process.stdout.write('\n' + hr() + '\n' + c(DIM, 'Live — press s to return') + '\n');
  },

  // ── Help ─────────────────────────────────────────────────────────────────

  _renderHelp() {
    process.stdout.write(CLEAR);
    process.stdout.write([
      c(GOLD, BOLD + 'MagoFonte — Help'),
      hr(),
      c(BOLD, 'Navigation:'),
      `  ${c(CYAN,'s')}  Status overview`,
      `  ${c(CYAN,'p')}  Pool stats + earnings`,
      `  ${c(CYAN,'m')}  ${c(BOLD,'Monetization panel')} — toggle revenue streams`,
      `  ${c(CYAN,'n')}  Node manager`,
      `  ${c(CYAN,'c')}  Launch coin (paste JSON)`,
      `  ${c(CYAN,'l')}  Live node logs`,
      `  ${c(CYAN,'r')}  Force new pool job broadcast`,
      `  ${c(CYAN,'x')}  Cycle active pool`,
      `  ${c(CYAN,'q')}  Quit`,
      '',
      c(BOLD, 'Monetization panel (m):'),
      `  ${c(CYAN,'1–8')}      Toggle type on/off`,
      `  ${c(CYAN,'↑ ↓')}      Move cursor`,
      `  ${c(CYAN,'Enter')}    Toggle highlighted type`,
      `  ${c(CYAN,'e')}        Edit config for highlighted type`,
      `  ${c(CYAN,'x')}        Cycle to next pool`,
      `  ${c(CYAN,'s/Esc')}    Back to status`,
      '',
      c(BOLD, 'REST API:'),
      c(DIM,  '  GET  /api/v1/pool/status'),
      c(DIM,  '  GET  /api/v1/pool/settings/pools'),
      c(DIM,  '  GET  /api/v1/pool/settings/pools/:id/monetization'),
      c(DIM,  '  POST /api/v1/pool/settings/pools/:id/monetization/:type'),
      c(DIM,  '  POST /api/v1/pool/settings/active   { poolId }'),
      c(DIM,  '  POST /api/v1/node/start             { coin, rpcuser, rpcpass }'),
      '',
      hr(),
      c(DIM, 'Press any key to return')
    ].join('\n') + '\n');
  },

  // ── Utilities ────────────────────────────────────────────────────────────

  _forceNewJob() {
    const pool = this.registry.get('pool');
    if (pool?.jobEngine) {
      pool.jobEngine.forceNewJob();
      this._alert(c(GREEN, '✓ New job broadcast'));
    } else {
      this._alert(c(RED, 'pool job engine not running'));
    }
  },

  _alert(msg) {
    // Print a non-destructive inline alert line
    // (only when not in a full-screen mode that re-renders itself)
    if (!['logs','monetization'].includes(this.mode)) {
      process.stdout.write(`${msg}\n`);
    }
  }
};

function _fmt(hps) {
  if (hps > 1e9) return (hps/1e9).toFixed(2) + ' GH/s';
  if (hps > 1e6) return (hps/1e6).toFixed(2) + ' MH/s';
  if (hps > 1e3) return (hps/1e3).toFixed(2) + ' KH/s';
  return hps.toFixed(0) + ' H/s';
}

export default Console;
