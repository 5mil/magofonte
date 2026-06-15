/**
 * MagoFonte — pool module (DGB party mine)
 *
 * Full internal pool — no upstream relay.
 * Talks directly to a DigiByte full node via RPC.
 *
 * Flow:
 *   DGB node ──getblocktemplate──▶ JobEngine
 *   JobEngine ──mining.notify──▶ MinerSessions
 *   MinerSession ──mining.submit──▶ ShareValidator
 *   ShareValidator ──submitblock──▶ DGB node
 *   ShareValidator ──share event──▶ PayoutTracker
 *
 * Exports standard module shape: { name, init(config, registry) }
 */

import net from 'node:net';
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';

// ─── Utilities ───────────────────────────────────────────────────────────────

function hexToLE32(hex) {
  // Reverse 4-byte groups for little-endian encoding
  return hex.match(/.{8}/g).map(b =>
    b.match(/.{2}/g).reverse().join('')
  ).join('');
}

function dblSha256(buf) {
  const h1 = crypto.createHash('sha256').update(buf).digest();
  return crypto.createHash('sha256').update(h1).digest();
}

function buildMerkleRoot(txids) {
  if (!txids.length) return '00'.repeat(32);
  let layer = txids.map(t => Buffer.from(t, 'hex').reverse());
  while (layer.length > 1) {
    if (layer.length % 2 !== 0) layer.push(layer[layer.length - 1]);
    const next = [];
    for (let i = 0; i < layer.length; i += 2)
      next.push(dblSha256(Buffer.concat([layer[i], layer[i+1]])));
    layer = next;
  }
  return layer[0].reverse().toString('hex');
}

function pad(n, len) { return n.toString(16).padStart(len, '0'); }

// ─── DGB Node RPC ─────────────────────────────────────────────────────────────

class NodeRPC {
  constructor({ host, port, rpcuser, rpcpass }) {
    this.host = host;
    this.port = port;
    this.auth = Buffer.from(`${rpcuser}:${rpcpass}`).toString('base64');
    this._id  = 1;
  }

  call(method, params = []) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '1.0', id: this._id++, method, params });
      const req  = http.request({
        host:    this.host,
        port:    this.port,
        method:  'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization':  `Basic ${this.auth}`
        }
      }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) reject(new Error(JSON.stringify(parsed.error)));
            else resolve(parsed.result);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(10_000, () => { req.destroy(); reject(new Error('RPC timeout')); });
      req.write(body);
      req.end();
    });
  }

  getBlockTemplate()  { return this.call('getblocktemplate', [{ rules: ['segwit'] }]); }
  submitBlock(hex)    { return this.call('submitblock', [hex]); }
  getBlockCount()     { return this.call('getblockcount'); }
  getNetworkInfo()    { return this.call('getnetworkinfo'); }
  getMiningInfo()     { return this.call('getmininginfo'); }
}

// ─── Job Engine ───────────────────────────────────────────────────────────────
// Turns a getblocktemplate response into a stratum mining.notify job.

class JobEngine extends EventEmitter {
  constructor(rpc, config) {
    super();
    this.rpc        = rpc;
    this.config     = config;
    this.currentJob = null;
    this.jobs       = {};   // jobId → full job data for share validation
    this._prevHash  = null;
    this._pollTimer = null;
  }

  start() {
    this._poll();
    this._pollTimer = setInterval(() => this._poll(), this.config.blockPollMs || 500);
    console.log('[pool:jobs] polling for new blocks every', this.config.blockPollMs || 500, 'ms');
  }

  stop() { clearInterval(this._pollTimer); }

  async _poll() {
    try {
      const tpl = await this.rpc.getBlockTemplate();
      if (tpl.previousblockhash !== this._prevHash) {
        this._prevHash = tpl.previousblockhash;
        this._buildJob(tpl, true);
      }
    } catch (err) {
      // Node not ready yet — silent retry
    }
  }

