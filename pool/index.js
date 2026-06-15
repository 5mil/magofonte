/**
 * MagoFonte — pool module (DGB party mine)
 *
 * Full internal pool — talks directly to a DGB full node via RPC.
 * Waits for node:ready before starting job engine.
 * Reads active pool config from SettingsManager.
 *
 * Flow:
 *   settings:activePool  → configure
 *   node:ready           → start job engine
 *   node:stopped         → pause job engine
 *   DGB node ─getblocktemplate─▶ JobEngine
 *   JobEngine ─mining.notify─▶ MinerSessions
 *   MinerSession ─mining.submit─▶ ShareValidator
 *   ShareValidator ─submitblock─▶ node
 *   ShareValidator ─share event─▶ PayoutTracker
 */

import net    from 'node:net';
import crypto from 'node:crypto';
import http   from 'node:http';
import { EventEmitter } from 'node:events';
import { SettingsManager, MONETIZATION_TYPES } from './settings.js';
import { addressToScript, validateAddress }    from './address.js';

// ─── Utilities ───────────────────────────────────────────────────────────────

function hexToLE32(hex) {
  return hex.match(/.{8}/g).map(b => b.match(/.{2}/g).reverse().join('')).join('');
}

function dblSha256(buf) {
  const h1 = crypto.createHash('sha256').update(buf).digest();
  return crypto.createHash('sha256').update(h1).digest();
}

function pad(n, len) { return n.toString(16).padStart(len, '0'); }

// ─── DGB Node RPC ─────────────────────────────────────────────────────────────

class NodeRPC {
  constructor({ host, port, rpcuser, rpcpass }) {
    this.host  = host;  this.port = port;
    this.auth  = Buffer.from(`${rpcuser}:${rpcpass}`).toString('base64');
    this._id   = 1;
  }

  call(method, params = []) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '1.0', id: this._id++, method, params });
      const req  = http.request({
        host: this.host, port: this.port, method: 'POST',
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
            const p = JSON.parse(data);
            p.error ? reject(new Error(JSON.stringify(p.error))) : resolve(p.result);
          } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(10_000, () => { req.destroy(); reject(new Error('RPC timeout')); });
      req.write(body); req.end();
    });
  }

  getBlockTemplate() { return this.call('getblocktemplate', [{ rules: ['segwit'] }]); }
  submitBlock(hex)   { return this.call('submitblock', [hex]); }
  getBlockCount()    { return this.call('getblockcount'); }
  getNetworkInfo()   { return this.call('getnetworkinfo'); }
  getMiningInfo()    { return this.call('getmininginfo'); }
}

// ─── JobEngine ───────────────────────────────────────────────────────────────

class JobEngine extends EventEmitter {
  constructor(rpc, config) {
    super();
    this.rpc = rpc; this.config = config;
    this.currentJob = null; this.jobs = {};
    this._prevHash = null; this._pollTimer = null;
    this.running   = false;

    // ── Validate + cache the locking script once at construction time.
    // If the address is wrong/missing, fail loudly here rather than
    // silently building 100,000 coinbases that pay nobody.
    this._rewardScript = this._resolveRewardScript(config);
  }

  /**
   * Resolve the coinbase locking script from pool config.
   *
   * Priority order:
   *   1. config.blockRewardScript — raw hex script (escape hatch)
   *   2. config.blockRewardAddress — Base58Check → P2PKH / P2SH via address.js
   *   3. fallback: burn address (all-zero pubKeyHash) with loud warning
   *
   * Fires an error-level log (not a throw) so the pool still starts and
   * the operator can fix the address via the dashboard without restarting.
   */
  _resolveRewardScript(config) {
    // 1. Raw script override
    if (config.blockRewardScript) {
      console.log(`[pool:jobs] ✓ using raw reward script: ${config.blockRewardScript}`);
      return config.blockRewardScript;
    }

    // 2. Address → script
    if (config.blockRewardAddress) {
      try {
        const coinDef = config._coinDef || { id: config.coin };
        const script  = addressToScript(config.blockRewardAddress, coinDef);
        // Extra sanity: validate what we got
        const info    = validateAddress(config.blockRewardAddress, coinDef);
        console.log(
          `[pool:jobs] ✓ reward address ${config.blockRewardAddress}` +
          ` → ${info.type} script ${script}`
        );
        return script;
      } catch (err) {
        console.error(
          `[pool:jobs] ⚠ invalid blockRewardAddress "${config.blockRewardAddress}": ${err.message}` +
          ` — using burn address. FIX THIS.`
        );
      }
    } else {
      console.warn(
        '[pool:jobs] ⚠ no blockRewardAddress configured — coinbase pays to burn address. ' +
        'Set blockRewardAddress in pool settings or via the dashboard.'
      );
    }

    // 3. Burn address fallback — still mines, just coins go nowhere
    return '76a914' + '00'.repeat(20) + '88ac';
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._poll();
    this._pollTimer = setInterval(() => this._poll(), this.config.blockPollMs || 500);
    console.log('[pool:jobs] started job engine');
  }

