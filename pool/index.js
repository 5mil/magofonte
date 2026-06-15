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
 *   JobEngine ─mining.notify─▶ MinerSessions (external miners via Stratum)
 *                          └─▶ CpuMiner     (built-in server-side CPU mining)
 *   MinerSession / CpuMiner ─mining.submit─▶ ShareValidator
 *   ShareValidator ─submitblock─▶ node
 *   ShareValidator ─share event─▶ PayoutTracker  (per-pool PPLNS)
 *                             └─▶ BonusLedger   (cross-pool CPU bonus)
 *
 * CPU bonus:
 *   When the server CPU miner finds a block, 100% of that reward
 *   (minus optional operator fee) is split proportionally across ALL
 *   workers who submitted valid shares on ANY pool in the last 30 min.
 *   Completely separate from per-pool PPLNS. Dust is carried forward.
 *
 * CPU mining config (in pool config object):
 *   cpuMining: {
 *     enabled:  true,
 *     threads:  4,       // defaults to os.cpus().length
 *     throttle: 0.75,    // 0.0–1.0 CPU fraction (default 1.0)
 *   }
 *
 * BonusLedger config (top-level pool config):
 *   bonus: {
 *     windowMs:       1_800_000,  // 30 min rolling window (default)
 *     operatorFeePct: 0,          // operator cut of CPU blocks (default 0)
 *     dustThreshold:  1000,       // min satoshis to pay out (default)
 *   }
 *
 * Wallet routes (mounted under /api/wallet):
 *   GET    /api/wallet/:coin                   list wallets
 *   POST   /api/wallet/:coin/generate          generate keypair
 *   POST   /api/wallet/:coin/import            import WIF
 *   GET    /api/wallet/:coin/:label/export     export WIF
 *   POST   /api/wallet/:coin/:label/setActive  set active + hot-swap reward address
 *   DELETE /api/wallet/:coin/:label            remove wallet
 */