  _buildJob(tpl, cleanJobs = false) {
    const jobId = crypto.randomBytes(4).toString('hex');

    // Coinbase transaction
    const extraNoncePlaceholder = 'f000000ff111111f'; // 8 bytes: 4 extranonce1 + 4 extranonce2
    const coinbaseValue = tpl.coinbasevalue;
    const heightHex     = pad(tpl.height, 8);
    const addrScript    = this._addressToScript(this.config.blockRewardAddress);

    // coinbase1: version + vin count + vin (coinbase input up to extranonce)
    const coinbase1 = [
      '01000000',                          // version
      '01',                                // input count
      '00'.repeat(32), 'ffffffff',         // prev txid (null) + vout index
      '08',                                // script length placeholder
      '03', heightHex.slice(0,6),          // block height push (BIP34)
      '00'                                 // extra
    ].join('');

    // coinbase2: extranonce placeholder end + output + locktime
    const valueHex   = pad(coinbaseValue, 16);  // 8 bytes LE
    const valueLE    = valueHex.match(/.{2}/g).reverse().join('');
    const coinbase2  = [
      'ffffffff',                          // sequence
      '01',                                // output count
      valueLE,                             // value
      pad(addrScript.length / 2, 2),       // script length
      addrScript,                          // payout script
      '00000000'                           // locktime
    ].join('');

    // Merkle branches from template transactions
    const txids = (tpl.transactions || []).map(tx => tx.txid || tx.hash);
    const merkleBranches = this._getMerkleBranches(txids);

    const job = {
      jobId,
      prevHash:        hexToLE32(tpl.previousblockhash),
      coinbase1,
      coinbase2,
      merkleBranches,
      version:         pad(tpl.version, 8),
      nbits:           tpl.bits,
      ntime:           pad(Math.floor(Date.now() / 1000), 8),
      cleanJobs,
      target:          tpl.target,
      height:          tpl.height,
      template:        tpl,
      coinbaseValue
    };

    this.jobs[jobId]  = job;
    this.currentJob   = job;

    // Prune old jobs (keep last 8)
    const keys = Object.keys(this.jobs);
    if (keys.length > 8) delete this.jobs[keys[0]];

    console.log(`[pool:jobs] new job ${jobId} height=${tpl.height} clean=${cleanJobs}`);
    this.emit('job', job);
    return job;
  }

  _getMerkleBranches(txids) {
    // Returns the branch hashes needed to compute merkle root from coinbase
    if (!txids.length) return [];
    const branches = [];
    let layer = txids.map(t => Buffer.from(t, 'hex').reverse());
    while (layer.length > 0) {
      branches.push(layer[0].reverse().toString('hex'));
      if (layer.length === 1) break;
      if (layer.length % 2 !== 0) layer.push(layer[layer.length - 1]);
      const next = [];
      for (let i = 0; i < layer.length; i += 2)
        next.push(dblSha256(Buffer.concat([layer[i], layer[i+1]])));
      layer = next;
    }
    return branches;
  }

  _addressToScript(addr) {
    // P2PKH placeholder — real impl needs base58check decode
    // Returns OP_DUP OP_HASH160 <20-byte hash> OP_EQUALVERIFY OP_CHECKSIG
    // For now returns a known-length placeholder so coinbase is valid structure
    // TODO: replace with proper base58check → pubkeyhash decode
    return '76a914' + '00'.repeat(20) + '88ac';
  }

  forceNewJob() {
    if (this.currentJob) {
      this._buildJob(this.currentJob.template, false);
    }
  }
}

// ─── VarDiff ──────────────────────────────────────────────────────────────────

class VarDiff {
  constructor(config) {
    this.min      = config.minDiff      || 0.001;
    this.max      = config.maxDiff      || 1000;
    this.target   = config.targetTime   || 15;   // seconds per share
    this.retarget = config.retargetTime || 60;   // seconds between adjustments
    this.variance = config.variancePercent || 30;
  }

  // Returns new difficulty or null if no change needed
  check(session) {
    const now = Date.now() / 1000;
    if (!session._varDiffLastRetarget) {
      session._varDiffLastRetarget = now;
      session._varDiffShares = 0;
      return null;
    }
    const elapsed = now - session._varDiffLastRetarget;
    if (elapsed < this.retarget) return null;

    const sharesPerSec  = session._varDiffShares / elapsed;
    const actualTime    = sharesPerSec > 0 ? 1 / sharesPerSec : this.target * 2;
    const ratio         = actualTime / this.target;
    const low           = 1 - this.variance / 100;
    const high          = 1 + this.variance / 100;

    session._varDiffLastRetarget = now;
    session._varDiffShares = 0;

    if (ratio > high || ratio < low) {
      let newDiff = session.difficulty / ratio;
      newDiff = Math.max(this.min, Math.min(this.max, newDiff));
      if (Math.abs(newDiff - session.difficulty) / session.difficulty > 0.1) {
        return newDiff;
      }
    }
    return null;
  }
}

// ─── Share Validator ─────────────────────────────────────────────────────────

class ShareValidator {
  constructor(rpc) {
    this.rpc = rpc;
  }