  pause() {
    this.running = false;
    clearInterval(this._pollTimer);
    console.log('[pool:jobs] paused job engine');
  }

  async _poll() {
    if (!this.running) return;
    try {
      const tpl = await this.rpc.getBlockTemplate();
      if (tpl.previousblockhash !== this._prevHash) {
        this._prevHash = tpl.previousblockhash;
        this._buildJob(tpl, true);
      }
    } catch {}
  }

  _buildJob(tpl, cleanJobs = false) {
    const jobId = crypto.randomBytes(4).toString('hex');

    // ── Coinbase transaction ────────────────────────────────────────────────
    //
    //  Input (coinbase):
    //   version        04 bytes LE   01000000
    //   vin count      varint        01
    //   prev txid      32 bytes      00..00 (null)
    //   prev vout      04 bytes      ffffffff
    //   script length  varint        split: coinbase1 ends before extranonce,
    //                                       coinbase2 picks up after extranonce2
    //   height push    03 + height   BIP34 — required for DGB >= block 1
    //   extranonce     8 bytes       injected by miner subscribe / submit
    //   sequence       04 bytes      ffffffff
    //
    //  Output (reward):
    //   value          08 bytes LE   coinbasevalue in satoshis
    //   script length  varint
    //   locking script               P2PKH or P2SH from _rewardScript
    //
    //  Locktime:       04 bytes      00000000
    //
    // Stratum splits the coinbase around the extranonce:
    //   coinbase1 = everything up to (and including) extranonce1 placeholder
    //   coinbase2 = everything after extranonce2 placeholder
    //
    // The miner contributes extranonce1 (assigned at subscribe) and
    // extranonce2 (chosen per submit). The pool prepends extranonce1;
    // the miner appends extranonce2. Together they form the nonce field.

    const heightBuf = _encodeHeight(tpl.height);
    const scriptLen = 1 + heightBuf.length / 2 + 4 + 4; // height + en1(4) + en2(4)
    const scriptLenHex = pad(scriptLen, 2);

    // coinbase1: up through the end of extranonce1 (extranonce1 is filled in
    // per-session; the pool passes this as a template and each MinerSession
    // splices its own extranonce1 between coinbase1 and coinbase2)
    const coinbase1 = [
      '01000000',           // version (LE)
      '01',                 // 1 input
      '00'.repeat(32),      // null prev txid
      'ffffffff',           // null vout
      scriptLenHex,         // coinbase script length
      '03',                 // push 3 bytes (height, BIP34)
      heightBuf,            // block height LE
    ].join('');

    // coinbase2: after extranonce2 → sequence + outputs + locktime
    const rewardScript    = this._rewardScript;
    const rewardScriptLen = pad(rewardScript.length / 2, 2);
    const valueLE         = pad(tpl.coinbasevalue, 16).match(/.{2}/g).reverse().join('');

    const coinbase2 = [
      'ffffffff',         // sequence
      '01',               // 1 output
      valueLE,            // reward in satoshis (LE 8-byte)
      rewardScriptLen,    // output script length
      rewardScript,       // OP_DUP OP_HASH160 <pubKeyHash> OP_EQUALVERIFY OP_CHECKSIG
      '00000000',         // locktime
    ].join('');

    const txids          = (tpl.transactions || []).map(tx => tx.txid || tx.hash);
    const merkleBranches = this._getMerkleBranches(txids);

    const job = {
      jobId, cleanJobs, height: tpl.height, target: tpl.target,
      prevHash:       hexToLE32(tpl.previousblockhash),
      coinbase1, coinbase2, merkleBranches,
      version:        pad(tpl.version, 8),
      nbits:          tpl.bits,
      ntime:          pad(Math.floor(Date.now() / 1000), 8),
      template:       tpl,
      coinbaseValue:  tpl.coinbasevalue,
      rewardScript,
    };

    this.jobs[jobId] = job;
    this.currentJob  = job;
    const keys = Object.keys(this.jobs);
    if (keys.length > 8) delete this.jobs[keys[0]];
    console.log(`[pool:jobs] job ${jobId} h=${tpl.height} clean=${cleanJobs} reward=${tpl.coinbasevalue}sat`);
    this.emit('job', job);
    return job;
  }