import net    from 'node:net';
import crypto from 'node:crypto';
import http   from 'node:http';
import os     from 'node:os';
import { EventEmitter }                        from 'node:events';
import { SettingsManager, MONETIZATION_TYPES } from './settings.js';
import { addressToScript, validateAddress }    from './address.js';
import { hashHeader }                          from './hash.js';
import { CpuMiner }                            from './miner.js';
import { BonusLedger }                         from './bonus.js';
import walletManager                           from './walletManager.js';
import { walletRoutes }                        from './walletRoutes.js';

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
    this.host = host; this.port = port;
    this.auth = Buffer.from(`${rpcuser}:${rpcpass}`).toString('base64');
    this._id  = 1;
  }
  call(method, params = []) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc:'1.0', id:this._id++, method, params });
      const req  = http.request({
        host:this.host, port:this.port, method:'POST',
        headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'Authorization':`Basic ${this.auth}`}
      }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => { try{const p=JSON.parse(data); p.error?reject(new Error(JSON.stringify(p.error))):resolve(p.result);}catch(e){reject(e);} });
      });
      req.on('error', reject);
      req.setTimeout(10_000, () => { req.destroy(); reject(new Error('RPC timeout')); });
      req.write(body); req.end();
    });
  }
  getBlockTemplate() { return this.call('getblocktemplate',[{rules:['segwit']}]); }
  submitBlock(hex)   { return this.call('submitblock',[hex]); }
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
    this._rewardScript = this._resolveRewardScript(config);
  }
  _resolveRewardScript(config) {
    if (config.blockRewardScript) { console.log(`[pool:jobs] ✓ raw reward script`); return config.blockRewardScript; }
    if (config.blockRewardAddress) {
      try {
        const s = addressToScript(config.blockRewardAddress, config._coinDef||{id:config.coin});
        const i = validateAddress(config.blockRewardAddress, config._coinDef||{id:config.coin});
        console.log(`[pool:jobs] ✓ reward ${config.blockRewardAddress} → ${i.type} ${s}`);
        return s;
      } catch(e) { console.error(`[pool:jobs] ⚠ invalid blockRewardAddress: ${e.message} — burn fallback`); }
    } else { console.warn('[pool:jobs] ⚠ no blockRewardAddress — burn fallback'); }
    return '76a914'+'00'.repeat(20)+'88ac';
  }
  start() {
    if (this.running) return; this.running = true;
    this._poll();
    this._pollTimer = setInterval(()=>this._poll(), this.config.blockPollMs||500);
    console.log('[pool:jobs] started');
  }
  pause() { this.running=false; clearInterval(this._pollTimer); console.log('[pool:jobs] paused'); }
  async _poll() {
    if (!this.running) return;
    try {
      const tpl = await this.rpc.getBlockTemplate();
      if (tpl.previousblockhash !== this._prevHash) { this._prevHash=tpl.previousblockhash; this._buildJob(tpl,true); }
    } catch {}
  }
  _buildJob(tpl, cleanJobs=false) {
    const jobId     = crypto.randomBytes(4).toString('hex');
    const hBuf      = _encodeHeight(tpl.height);
    const sLen      = 1 + hBuf.length/2 + 4 + 4;
    const coinbase1 = ['01000000','01','00'.repeat(32),'ffffffff',pad(sLen,2),'03',hBuf].join('');
    const rs        = this._rewardScript;
    const valueLE   = pad(tpl.coinbasevalue,16).match(/.{2}/g).reverse().join('');
    const coinbase2 = ['ffffffff','01',valueLE,pad(rs.length/2,2),rs,'00000000'].join('');
    const txids     = (tpl.transactions||[]).map(tx=>tx.txid||tx.hash);
    const job = {
      jobId, cleanJobs, height:tpl.height, target:tpl.target,
      prevHash: hexToLE32(tpl.previousblockhash),
      coinbase1, coinbase2,
      merkleBranches: this._getMerkleBranches(txids),
      version: pad(tpl.version,8), nbits:tpl.bits,
      ntime:   pad(Math.floor(Date.now()/1000),8),
      template:tpl, coinbaseValue:tpl.coinbasevalue, rewardScript:rs,
    };
    this.jobs[jobId]=job; this.currentJob=job;
    const keys=Object.keys(this.jobs); if (keys.length>8) delete this.jobs[keys[0]];
    console.log(`[pool:jobs] job ${jobId} h=${tpl.height} algo=${this.config.algo}`);
    this.emit('job', job);
    return job;
  }
  _getMerkleBranches(txids) {
    if (!txids.length) return [];
    const branches=[];
    let layer=txids.map(t=>Buffer.from(t,'hex').reverse());
    while (layer.length>0) {
      branches.push(layer[0].reverse().toString('hex'));
      if (layer.length===1) break;
      if (layer.length%2!==0) layer.push(layer[layer.length-1]);
      const next=[];
      for (let i=0;i<layer.length;i+=2) next.push(dblSha256(Buffer.concat([layer[i],layer[i+1]])));
      layer=next;
    }
    return branches;
  }
  forceNewJob() { if (this.currentJob) this._buildJob(this.currentJob.template,false); }
  updateRewardAddress(addr, coinDef) {
    try {
      this._rewardScript = addressToScript(addr, coinDef||{id:this.config.coin});
      this.config.blockRewardAddress = addr;
      console.log(`[pool:jobs] reward → ${addr}`);
      if (this.currentJob) this._buildJob(this.currentJob.template,false);
      return true;
    } catch(e) { console.error(`[pool:jobs] updateRewardAddress: ${e.message}`); return false; }
  }
}

function _encodeHeight(h) {
  const bytes=[h&0xff,(h>>8)&0xff,(h>>16)&0xff];
  while (bytes.length>1&&bytes[bytes.length-1]===0) bytes.pop();
  if (bytes[bytes.length-1]&0x80) bytes.push(0x00);
  return bytes.map(b=>b.toString(16).padStart(2,'0')).join('');
}

// ─── VarDiff ──────────────────────────────────────────────────────────────────