  // Returns { valid, isBlock, error }
  async validate(session, job, extranonce2, ntime, nonce) {
    if (!job) return { valid: false, error: 'job not found' };

    // Check duplicate share
    const shareKey = `${job.jobId}:${extranonce2}:${ntime}:${nonce}`;
    if (session._shares && session._shares.has(shareKey))
      return { valid: false, error: 'duplicate share' };
    if (!session._shares) session._shares = new Set();
    session._shares.add(shareKey);
    // Prune share set
    if (session._shares.size > 500) session._shares.clear();

    // Build coinbase
    const coinbaseBuf = Buffer.from(
      job.coinbase1 + session.extranonce1 + extranonce2 + job.coinbase2, 'hex'
    );
    const coinbaseHash = dblSha256(coinbaseBuf);

    // Compute merkle root
    let merkle = coinbaseHash;
    for (const branch of job.merkleBranches) {
      const branchBuf = Buffer.from(branch, 'hex').reverse();
      merkle = dblSha256(Buffer.concat([merkle, branchBuf]));
    }
    const merkleRoot = merkle.reverse().toString('hex');

    // Build block header (80 bytes)
    const header = Buffer.from(
      hexToLE32(job.version) +
      job.prevHash +
      hexToLE32(merkleRoot) +
      hexToLE32(ntime) +
      hexToLE32(job.nbits) +
      hexToLE32(nonce),
    'hex');

    // Hash the header (SHA256d for Skein we use the stratum hash check)
    // Note: actual Skein hashing requires the skein algo — for share checking
    // we validate against the job difficulty target using the submitted hash
    const headerHash = dblSha256(header).reverse();
    const hashHex    = headerHash.toString('hex');

    // Check share meets session difficulty
    const shareDiffTarget = this._diffToTarget(session.difficulty);
    const meetsDiff       = BigInt('0x' + hashHex) <= BigInt('0x' + shareDiffTarget);

    if (!meetsDiff)
      return { valid: false, error: `share below difficulty (hash=${hashHex.slice(0,16)}...)` };

    // Check if meets network difficulty (block found!)
    const networkTarget = job.target.padStart(64, '0');
    const isBlock       = BigInt('0x' + hashHex) <= BigInt('0x' + networkTarget);

    let blockHex = null;
    if (isBlock) {
      // Assemble full block for submission
      const txCount   = (job.template.transactions || []).length + 1;
      const txCountHex = pad(txCount, 2);
      const txData     = (job.template.transactions || []).map(tx => tx.data).join('');
      blockHex = header.toString('hex') + txCountHex +
                 coinbaseBuf.toString('hex') + txData;
      try {
        const result = await this.rpc.submitBlock(blockHex);
        console.log(`[pool:BLOCK] 🎉 DGB block found at height ${job.height}! submit result: ${result ?? 'null (accepted)'}`);
      } catch (err) {
        console.error('[pool:BLOCK] submitblock failed:', err.message);
      }
    }

    return { valid: true, isBlock, hashHex };
  }

  _diffToTarget(diff) {
    // Bitcoin-style diff1 target / difficulty
    const diff1 = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');
    const target = diff1 / BigInt(Math.round(diff * 1000)) * 1000n;
    return target.toString(16).padStart(64, '0');
  }
}

// ─── Payout Tracker (PPLNS) ──────────────────────────────────────────────────

class PayoutTracker {
  constructor(windowSize = 100) {
    this.window      = windowSize;   // last N shares
    this.shares      = [];           // { user, diff, ts }
    this.blocks      = [];           // { height, reward, ts, shares: copy }
    this.earnings    = {};           // user → total pending DGB (satoshis)
  }

  addShare(user, diff) {
    this.shares.push({ user, diff, ts: Date.now() });
    if (this.shares.length > this.window) this.shares.shift();
  }

  recordBlock(height, reward) {
    // Snapshot current window and calculate PPLNS shares
    const snapshot = [...this.shares];
    const totalDiff = snapshot.reduce((s, sh) => s + sh.diff, 0);
    const perShare  = totalDiff > 0 ? reward / totalDiff : 0;

    const credited = {};
    for (const sh of snapshot) {
      credited[sh.user] = (credited[sh.user] || 0) + sh.diff * perShare;
      this.earnings[sh.user] = (this.earnings[sh.user] || 0) + sh.diff * perShare;
    }

    this.blocks.push({ height, reward, ts: Date.now(), credited });
    console.log('[pool:payout] block', height, 'reward', reward, 'sat, credited:', credited);
    return credited;
  }

  getStats() {
    const userShares = {};
    for (const s of this.shares) userShares[s.user] = (userShares[s.user] || 0) + 1;
    return {
      windowShares:  this.shares.length,
      userShares,
      earnings:      this.earnings,
      blocksFound:   this.blocks.length,
      recentBlocks:  this.blocks.slice(-10)
    };
  }
}