  _getMerkleBranches(txids) {
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

  forceNewJob() {
    if (this.currentJob) this._buildJob(this.currentJob.template, false);
  }

  /**
   * Hot-update the reward address/script without restarting the engine.
   * Called when operator changes blockRewardAddress via dashboard.
   */
  updateRewardAddress(newAddress, coinDef) {
    try {
      this._rewardScript = addressToScript(newAddress, coinDef || { id: this.config.coin });
      this.config.blockRewardAddress = newAddress;
      console.log(`[pool:jobs] reward address updated → ${newAddress}`);
      // Force a new job so the next share uses the new script
      if (this.currentJob) this._buildJob(this.currentJob.template, false);
      return true;
    } catch (err) {
      console.error(`[pool:jobs] updateRewardAddress failed: ${err.message}`);
      return false;
    }
  }
}

// ─── Height encoder (BIP34) ───────────────────────────────────────────────────
/**
 * Encode block height as minimally-encoded little-endian bytes (BIP34).
 * Must be exactly 3 bytes for DGB (heights < 16,777,216) which covers us
 * well into the future. We pad to 3 bytes LE.
 */
function _encodeHeight(height) {
  if (height < 0 || height > 0xffffff)
    throw new Error(`height ${height} out of 3-byte range`);
  const b0 = height & 0xff;
  const b1 = (height >> 8) & 0xff;
  const b2 = (height >> 16) & 0xff;
  // Minimally encode: trim trailing zero bytes (from MSB side in LE representation)
  // but always keep at least 1 byte and ensure high bit clear (not negative)
  let bytes = [b0, b1, b2];
  // Remove trailing zero bytes unless needed for sign
  while (bytes.length > 1 && bytes[bytes.length-1] === 0) bytes.pop();
  // If high bit is set on last byte, add 0x00 to indicate positive
  if (bytes[bytes.length-1] & 0x80) bytes.push(0x00);
  return bytes.map(b => b.toString(16).padStart(2,'0')).join('');
}

// ─── VarDiff ──────────────────────────────────────────────────────────────────

class VarDiff {
  constructor(cfg) {
    this.min = cfg.minDiff||0.001; this.max = cfg.maxDiff||1000;
    this.target = cfg.targetTime||15; this.retarget = cfg.retargetTime||60;
    this.variance = cfg.variancePercent||30;
  }
  check(session) {
    const now = Date.now()/1000;
    if (!session._vdLastRetarget) { session._vdLastRetarget = now; session._vdShares = 0; return null; }
    const elapsed = now - session._vdLastRetarget;
    if (elapsed < this.retarget) return null;
    const rate    = session._vdShares > 0 ? session._vdShares/elapsed : 0;
    const actual  = rate > 0 ? 1/rate : this.target*2;
    const ratio   = actual/this.target;
    session._vdLastRetarget = now; session._vdShares = 0;
    if (ratio > 1+this.variance/100 || ratio < 1-this.variance/100) {
      const nd = Math.max(this.min, Math.min(this.max, session.difficulty/ratio));
      if (Math.abs(nd - session.difficulty)/session.difficulty > 0.1) return nd;
    }
    return null;
  }
}

// ─── ShareValidator ───────────────────────────────────────────────────────────

class ShareValidator {
  constructor(rpc) { this.rpc = rpc; }

