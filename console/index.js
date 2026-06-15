/**
 * MagoFonte — console module
 *
 * Terminal control plane. Renders live status and handles
 * keyboard input to start/stop modules, launch coins, view logs.
 *
 * Uses raw readline for zero-dependency terminal UI.
 * Connects to core via the registry event bus (same process).
 *
 * Keyboard controls:
 *   q         — quit
 *   s         — status (all modules)
 *   n         — node menu (start/stop coin node)
 *   p         — pool status
 *   c         — coin panel (paste JSON → launch)
 *   l         — tail logs for active coin node
 *   r         — force new pool job
 *   h / ?     — help
 */

import readline from 'node:readline';

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const GOLD   = '\x1b[33m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const CLEAR  = '\x1b[2J\x1b[H';

function c(color, str) { return `${color}${str}${RESET}`; }
function hr(len = 60)  { return c(DIM, '─'.repeat(len)); }

const Console = {
  name: 'console',

  async init(config, registry) {
    this.config    = config;
    this.registry  = registry;
    this.mode      = 'status';   // status | logs | coin-input
    this.coinInput = '';         // buffer for coin JSON paste
    this.logBuffer = [];         // rolling log lines
    this._statusTimer = null;

    // Collect all log lines from the node module
    registry.on('node:log', ({ coin, line }) => {
      this.logBuffer.push(`${c(DIM, coin)} ${line}`);
      if (this.logBuffer.length > 500) this.logBuffer.shift();
      if (this.mode === 'logs') this._renderLogs();
    });

    // Key lifecycle events — print inline alerts
    registry.on('block:found', ({ user, height }) => {
      process.stdout.write(`\n${c(GOLD, BOLD + '🎉 BLOCK FOUND')} height=${height} miner=${user}\n`);
    });
    registry.on('node:ready', ({ coin }) => {
      process.stdout.write(`\n${c(GREEN, `✅ node:${coin} ready`)}\n`);
    });
    registry.on('node:stopped', ({ coin }) => {
      process.stdout.write(`\n${c(RED, `■ node:${coin} stopped`)}\n`);
    });

    this._startInput();
    this._renderStatus();
    this._statusTimer = setInterval(() => {
      if (this.mode === 'status') this._renderStatus();
    }, 5000);

    return this;
  },

  _startInput() {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', key => this._onKey(key));
  },

  _onKey(key) {
    // Ctrl+C / q to quit
    if (key === '\x03' || (key === 'q' && this.mode !== 'coin-input')) {
      process.stdout.write('\nShutting down...\n');
      process.exit(0);
    }

    if (this.mode === 'coin-input') {
      this._handleCoinInput(key);
      return;
    }

    switch (key) {
      case 's': this.mode = 'status';  this._renderStatus(); break;
      case 'p': this._renderPool();    break;
      case 'l': this.mode = 'logs';    this._renderLogs();   break;
      case 'c': this._enterCoinInput();  break;
      case 'r': this._forceNewJob();   break;
      case 'n': this._renderNodeMenu();  break;
      case 'h': case '?': this._renderHelp(); break;
    }
  },

  _renderStatus() {
    const pool    = this.registry.get('pool');
    const nodemod = this.registry.get('node');
    const miners  = pool ? [...pool.miners.values()] : [];
    const nodes   = nodemod ? [...nodemod.nodes.values()] : [];
    const job     = pool?.jobEngine?.currentJob;

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
          ].filter(Boolean).join('  ')
          ).join('\n'),

      '',
      c(BOLD, 'POOL'),
      job
        ? `  ${c(CYAN, pool.config.coin)} ${pool.config.algo?.toUpperCase()}  height=${job.height}  miners=${miners.length}  hashrate=${_fmt(miners.reduce((s,m) => s+m.hashrate,0))}  blocks=${pool.payout?.getStats().blocksFound ?? 0}`
        : c(DIM, '  waiting for node...'),

      miners.length ? '\n' + c(BOLD, 'MINERS') : '',
      ...miners.map(m =>
        `  ${c(CYAN, m.user ?? m.id.slice(0,8))}  diff=${m.difficulty.toFixed(4)}  ✓${m.accepted}  ✗${m.rejected}  ${_fmt(m.hashrate)}`
      ),

      '',
      hr(),
      c(DIM, 's)tatus  p)ool  n)ode  c)oin-launch  l)ogs  r)efresh-job  q)uit  ?)help')
    ].join('\n') + '\n');
  },

  _renderPool() {
    const pool = this.registry.get('pool');
    if (!pool) { process.stdout.write(c(RED, 'pool module not running\n')); return; }
    const stats = pool.payout.getStats();
    process.stdout.write(CLEAR);
    process.stdout.write([
      c(GOLD, BOLD + 'Pool Stats'),
      hr(),
      `  coin:         ${pool.config.coin}`,
      `  algo:         ${pool.config.algo}`,
      `  mode:         ${pool.config.mode}`,
      `  miners:       ${pool.miners.size}`,
      `  window shares: ${stats.windowShares}`,
      `  blocks found: ${stats.blocksFound}`,
      '',
      c(BOLD, 'Earnings (pending):'),
      ...Object.entries(stats.earnings).map(([u, e]) => `  ${u}: ${e.toFixed(0)} sat`),
      '',
      c(BOLD, 'Recent blocks:'),
      ...stats.recentBlocks.map(b =>
        `  height=${b.height}  reward=${b.reward}sat  ${new Date(b.ts).toLocaleTimeString()}`
      ),
      '',
      hr(),
      c(DIM, 'Press s to return to status')
    ].join('\n') + '\n');
  },

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
      c(BOLD, 'Available coins:'),
      ...this._availableCoins().map(f => `  ${c(CYAN, f.replace('.json',''))}`),
      '',
      c(DIM, 'Use the REST API to start/stop: POST /api/v1/node/start { coin, rpcuser, rpcpass }'),
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
    // Use readline for multi-line paste
    this._rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this._rl.on('line', line => {
      if (line === '' && this.coinInput.trim()) {
        this._rl.close();
        this._rl = null;
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
    process.stdout.write(c(CYAN, 'Validating coin definition...\n'));
    try {
      const nodemod = this.registry.get('node');
      if (!nodemod) throw new Error('node module not running');
      // Prompt for RPC credentials
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask = q => new Promise(r => rl.question(q, r));
      const rpcuser = await ask(c(GOLD, 'RPC username: '));
      const rpcpass = await ask(c(GOLD, 'RPC password: '));
      rl.close();
      process.stdout.write(c(CYAN, 'Writing config and launching node...\n'));
      await nodemod.registerFromJson(json, rpcuser, rpcpass);
      process.stdout.write(c(GREEN, '✓ Node launched. Pool will start when node:ready fires.\n'));
    } catch(err) {
      process.stdout.write(c(RED, `Error: ${err.message}\n`));
    }
    setTimeout(() => this._renderStatus(), 2000);
  },

  _renderLogs() {
    process.stdout.write(CLEAR);
    process.stdout.write(c(GOLD, BOLD + 'Node Logs') + '\n' + hr() + '\n');
    const lines = this.logBuffer.slice(-40);
    process.stdout.write(lines.join('\n') + '\n');
    process.stdout.write(hr() + '\n' + c(DIM, 'Press s to return') + '\n');
  },

  _renderHelp() {
    process.stdout.write(CLEAR);
    process.stdout.write([
      c(GOLD, BOLD + 'MagoFonte Help'),
      hr(),
      `  ${c(CYAN,'s')}  Status overview`,
      `  ${c(CYAN,'p')}  Pool stats + earnings`,
      `  ${c(CYAN,'n')}  Node manager`,
      `  ${c(CYAN,'c')}  Launch coin (paste JSON definition)`,
      `  ${c(CYAN,'l')}  Live node logs`,
      `  ${c(CYAN,'r')}  Force new pool job broadcast`,
      `  ${c(CYAN,'q')}  Quit`,
      '',
      c(BOLD, 'REST API:'),
      '  GET  /health',
      '  GET  /api/v1/pool/status',
      '  GET  /api/v1/pool/miners',
      '  GET  /api/v1/pool/payout',
      '  GET  /api/v1/node/status',
      '  POST /api/v1/node/start    { coin, rpcuser, rpcpass }',
      '  POST /api/v1/node/register { coinJson, rpcuser, rpcpass }',
      '',
      hr(),
      c(DIM, 'Press any key to return')
    ].join('\n') + '\n');
  },

  _forceNewJob() {
    const pool = this.registry.get('pool');
    if (pool?.jobEngine) {
      pool.jobEngine.forceNewJob();
      process.stdout.write(c(GREEN, '✓ New job broadcast\n'));
    }
  },

  _renderLogs() {
    process.stdout.write(CLEAR);
    process.stdout.write(c(GOLD, BOLD + 'Node Logs') + '\n' + hr() + '\n');
    process.stdout.write(this.logBuffer.slice(-40).join('\n') + '\n');
    process.stdout.write(hr() + '\n' + c(DIM, 'Press s to return') + '\n');
  }
};

function _fmt(hps) {
  if (hps > 1e9)  return (hps/1e9).toFixed(2)  + ' GH/s';
  if (hps > 1e6)  return (hps/1e6).toFixed(2)  + ' MH/s';
  if (hps > 1e3)  return (hps/1e3).toFixed(2)  + ' KH/s';
  return hps.toFixed(0) + ' H/s';
}

import fs from 'node:fs';
export default Console;