// ─── Miner Session ───────────────────────────────────────────────────────────

class MinerSession {
  constructor(socket, pool) {
    this.id          = crypto.randomUUID();
    this.socket      = socket;
    this.pool        = pool;
    this.buf         = '';
    this.authorized  = false;
    this.user        = null;
    this.difficulty  = pool.config.defaultDifficulty || 0.01;
    this.shares      = 0;
    this.accepted    = 0;
    this.rejected    = 0;
    this.hashrate    = 0;
    this.connectedAt = Date.now();
    this.extranonce1 = crypto.randomBytes(4).toString('hex');  // unique per miner
    this._shareTimes = [];
    this._shares     = new Set();
    this._attach();
  }

  _attach() {
    this.socket.setEncoding('utf8');
    this.socket.on('data',  d   => this._onData(d));
    this.socket.on('error', ()  => this._cleanup());
    this.socket.on('close', ()  => this._cleanup());
  }

  _cleanup() {
    this.pool.removeMiner(this.id);
  }

  send(obj) {
    try { this.socket.write(JSON.stringify(obj) + '\n'); } catch {}
  }

  sendDifficulty(diff) {
    this.difficulty = diff;
    this.send({ id: null, method: 'mining.set_difficulty', params: [diff] });
  }

  sendJob(job, clean = true) {
    this.send({
      id: null,
      method: 'mining.notify',
      params: [
        job.jobId,
        job.prevHash,
        job.coinbase1,
        job.coinbase2,
        job.merkleBranches,
        job.version,
        job.nbits,
        job.ntime,
        clean
      ]
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { this._onMessage(JSON.parse(line)); } catch {}
    }
  }

  _onMessage(msg) {
    switch (msg.method) {
      case 'mining.subscribe':  this._onSubscribe(msg);  break;
      case 'mining.authorize':  this._onAuthorize(msg);  break;
      case 'mining.submit':     this._onSubmit(msg);     break;
      case 'mining.extranonce.subscribe': this._onExtranonceSubscribe(msg); break;
    }
  }

  _onSubscribe(msg) {
    this.send({
      id: msg.id,
      result: [
        [['mining.set_difficulty', this.id], ['mining.notify', this.id]],
        this.extranonce1,
        4   // extranonce2 size
      ],
      error: null
    });
    this.sendDifficulty(this.difficulty);
    // Send current job immediately
    const job = this.pool.jobEngine.currentJob;
    if (job) this.sendJob(job, true);
  }

  _onAuthorize(msg) {
    const [user] = msg.params || [];
    this.user = user || 'anonymous';
    this.authorized = true;
    this.send({ id: msg.id, result: true, error: null });
    console.log(`[pool:miner] ✓ authorized: ${this.user} (${this.socket.remoteAddress})`);
    this.pool.registry.emit('miner:authorized', { id: this.id, user: this.user });
  }

  _onExtranonceSubscribe(msg) {
    this.send({ id: msg.id, result: true, error: null });
  }

  async _onSubmit(msg) {
    if (!this.authorized) {
      this.send({ id: msg.id, result: false, error: [24, 'Unauthorized', null] });
      return;
    }

    const [user, jobId, extranonce2, ntime, nonce] = msg.params || [];
    const job = this.pool.jobEngine.jobs[jobId];

    const result = await this.pool.validator.validate(this, job, extranonce2, ntime, nonce);

    this.shares++;
    const now = Date.now();
    this._shareTimes.push(now);
    this._shareTimes = this._shareTimes.filter(t => now - t < 60_000);
    const diff = this.pool.config.defaultDifficulty;
    this.hashrate = this._shareTimes.length * diff * 4_294_967_296 / 60;

    if (result.valid) {
      this.accepted++;
      this.pool.payout.addShare(this.user, this.difficulty);
      this.send({ id: msg.id, result: true, error: null });
      this.pool.registry.emit('share:accepted', {
        minerId: this.id, user: this.user, jobId,
        isBlock: result.isBlock, hashrate: this.hashrate
      });
      if (result.isBlock) {
        this.pool.registry.emit('block:found', {
          user: this.user, height: job.height, reward: job.coinbaseValue
        });
        this.pool.payout.recordBlock(job.height, job.coinbaseValue);
        // Force new job immediately after block
        this.pool.jobEngine.forceNewJob();
      }
      console.log(`[pool:share] ✓ ${this.user} ${result.isBlock ? '🎉 BLOCK!' : ''}`);
    } else {
      this.rejected++;
      this.send({ id: msg.id, result: false, error: [20, result.error, null] });
      console.log(`[pool:share] ✗ ${this.user}: ${result.error}`);
    }

    // VarDiff check
    if (this.pool.varDiff) {
      this._varDiffShares = (this._varDiffShares || 0) + 1;
      const newDiff = this.pool.varDiff.check(this);
      if (newDiff !== null) {
        console.log(`[pool:vardiff] ${this.user}: ${this.difficulty.toFixed(4)} → ${newDiff.toFixed(4)}`);
        this.sendDifficulty(newDiff);
      }
    }
  }
}

// ─── Pool module ─────────────────────────────────────────────────────────────

const Pool = {
  name: 'pool',

  async init(config, registry) {
    this.config    = config;
    this.registry  = registry;
    this.miners    = new Map();

    // Sub-systems
    this.rpc       = new NodeRPC(config.node);
    this.jobEngine = new JobEngine(this.rpc, config);
    this.validator = new ShareValidator(this.rpc);
    this.payout    = new PayoutTracker(config.pplnsWindow || 100);
    this.varDiff   = config.varDiff?.enabled ? new VarDiff(config.varDiff) : null;

    // Wire job events → all miners
    this.jobEngine.on('job', job => {
      let sent = 0;
      for (const miner of this.miners.values()) {
        if (miner.authorized) { miner.sendJob(job, job.cleanJobs); sent++; }
      }
      if (sent) console.log(`[pool:jobs] broadcast job ${job.jobId} to ${sent} miners`);
    });

    // Start polling for new blocks
    this.jobEngine.start();

    // Start stratum TCP server
    this.stratumServer = net.createServer(socket => {
      const session = new MinerSession(socket, this);
      this.miners.set(session.id, session);
      console.log(`[pool] ⛏  miner connected: ${socket.remoteAddress} (total: ${this.miners.size})`);
    });

    const port = config.stratumPort || 3333;
    this.stratumServer.listen(port, '0.0.0.0', () => {
      console.log(`[pool] stratum server on :${port} (DGB ${config.algo?.toUpperCase() || 'SKEIN'} party mine)`);
    });

    // Log node info on start
    this.rpc.getNetworkInfo()
      .then(info => console.log(`[pool] DGB node: v${info.subversion} peers=${info.connections}`))
      .catch(() => console.warn('[pool] DGB node not reachable yet — waiting...'));

    return this;
  },

  removeMiner(id) {
    const m = this.miners.get(id);
    if (m) {
      this.miners.delete(id);
      console.log(`[pool] miner left: ${m.user ?? id} (total: ${this.miners.size})`);
      this.registry.emit('miner:disconnected', { id, user: m.user });
    }
  },

  // ── REST routes (/api/v1/pool/*) ──────────────────────────────────────────
  get routes() {
    return [
      // Full status
      ['GET', '/status', (req, res) => {
        const miners = this._minerList();
        const payout = this.payout.getStats();
        const job    = this.jobEngine.currentJob;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          coin: this.config.coin,
          algo: this.config.algo,
          mode: this.config.mode,
          height:      job?.height ?? null,
          jobId:       job?.jobId  ?? null,
          miners:      miners.length,
          hashrate:    miners.reduce((s, m) => s + m.hashrate, 0),
          blocksFound: payout.blocksFound,
          windowShares: payout.windowShares,
          miners
        }));
      }],