  async validate(session, job, extranonce2, ntime, nonce) {
    if (!job) return { valid: false, error: 'job not found' };
    const shareKey = `${job.jobId}:${extranonce2}:${ntime}:${nonce}`;
    if (!session._shares) session._shares = new Set();
    if (session._shares.has(shareKey)) return { valid: false, error: 'duplicate share' };
    session._shares.add(shareKey);
    if (session._shares.size > 500) session._shares.clear();

    const coinbaseBuf  = Buffer.from(job.coinbase1 + session.extranonce1 + extranonce2 + job.coinbase2, 'hex');
    let merkle         = dblSha256(coinbaseBuf);
    for (const branch of job.merkleBranches)
      merkle = dblSha256(Buffer.concat([merkle, Buffer.from(branch,'hex').reverse()]));
    const merkleRoot   = merkle.reverse().toString('hex');

    // NOTE: Header is built here but hashed with SHA-256d (placeholder).
    // Skein-512 will replace the hash step for DGB Skein shares.
    const header = Buffer.from(
      hexToLE32(job.version) + job.prevHash + hexToLE32(merkleRoot) +
      hexToLE32(ntime) + hexToLE32(job.nbits) + hexToLE32(nonce), 'hex');

    const hashHex    = dblSha256(header).reverse().toString('hex');
    const diffTarget = this._diffToTarget(session.difficulty);
    if (BigInt('0x'+hashHex) > BigInt('0x'+diffTarget))
      return { valid: false, error: 'below difficulty' };

    const networkTarget = job.target.padStart(64, '0');
    const isBlock       = BigInt('0x'+hashHex) <= BigInt('0x'+networkTarget);
    if (isBlock) {
      const txCount  = (job.template.transactions||[]).length + 1;
      const blockHex = header.toString('hex') + pad(txCount, 2) +
        coinbaseBuf.toString('hex') +
        (job.template.transactions||[]).map(tx => tx.data).join('');
      try {
        const r = await this.rpc.submitBlock(blockHex);
        console.log(`[pool:BLOCK] 🎉 height=${job.height} result=${r ?? 'accepted'}`);
      } catch(err) { console.error('[pool:BLOCK] submitblock failed:', err.message); }
    }
    return { valid: true, isBlock, hashHex };
  }