class VarDiff {
  constructor(cfg) { this.min=cfg.minDiff||0.001;this.max=cfg.maxDiff||1000;this.target=cfg.targetTime||15;this.retarget=cfg.retargetTime||60;this.variance=cfg.variancePercent||30; }
  check(s) {
    const now=Date.now()/1000;
    if (!s._vdLastRetarget){s._vdLastRetarget=now;s._vdShares=0;return null;}
    const el=now-s._vdLastRetarget; if(el<this.retarget)return null;
    const rate=s._vdShares>0?s._vdShares/el:0;
    const actual=rate>0?1/rate:this.target*2;
    const ratio=actual/this.target;
    s._vdLastRetarget=now;s._vdShares=0;
    if(ratio>1+this.variance/100||ratio<1-this.variance/100){
      const nd=Math.max(this.min,Math.min(this.max,s.difficulty/ratio));
      if(Math.abs(nd-s.difficulty)/s.difficulty>0.1)return nd;
    }
    return null;
  }
}

// ─── ShareValidator ───────────────────────────────────────────────────────────

class ShareValidator {
  constructor(rpc, algo) { this.rpc=rpc; this.algo=algo||'skein'; console.log(`[pool:validator] algo=${this.algo}`); }
  async validate(session, job, extranonce2, ntime, nonce) {
    if (!job) return {valid:false,error:'job not found'};
    const key=`${job.jobId}:${extranonce2}:${ntime}:${nonce}`;
    if (!session._shares) session._shares=new Set();
    if (session._shares.has(key)) return {valid:false,error:'duplicate share'};
    session._shares.add(key);
    if (session._shares.size>500) session._shares.clear();
    const coinbaseBuf=Buffer.from(job.coinbase1+session.extranonce1+extranonce2+job.coinbase2,'hex');
    let merkle=dblSha256(coinbaseBuf);
    for (const b of job.merkleBranches) merkle=dblSha256(Buffer.concat([merkle,Buffer.from(b,'hex').reverse()]));
    const merkleRoot=merkle.reverse().toString('hex');
    const headerBuf=Buffer.from([hexToLE32(job.version),job.prevHash,hexToLE32(merkleRoot),hexToLE32(ntime),hexToLE32(job.nbits),hexToLE32(nonce)].join(''),'hex');
    const hashBuf=hashHeader(headerBuf,this.algo);
    const hashHex=hashBuf.toString('hex');
    const diffTarget=this._diffToTarget(session.difficulty);
    if (BigInt('0x'+hashHex)>BigInt('0x'+diffTarget)) return {valid:false,error:'below difficulty'};
    const isBlock=BigInt('0x'+hashHex)<=BigInt('0x'+job.target.padStart(64,'0'));
    if (isBlock) {
      console.log(`[pool:BLOCK] 🎉 h=${job.height} hash=${hashHex.slice(0,16)}… algo=${this.algo}`);
      const txCount=(job.template.transactions||[]).length+1;
      const blockHex=headerBuf.toString('hex')+this._varint(txCount)+coinbaseBuf.toString('hex')+(job.template.transactions||[]).map(tx=>tx.data).join('');
      try {
        const r=await this.rpc.submitBlock(blockHex);
        console.log(`[pool:BLOCK] submitblock: ${r??'accepted'}`);
        if (r&&r!=='accepted') console.warn(`[pool:BLOCK] rejected: ${r}`);
      } catch(e) { console.error('[pool:BLOCK] RPC error:',e.message); }
    }
    return {valid:true,isBlock,hashHex};
  }
  _varint(n){if(n<0xfd)return pad(n,2);if(n<=0xffff)return'fd'+pad(n,4).match(/.{2}/g).reverse().join('');return'fe'+pad(n,8).match(/.{2}/g).reverse().join('');}
  _diffToTarget(diff){const d1=BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');return(d1/BigInt(Math.round(diff*1000))*1000n).toString(16).padStart(64,'0');}
}

// ─── PayoutTracker (PPLNS) ─────────────────────────────────────────────────

class PayoutTracker {
  constructor(n=100){this.window=n;this.shares=[];this.blocks=[];this.earnings={};}
  addShare(user,diff){this.shares.push({user,diff,ts:Date.now()});if(this.shares.length>this.window)this.shares.shift();}
  recordBlock(height,reward){
    const snap=[...this.shares];const total=snap.reduce((s,sh)=>s+sh.diff,0);const cred={};
    for(const sh of snap){const amt=total>0?sh.diff/total*reward:0;cred[sh.user]=(cred[sh.user]||0)+amt;this.earnings[sh.user]=(this.earnings[sh.user]||0)+amt;}
    this.blocks.push({height,reward,ts:Date.now(),credited:cred});return cred;
  }
  getStats(){const u={};for(const s of this.shares)u[s.user]=(u[s.user]||0)+1;return{windowShares:this.shares.length,userShares:u,earnings:this.earnings,blocksFound:this.blocks.length,recentBlocks:this.blocks.slice(-10)};}
}

// ─── MinerSession (external Stratum miners) ─────────────────────────────────

class MinerSession {
  constructor(socket, pool) {
    this.id=crypto.randomUUID();this.socket=socket;this.pool=pool;
    this.buf='';this.authorized=false;this.user=null;
    this.difficulty=pool.activeConfig?.defaultDiff||0.01;
    this.shares=0;this.accepted=0;this.rejected=0;this.hashrate=0;
    this.connectedAt=Date.now();
    this.extranonce1=crypto.randomBytes(4).toString('hex');
    this._shareTimes=[];this._shares=new Set();
    socket.setEncoding('utf8');
    socket.on('data',d=>{this.buf+=d;this.buf.split('\n').slice(0,-1).forEach(l=>{try{this._onMsg(JSON.parse(l));}catch{}});this.buf=this.buf.split('\n').pop();});
    socket.on('error',()=>this._cleanup());
    socket.on('close',()=>this._cleanup());
  }
  _cleanup(){this.pool.removeMiner(this.id);}
  send(obj){try{this.socket.write(JSON.stringify(obj)+'\n');}catch{}}
  sendDiff(d){this.difficulty=d;this.send({id:null,method:'mining.set_difficulty',params:[d]});}
  sendJob(job,clean){this.send({id:null,method:'mining.notify',params:[job.jobId,job.prevHash,job.coinbase1,job.coinbase2,job.merkleBranches,job.version,job.nbits,job.ntime,clean]});}
  _onMsg(msg){
    if(msg.method==='mining.subscribe'){
      this.send({id:msg.id,result:[[['mining.set_difficulty',this.id],['mining.notify',this.id]],this.extranonce1,4],error:null});
      this.sendDiff(this.difficulty);
      const job=this.pool.jobEngine?.currentJob; if(job) this.sendJob(job,true);
    } else if(msg.method==='mining.authorize'){
      this.user=msg.params?.[0]||'anon';this.authorized=true;
      this.send({id:msg.id,result:true,error:null});
      this.pool.registry.emit('miner:authorized',{id:this.id,user:this.user});
    } else if(msg.method==='mining.submit'){
      this._submit(msg);
    } else if(msg.method==='mining.extranonce.subscribe'){
      this.send({id:msg.id,result:true,error:null});
    }
  }
  async _submit(msg){
    if(!this.authorized){this.send({id:msg.id,result:false,error:[24,'Unauthorized',null]});return;}
    const[,jobId,en2,ntime,nonce]=msg.params||[];
    const job=this.pool.jobEngine?.jobs[jobId];
    const result=await this.pool.validator.validate(this,job,en2,ntime,nonce);
    this.shares++;
    const now=Date.now();
    this._shareTimes=[...this._shareTimes.filter(t=>now-t<60_000),now];
    this.hashrate=this._shareTimes.length*this.difficulty*4_294_967_296/60;
    if(result.valid){
      this.accepted++;this.pool.payout.addShare(this.user,this.difficulty);
      this.pool.registry.bonusLedger?.recordShare(this.pool.poolId, this.user, this.difficulty);
      this.send({id:msg.id,result:true,error:null});
      this.pool.registry.emit('share:accepted',{minerId:this.id,user:this.user,jobId,isBlock:result.isBlock,hashrate:this.hashrate});
      if(result.isBlock){
        this.pool.registry.emit('block:found',{user:this.user,height:job.height,reward:job.coinbaseValue});
        this.pool.payout.recordBlock(job.height,job.coinbaseValue);
        this.pool.jobEngine.forceNewJob();
      }
    } else {
      this.rejected++;this.send({id:msg.id,result:false,error:[20,result.error,null]});
    }
    if(this.pool.varDiff){this._vdShares=(this._vdShares||0)+1;const nd=this.pool.varDiff.check(this);if(nd!==null)this.sendDiff(nd);}
  }
}

// ─── CpuMinerSession (bridges CpuMiner → ShareValidator → BonusLedger) ──────────

class CpuMinerSession {
  constructor(pool) {
    this.pool        = pool;
    this.id          = 'cpu-miner';
    this.user        = 'server';
    this.difficulty  = 1.0;
    this.extranonce1 = crypto.randomBytes(4).toString('hex');
    this._shares     = new Set();
    this.accepted    = 0; this.rejected = 0;
  }