      // Miners list
      ['GET', '/miners', (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this._minerList()));
      }],

      // Payout stats
      ['GET', '/payout', (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.payout.getStats()));
      }],

      // Current job
      ['GET', '/job', (req, res) => {
        const job = this.jobEngine.currentJob;
        res.writeHead(job ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(job ? {
          jobId: job.jobId, height: job.height,
          nbits: job.nbits, ntime: job.ntime, target: job.target
        } : { error: 'no job yet — node syncing?' }));
      }],

      // Node info passthrough
      ['GET', '/node', async (req, res) => {
        try {
          const [net, mine] = await Promise.all([
            this.rpc.getNetworkInfo(),
            this.rpc.getMiningInfo()
          ]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ network: net, mining: mine }));
        } catch (err) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }],

      // Force new job (admin)
      ['POST', '/job/new', (req, res) => {
        this.jobEngine.forceNewJob();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }]
    ];
  },

  _minerList() {
    return [...this.miners.values()].map(m => ({
      id:          m.id,
      user:        m.user,
      authorized:  m.authorized,
      difficulty:  m.difficulty,
      shares:      m.shares,
      accepted:    m.accepted,
      rejected:    m.rejected,
      hashrate:    Math.round(m.hashrate),
      connectedAt: m.connectedAt
    }));
  }
};

export default Pool;