  _diffToTarget(diff) {
    const diff1 = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');
    return (diff1 / BigInt(Math.round(diff*1000)) * 1000n).toString(16).padStart(64,'0');
  }
}

// ─── PayoutTracker (PPLNS) ─────────────────────────────────────────────────

class PayoutTracker {
  constructor(windowSize = 100) {
    this.window = windowSize;
    this.shares = []; this.blocks = []; this.earnings = {};
  }
  addShare(user, diff) {
    this.shares.push({ user, diff, ts: Date.now() });
    if (this.shares.length > this.window) this.shares.shift();
  }
  recordBlock(height, reward) {
    const snapshot = [...this.shares];
    const total    = snapshot.reduce((s,sh) => s+sh.diff, 0);
    const credited = {};
    for (const sh of snapshot) {
      const amt = total > 0 ? sh.diff/total*reward : 0;
      credited[sh.user]      = (credited[sh.user]||0)      + amt;
      this.earnings[sh.user] = (this.earnings[sh.user]||0) + amt;
    }
    this.blocks.push({ height, reward, ts: Date.now(), credited });
    return credited;
  }
  getStats() {
    const userShares = {};
    for (const s of this.shares) userShares[s.user] = (userShares[s.user]||0)+1;
    return {
      windowShares: this.shares.length, userShares,
      earnings:     this.earnings,
      blocksFound:  this.blocks.length,
      recentBlocks: this.blocks.slice(-10)
    };
  }
}

// ─── MinerSession ───────────────────────────────────────────────────────────

class MinerSession {
  constructor(socket, pool) {
    this.id          = crypto.randomUUID();
    this.socket      = socket;
    this.pool        = pool;
    this.buf         = '';
    this.authorized  = false;
    this.user        = null;
    this.difficulty  = pool.activeConfig?.defaultDiff || 0.01;
    this.shares = 0; this.accepted = 0; this.rejected = 0; this.hashrate = 0;
    this.connectedAt = Date.now();
    this.extranonce1 = crypto.randomBytes(4).toString('hex');
    this._shareTimes = []; this._shares = new Set();
    socket.setEncoding('utf8');
    socket.on('data', d => {
      this.buf += d;
      this.buf.split('\n').slice(0,-1).forEach(l => { try { this._onMsg(JSON.parse(l)); } catch{} });
      this.buf = this.buf.split('\n').pop();
    });
    socket.on('error', () => this._cleanup());
    socket.on('close', () => this._cleanup());
  }
  _cleanup() { this.pool.removeMiner(this.id); }
  send(obj)  { try { this.socket.write(JSON.stringify(obj)+'\n'); } catch{} }
  sendDiff(d){ this.difficulty = d; this.send({ id:null, method:'mining.set_difficulty', params:[d] }); }
  sendJob(job, clean) {
    this.send({ id:null, method:'mining.notify', params:[
      job.jobId, job.prevHash, job.coinbase1, job.coinbase2,
      job.merkleBranches, job.version, job.nbits, job.ntime, clean
    ]});
  }
  _onMsg(msg) {
    if (msg.method === 'mining.subscribe') {
      this.send({ id:msg.id, result:[[['mining.set_difficulty',this.id],['mining.notify',this.id]], this.extranonce1, 4], error:null });
      this.sendDiff(this.difficulty);
      const job = this.pool.jobEngine?.currentJob;
      if (job) this.sendJob(job, true);
    } else if (msg.method === 'mining.authorize') {
      this.user = msg.params?.[0] || 'anon';
      this.authorized = true;
      this.send({ id:msg.id, result:true, error:null });
      this.pool.registry.emit('miner:authorized', { id:this.id, user:this.user });
    } else if (msg.method === 'mining.submit') {
      this._submit(msg);
    } else if (msg.method === 'mining.extranonce.subscribe') {
      this.send({ id:msg.id, result:true, error:null });
    }
  }
  async _submit(msg) {
    if (!this.authorized) { this.send({ id:msg.id, result:false, error:[24,'Unauthorized',null] }); return; }
    const [,jobId,en2,ntime,nonce] = msg.params||[];
    const job = this.pool.jobEngine?.jobs[jobId];
    const result = await this.pool.validator.validate(this, job, en2, ntime, nonce);
    this.shares++;
    const now = Date.now();
    this._shareTimes = [...this._shareTimes.filter(t => now-t < 60_000), now];
    this.hashrate = this._shareTimes.length * this.difficulty * 4_294_967_296 / 60;
    if (result.valid) {
      this.accepted++;
      this.pool.payout.addShare(this.user, this.difficulty);
      this.send({ id:msg.id, result:true, error:null });
      this.pool.registry.emit('share:accepted', { minerId:this.id, user:this.user, jobId, isBlock:result.isBlock, hashrate:this.hashrate });
      if (result.isBlock) {
        this.pool.registry.emit('block:found', { user:this.user, height:job.height, reward:job.coinbaseValue });
        this.pool.payout.recordBlock(job.height, job.coinbaseValue);
        this.pool.jobEngine.forceNewJob();
      }
    } else {
      this.rejected++;
      this.send({ id:msg.id, result:false, error:[20, result.error, null] });
    }
    if (this.pool.varDiff) {
      this._vdShares = (this._vdShares||0)+1;
      const nd = this.pool.varDiff.check(this);
      if (nd !== null) this.sendDiff(nd);
    }
  }
}

// ─── Pool module ───────────────────────────────────────────────────────────────

const Pool = {
  name: 'pool',

  async init(config, registry) {
    this.registry     = registry;
    this.miners       = new Map();
    this.settings     = new SettingsManager(registry);
    this.jobEngine    = null;
    this.validator    = null;
    this.payout       = null;
    this.varDiff      = null;
    this.rpc          = null;
    this.stratumServer= null;
    this.activeConfig = null;

    registry.on('node:ready', ({ coin, node }) => {
      const poolCfg = this.settings.autoRegisterFromNode(coin);
      if (poolCfg && !poolCfg.monetization.mining.enabled) {
        this.settings.setMonetization(coin, 'mining', true);
        this.settings.setActivePool(coin);
      }
      const active = this.settings.getActivePool();
      if (active?.coin === coin) this._startMining(active, node);
    });

    registry.on('node:stopped', ({ coin }) => {
      if (this.activeConfig?.coin === coin) this.jobEngine?.pause();
    });

    registry.on('settings:activePool:changed', ({ poolId }) => {
      const cfg     = this.settings.getPool(poolId);
      const nodemod = registry.get('node');
      const node    = nodemod?.nodes.get(cfg?.coin);
      if (cfg && node?.status === 'ready') this._startMining(cfg, node);
    });

    if (config?.coin && config?.node) {
      this.rpc          = new NodeRPC(config.node);
      this.validator    = new ShareValidator(this.rpc);
      this.payout       = new PayoutTracker(config.pplnsWindow || 100);
      this.varDiff      = config.varDiff?.enabled ? new VarDiff(config.varDiff) : null;
      this.jobEngine    = new JobEngine(this.rpc, config);
      this.activeConfig = config;
      this.jobEngine.on('job', job => this._broadcastJob(job));
      this._openStratum(config.stratumPort || 3333);
    }

    return this;
  },

  _startMining(poolCfg, node) {
    console.log(`[pool] starting mining for ${poolCfg.coin} on stratum :${poolCfg.stratumPort}`);
    this.activeConfig = poolCfg;
    const rpcCfg = { host:'127.0.0.1', port: node.coin.daemon.rpcPort,
                     rpcuser: node.creds.user, rpcpass: node.creds.pass };
    this.rpc       = new NodeRPC(rpcCfg);
    this.validator = new ShareValidator(this.rpc);
    this.payout    = new PayoutTracker(poolCfg.pplnsWindow || 100);
    this.varDiff   = poolCfg.varDiff?.enabled ? new VarDiff(poolCfg.varDiff) : null;
    this.jobEngine = new JobEngine(this.rpc, poolCfg);
    this.jobEngine.on('job', job => this._broadcastJob(job));
    this.jobEngine.start();
    this._openStratum(poolCfg.stratumPort || 3333);
    this.registry.emit('pool:started', { coin: poolCfg.coin });
  },

  _openStratum(port) {
    if (this.stratumServer) { this.stratumServer.close(); this.stratumServer = null; }
    this.stratumServer = net.createServer(socket => {
      const session = new MinerSession(socket, this);
      this.miners.set(session.id, session);
      console.log(`[pool] miner+ ${socket.remoteAddress} (${this.miners.size} total)`);
    });
    this.stratumServer.listen(port, '0.0.0.0', () =>
      console.log(`[pool] stratum :${port}`));
  },

  _broadcastJob(job) {
    let sent = 0;
    for (const m of this.miners.values())
      if (m.authorized) { m.sendJob(job, job.cleanJobs); sent++; }
    if (sent) console.log(`[pool:jobs] broadcast ${job.jobId} → ${sent} miners`);
  },

  removeMiner(id) {
    const m = this.miners.get(id);
    if (m) { this.miners.delete(id); this.registry.emit('miner:disconnected', { id, user:m.user }); }
  },

  // ── REST ──────────────────────────────────────────────────────────────────
  get routes() {
    const sm = this.settings;
    return [
      ['GET', '/status', (req,res) => {
        const miners = this._minerList();
        const job    = this.jobEngine?.currentJob;
        const active = sm.getActivePool();
        _json(res, {
          active: active?.id ?? null, coin: this.activeConfig?.coin,
          algo:   this.activeConfig?.algo,  height: job?.height ?? null,
          miners: miners.length,
          hashrate: miners.reduce((s,m) => s+m.hashrate, 0),
          blocksFound: this.payout?.getStats().blocksFound ?? 0,
          rewardAddress: this.activeConfig?.blockRewardAddress ?? null,
          rewardScript:  this.jobEngine?._rewardScript ?? null,
          miners_list: miners
        });
      }],

      ['GET', '/miners', (req,res) => _json(res, this._minerList())],
      ['GET', '/payout', (req,res) => _json(res, this.payout?.getStats() ?? {})],

      ['GET', '/job', (req,res) => {
        const job = this.jobEngine?.currentJob;
        res.writeHead(job ? 200 : 503, {'Content-Type':'application/json'});
        res.end(JSON.stringify(job
          ? { jobId:job.jobId, height:job.height, nbits:job.nbits, ntime:job.ntime, target:job.target }
          : { error:'no job' }));
      }],

      ['GET', '/node', async (req,res) => {
        try {
          const [net, mine] = await Promise.all([this.rpc.getNetworkInfo(), this.rpc.getMiningInfo()]);
          _json(res, { network:net, mining:mine });
        } catch(err) { res.writeHead(503); res.end(JSON.stringify({ error:err.message })); }
      }],

      ['POST', '/job/new', (req,res) => { this.jobEngine?.forceNewJob(); _json(res, { ok:true }); }],

      // ── Reward address hot-update ───────────────────────────────────────
      ['POST', '/reward-address', async (req,res) => {
        const body = await _body(req);
        try {
          const { address } = JSON.parse(body);
          if (!address) return _400(res, 'address required');
          const coinDef = this.activeConfig?._coinDef || { id: this.activeConfig?.coin };
          if (!this.jobEngine) return _400(res, 'job engine not running');
          const ok = this.jobEngine.updateRewardAddress(address, coinDef);
          if (!ok) return _400(res, 'invalid address — check logs');
          // Persist to settings
          if (this.activeConfig) this.activeConfig.blockRewardAddress = address;
          _json(res, { ok: true, address, script: this.jobEngine._rewardScript });
        } catch(e) { _400(res, e.message); }
      }],

      // ── Address validation utility ──────────────────────────────────────
      ['POST', '/validate-address', async (req,res) => {
        const body = await _body(req);
        try {
          const { address, coin } = JSON.parse(body);
          const result = validateAddress(address, { id: coin || this.activeConfig?.coin || 'dgb' });
          _json(res, result);
        } catch(e) { _400(res, e.message); }
      }],

      // ── Settings ───────────────────────────────────────────────────────
      ['GET',    '/settings/pools',              (req,res) => _json(res, sm.listPools())],
      ['GET',    '/settings/pools/:id',          (req,res) => { const p=sm.getPool(req.params.id); p?_json(res,p):_404(res); }],
      ['POST',   '/settings/pools',              async(req,res) => { const b=await _body(req); try{const p=sm.registerPool(JSON.parse(b));res.writeHead(201,{'Content-Type':'application/json'});res.end(JSON.stringify(p));}catch(e){_400(res,e.message);} }],
      ['PATCH',  '/settings/pools/:id',          async(req,res) => { const b=await _body(req); try{_json(res,sm.updatePool(req.params.id,JSON.parse(b)));}catch(e){_400(res,e.message);} }],
      ['DELETE', '/settings/pools/:id',          (req,res) => { try{sm.deletePool(req.params.id);_json(res,{ok:true});}catch(e){_400(res,e.message);} }],
      ['POST',   '/settings/active',             async(req,res) => { const b=await _body(req); try{const{poolId}=JSON.parse(b);sm.setActivePool(poolId);_json(res,{ok:true,activePool:poolId});}catch(e){_400(res,e.message);} }],
      ['GET',    '/settings/pools/:id/monetization', (req,res) => { try{_json(res,sm.getMonetizationOptions(req.params.id));}catch(e){_400(res,e.message);} }],
      ['POST',   '/settings/pools/:id/monetization/:type', async(req,res) => { const b=await _body(req); try{const{enabled,config}=JSON.parse(b);_json(res,sm.setMonetization(req.params.id,req.params.type,enabled,config||{}));}catch(e){_400(res,e.message);} }],
      ['GET',    '/settings/monetization-types', (req,res) => _json(res, Object.values(MONETIZATION_TYPES).map(t=>({id:t.id,label:t.label,description:t.description,settings:Object.fromEntries(Object.entries(t.settings).map(([k,s])=>[k,{...s,options:typeof s.options==='function'?[]:s.options}]))})))]
    ];
  },

  _minerList() {
    return [...this.miners.values()].map(m => ({
      id:m.id, user:m.user, authorized:m.authorized, difficulty:m.difficulty,
      shares:m.shares, accepted:m.accepted, rejected:m.rejected,
      hashrate:Math.round(m.hashrate), connectedAt:m.connectedAt
    }));
  }
};

function _json(res, data, status=200) { res.writeHead(status,{'Content-Type':'application/json'}); res.end(JSON.stringify(data)); }
function _404(res)     { res.writeHead(404); res.end(JSON.stringify({error:'not found'})); }
function _400(res, msg){ res.writeHead(400); res.end(JSON.stringify({error:msg})); }
function _body(req)    { return new Promise(r => { let b=''; req.on('data',d=>b+=d); req.on('end',()=>r(b)); }); }

export default Pool;