  async onFound({ nonce, nonceHex, extranonce2, hashHex, jobId }) {
    const job = this.pool.jobEngine?.jobs[jobId] || this.pool.jobEngine?.currentJob;
    if (!job) { console.warn('[miner] found but no job'); return; }

    const result = await this.pool.validator.validate(
      this, job, extranonce2, job.ntime, nonceHex.padStart(8,'0')
    );

    if (result.valid) {
      this.accepted++;
      this.pool.registry.emit('share:accepted', { minerId:this.id, user:this.user, jobId, isBlock:result.isBlock });

      if (result.isBlock) {
        console.log(`[miner] 🎉 CPU found block h=${job.height} reward=${job.coinbaseValue}sat!`);
        this.pool.registry.emit('block:found', { user:this.user, height:job.height, reward:job.coinbaseValue });
        this.pool.payout.recordBlock(job.height, job.coinbaseValue);

        const ledger = this.pool.registry.bonusLedger;
        if (ledger) {
          ledger.cpuBlockFound(job.coinbaseValue, {
            height:  job.height,
            coin:    this.pool.activeConfig?.coin,
            hashHex: result.hashHex,
          });
        } else {
          console.warn('[miner] no bonusLedger on registry — CPU block reward not distributed');
        }

        this.pool.jobEngine.forceNewJob();
      }
    } else {
      this.rejected++;
      console.warn(`[miner] CPU share rejected: ${result.error}`);
    }
  }
}

// ─── Pool module ───────────────────────────────────────────────────────────────

const Pool = {
  name: 'pool',

  async init(config, registry) {
    this.registry=registry; this.miners=new Map();
    this.settings=new SettingsManager(registry);
    this.jobEngine=null; this.validator=null; this.payout=null;
    this.varDiff=null; this.rpc=null; this.stratumServer=null;
    this.activeConfig=null; this.cpuMiner=null; this.cpuSession=null;
    this.poolId = config?.coin ? `${config.coin}-${config.algo||'skein'}` : 'pool';

    // ── Bootstrap the singleton BonusLedger on the registry ──
    if (!registry.bonusLedger) {
      registry.bonusLedger = new BonusLedger(registry, config?.bonus || {});
    }

    // ── Wire walletManager → jobEngine hot-swap ──────────────────────────────
    // When the active wallet changes for any coin, if the pool is currently
    // running for that coin, immediately swap the reward address so the very
    // next block template uses the new address — no restart required.
    walletManager.on('activeChanged', ({ coinId, address }) => {
      if (!this.jobEngine) return;
      if (this.activeConfig?.coin !== coinId) return;
      const coinDef = this.activeConfig._coinDef || { id: coinId };
      const ok = this.jobEngine.updateRewardAddress(address, coinDef);
      console.log(`[pool:wallet] activeChanged → ${coinId} ${address} (applied=${ok})`);
    });

    registry.on('node:ready',({coin,node})=>{
      const poolCfg=this.settings.autoRegisterFromNode(coin);
      if(poolCfg&&!poolCfg.monetization.mining.enabled){this.settings.setMonetization(coin,'mining',true);this.settings.setActivePool(coin);}
      const active=this.settings.getActivePool();
      if(active?.coin===coin) this._startMining(active,node);
    });
    registry.on('node:stopped',({coin})=>{
      if(this.activeConfig?.coin===coin){this.jobEngine?.pause();this.cpuMiner?.stop();}
    });
    registry.on('settings:activePool:changed',({poolId})=>{
      const cfg=this.settings.getPool(poolId);
      const nodemod=registry.get('node');
      const node=nodemod?.nodes.get(cfg?.coin);
      if(cfg&&node?.status==='ready') this._startMining(cfg,node);
    });
    if(config?.coin&&config?.node){
      this.rpc       = new NodeRPC(config.node);
      this.validator = new ShareValidator(this.rpc, config.algo||'skein');
      this.payout    = new PayoutTracker(config.pplnsWindow||100);
      this.varDiff   = config.varDiff?.enabled ? new VarDiff(config.varDiff) : null;
      this.jobEngine = new JobEngine(this.rpc, config);
      this.activeConfig = config;
      this.jobEngine.on('job', job => {
        this._broadcastJob(job);
        this.cpuMiner?.newJob(job, this.cpuSession?.extranonce1);
      });
      this._openStratum(config.stratumPort||3333);
      registry.bonusLedger.registerPool(this.poolId, this.payout);
      if (config.cpuMining?.enabled) this._startCpuMiner(config);
    }
    return this;
  },

  _startMining(poolCfg, node) {
    console.log(`[pool] starting ${poolCfg.coin} (${poolCfg.algo}) on :${poolCfg.stratumPort}`);
    this.activeConfig=poolCfg;
    this.poolId = `${poolCfg.coin}-${poolCfg.algo||'skein'}`;
    const rpcCfg={host:'127.0.0.1',port:node.coin.daemon.rpcPort,rpcuser:node.creds.user,rpcpass:node.creds.pass};
    this.rpc       = new NodeRPC(rpcCfg);
    this.validator = new ShareValidator(this.rpc, poolCfg.algo||'skein');
    this.payout    = new PayoutTracker(poolCfg.pplnsWindow||100);
    this.varDiff   = poolCfg.varDiff?.enabled ? new VarDiff(poolCfg.varDiff) : null;
    this.jobEngine = new JobEngine(this.rpc, poolCfg);
    this.jobEngine.on('job', job => {
      this._broadcastJob(job);
      this.cpuMiner?.newJob(job, this.cpuSession?.extranonce1);
    });
    this.jobEngine.start();
    this._openStratum(poolCfg.stratumPort||3333);
    if (!this.registry.bonusLedger)
      this.registry.bonusLedger = new BonusLedger(this.registry, poolCfg.bonus || {});
    this.registry.bonusLedger.registerPool(this.poolId, this.payout);
    if (poolCfg.cpuMining?.enabled) this._startCpuMiner(poolCfg);
    this.registry.emit('pool:started',{coin:poolCfg.coin});
  },

  _startCpuMiner(config) {
    if (this.cpuMiner) { this.cpuMiner.stop(); this.cpuMiner = null; }
    const cfg = config.cpuMining || {};
    this.cpuMiner   = new CpuMiner({
      threads:  cfg.threads  ?? os.cpus().length,
      throttle: cfg.throttle ?? 1.0,
      algo:     config.algo  || 'skein',
    });
    this.cpuSession = new CpuMinerSession(this);
    this.cpuMiner.on('found',    found => this.cpuSession.onFound(found));
    this.cpuMiner.on('hashrate', hr    => this.registry.emit('miner:hashrate', hr));
    const job = this.jobEngine?.currentJob;
    if (job) this.cpuMiner.start(job, this.cpuSession.extranonce1);
    console.log(`[pool] CPU miner: ${this.cpuMiner.threads} threads, throttle=${this.cpuMiner.throttle}`);
  },

  _stopCpuMiner() {
    this.cpuMiner?.stop();
    this.cpuMiner = null; this.cpuSession = null;
    console.log('[pool] CPU miner stopped');
  },

  _openStratum(port) {
    if (this.stratumServer){this.stratumServer.close();this.stratumServer=null;}
    this.stratumServer=net.createServer(socket=>{
      const session=new MinerSession(socket,this);
      this.miners.set(session.id,session);
      console.log(`[pool] miner+ ${socket.remoteAddress} (${this.miners.size} total)`);
    });
    this.stratumServer.listen(port,'0.0.0.0',()=>console.log(`[pool] stratum :${port}`));
  },

  _broadcastJob(job) {
    let sent=0;
    for(const m of this.miners.values()) if(m.authorized){m.sendJob(job,job.cleanJobs);sent++;}
    if(sent) console.log(`[pool:jobs] broadcast ${job.jobId} → ${sent} miners`);
  },

  removeMiner(id) {
    const m=this.miners.get(id);
    if(m){this.miners.delete(id);this.registry.emit('miner:disconnected',{id,user:m.user});}
  },

  get routes() {
    const sm=this.settings;
    return [
      ['GET', '/status', (req,res) => {
        const miners=this._minerList(); const job=this.jobEngine?.currentJob; const active=sm.getActivePool();
        const cpuInfo = this.cpuMiner ? {running:this.cpuMiner.isRunning,threads:this.cpuMiner.threads,throttle:this.cpuMiner.throttle} : null;
        _json(res,{active:active?.id??null,coin:this.activeConfig?.coin,algo:this.activeConfig?.algo,
          height:job?.height??null,miners:miners.length,hashrate:miners.reduce((s,m)=>s+m.hashrate,0),
          blocksFound:this.payout?.getStats().blocksFound??0,
          rewardAddress:this.activeConfig?.blockRewardAddress??null,
          rewardScript:this.jobEngine?._rewardScript??null,
          cpuMiner:cpuInfo, miners_list:miners});
      }],
      ['GET',  '/miners', (req,res)=>_json(res,this._minerList())],
      ['GET',  '/payout', (req,res)=>_json(res,this.payout?.getStats()??{})],
      ['GET',  '/job',    (req,res)=>{ const job=this.jobEngine?.currentJob; res.writeHead(job?200:503,{'Content-Type':'application/json'}); res.end(JSON.stringify(job?{jobId:job.jobId,height:job.height,nbits:job.nbits,ntime:job.ntime,target:job.target}:{error:'no job'})); }],
      ['GET',  '/node',   async(req,res)=>{ try{const[net,mine]=await Promise.all([this.rpc.getNetworkInfo(),this.rpc.getMiningInfo()]);_json(res,{network:net,mining:mine});}catch(err){res.writeHead(503);res.end(JSON.stringify({error:err.message}));} }],
      ['POST', '/job/new',(req,res)=>{ this.jobEngine?.forceNewJob(); _json(res,{ok:true}); }],

      // ── CPU miner controls ─────────────────────────────────────────────────
      ['POST', '/cpu-miner/start', async(req,res) => {
        const body=await _body(req); let cfg={}; try{cfg=JSON.parse(body);}catch{}
        if (!this.activeConfig) return _400(res,'pool not configured');
        this._startCpuMiner({...this.activeConfig,cpuMining:{enabled:true,...cfg}});
        _json(res,{ok:true,threads:this.cpuMiner.threads,throttle:this.cpuMiner.throttle});
      }],
      ['POST', '/cpu-miner/stop',  (req,res) => { this._stopCpuMiner(); _json(res,{ok:true}); }],
      ['PATCH', '/cpu-miner', async(req,res) => {
        const body=await _body(req);
        try {
          const{threads,throttle}=JSON.parse(body);
          if(!this.cpuMiner)return _400(res,'CPU miner not running');
          if(threads!==undefined)this.cpuMiner.setThreads(Number(threads));
          if(throttle!==undefined)this.cpuMiner.setThrottle(Number(throttle));
          _json(res,{ok:true,threads:this.cpuMiner.threads,throttle:this.cpuMiner.throttle});
        }catch(e){_400(res,e.message);}
      }],
      ['GET', '/cpu-miner', (req,res) => {
        if(!this.cpuMiner)return _json(res,{running:false});
        _json(res,{running:this.cpuMiner.isRunning,threads:this.cpuMiner.threads,throttle:this.cpuMiner.throttle,algo:this.cpuMiner.algo});
      }],

      // ── Bonus ledger ─────────────────────────────────────────────────────
      ['GET', '/bonus', (req,res) => {
        const ledger = this.registry.bonusLedger;
        _json(res, ledger ? ledger.getStats() : {error:'bonus ledger not initialised'});
      }],

      // ── Address & settings ─────────────────────────────────────────────────
      ['POST', '/reward-address', async(req,res) => {
        const body=await _body(req);
        try {
          const{address}=JSON.parse(body); if(!address)return _400(res,'address required');
          const coinDef=this.activeConfig?._coinDef||{id:this.activeConfig?.coin};
          if(!this.jobEngine)return _400(res,'job engine not running');
          const ok=this.jobEngine.updateRewardAddress(address,coinDef);
          if(!ok)return _400(res,'invalid address — check logs');
          if(this.activeConfig)this.activeConfig.blockRewardAddress=address;
          _json(res,{ok:true,address,script:this.jobEngine._rewardScript});
        }catch(e){_400(res,e.message);}
      }],
      ['POST', '/validate-address', async(req,res) => {
        const body=await _body(req);
        try{const{address,coin}=JSON.parse(body);_json(res,validateAddress(address,{id:coin||this.activeConfig?.coin||'dgb'}));}catch(e){_400(res,e.message);}
      }],
      ['GET',    '/settings/pools',                        (req,res)=>_json(res,sm.listPools())],
      ['GET',    '/settings/pools/:id',                    (req,res)=>{const p=sm.getPool(req.params.id);p?_json(res,p):_404(res);}],
      ['POST',   '/settings/pools',                        async(req,res)=>{const b=await _body(req);try{const p=sm.registerPool(JSON.parse(b));res.writeHead(201,{'Content-Type':'application/json'});res.end(JSON.stringify(p));}catch(e){_400(res,e.message);}}],
      ['PATCH',  '/settings/pools/:id',                    async(req,res)=>{const b=await _body(req);try{_json(res,sm.updatePool(req.params.id,JSON.parse(b)));}catch(e){_400(res,e.message);}}],
      ['DELETE', '/settings/pools/:id',                    (req,res)=>{try{sm.deletePool(req.params.id);_json(res,{ok:true});}catch(e){_400(res,e.message);}}],
      ['POST',   '/settings/active',                       async(req,res)=>{const b=await _body(req);try{const{poolId}=JSON.parse(b);sm.setActivePool(poolId);_json(res,{ok:true,activePool:poolId});}catch(e){_400(res,e.message);}}],
      ['GET',    '/settings/pools/:id/monetization',       (req,res)=>{try{_json(res,sm.getMonetizationOptions(req.params.id));}catch(e){_400(res,e.message);}}],
      ['POST',   '/settings/pools/:id/monetization/:type', async(req,res)=>{const b=await _body(req);try{const{enabled,config}=JSON.parse(b);_json(res,sm.setMonetization(req.params.id,req.params.type,enabled,config||{}));}catch(e){_400(res,e.message);}}],
      ['GET',    '/settings/monetization-types',           (req,res)=>_json(res,Object.values(MONETIZATION_TYPES).map(t=>({id:t.id,label:t.label,description:t.description,settings:Object.fromEntries(Object.entries(t.settings).map(([k,s])=>[k,{...s,options:typeof s.options==='function'?[]:s.options}]))})))],

      // ── Wallet routes (generate, import, export, setActive, delete) ────────
      ...walletRoutes(walletManager),
    ];
  },

  _minerList(){
    return [...this.miners.values()].map(m=>({id:m.id,user:m.user,authorized:m.authorized,difficulty:m.difficulty,shares:m.shares,accepted:m.accepted,rejected:m.rejected,hashrate:Math.round(m.hashrate),connectedAt:m.connectedAt}));
  }
};

function _json(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}
function _404(res){res.writeHead(404);res.end(JSON.stringify({error:'not found'}));}
function _400(res,msg){res.writeHead(400);res.end(JSON.stringify({error:msg}));}
function _body(req){return new Promise(r=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>r(b));});}

export default Pool;
