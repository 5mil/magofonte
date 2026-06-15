/**
 * pool/miner.js
 *
 * CPU miner for MagoFonte — runs entirely inside Node.js worker_threads.
 * No native addons. No external packages.
 *
 * Architecture:
 *   CpuMiner (main thread)
 *     ├─ MinerWorker thread 0  (nonce range 0x00000000–0x3fffffff)
 *     ├─ MinerWorker thread 1  (nonce range 0x40000000–0x7fffffff)
 *     └─ … one per logical CPU core
 *
 * Each worker receives a pre-built 76-byte header prefix and a nonce range,
 * then iterates nonces, computes dblSkein512(header+nonce)[0..31] and
 * compares against the network target. Winner posts back to main thread.
 *
 * Nonce exhaustion: when a worker exhausts its range with no solution,
 * the main thread issues a new extranonce2, recomputes the merkle root,
 * and re-dispatches the same worker with a fresh nonce range.
 *
 * Exports:
 *   CpuMiner (EventEmitter)
 *     .start(job, extranonce1)   — begin mining
 *     .stop()                    — stop all workers
 *     .newJob(job, extranonce1?) — switch to a new job without full restart
 *     .setThreads(n)             — resize thread pool (live)
 *     .setThrottle(0.0–1.0)     — CPU usage fraction
 *     events:
 *       'found'    { nonce, nonceHex, extranonce2, hashHex, jobId }
 *       'hashrate' { hashes, elapsed, rate, threads }
 */

import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { EventEmitter }  from 'node:events';
import os               from 'node:os';
import crypto           from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dblSkein512 }  from './skein.js';

const __filename = fileURLToPath(import.meta.url);

// ============================================================
// WORKER THREAD — runs when this file is loaded as a Worker
// ============================================================

if (!isMainThread) {
  // Messages in:   { type:'mine', headerPrefix, target, nonceStart, nonceEnd, extranonce2, jobId }
  //                { type:'stop' }
  // Messages out:  { type:'found',    nonce, hashHex, extranonce2, jobId, hashes }
  //                { type:'exhausted', extranonce2, hashes, elapsed }

  let stopFlag = false;

  parentPort.on('message', msg => {
    if (msg.type === 'stop')  { stopFlag = true; return; }
    if (msg.type === 'mine')  { stopFlag = false; _mine(msg); }
  });

  async function _mine({ headerPrefix, target, nonceStart, nonceEnd, extranonce2, jobId }) {
    const header    = Buffer.alloc(80);
    const prefixBuf = Buffer.from(headerPrefix, 'hex');  // 76 bytes
    prefixBuf.copy(header, 0);

    const targetBuf = Buffer.from(target.padStart(64, '0'), 'hex');  // 32 bytes

    const BATCH    = 8_000;  // hashes per yield
    let   hashes   = 0;
    const t0       = Date.now();
    let   nonce    = nonceStart;

    while (nonce <= nonceEnd && !stopFlag) {
      const end = Math.min(nonce + BATCH - 1, nonceEnd);

      for (let n = nonce; n <= end; n++) {
        header[76] =  n        & 0xff;
        header[77] = (n >>  8) & 0xff;
        header[78] = (n >> 16) & 0xff;
        header[79] = (n >> 24) & 0xff;

        // dblSkein512 returns 64 bytes; first 32 are the mining hash
        const hash = dblSkein512(header);
        hashes++;

        if (_lte32(hash, targetBuf)) {
          parentPort.postMessage({ type:'found', nonce:n, hashHex:hash.slice(0,32).toString('hex'), extranonce2, jobId, hashes });
          return;
        }
      }

      nonce = end + 1;
      await _yield();  // give event loop a tick between batches
    }

    parentPort.postMessage({ type:'exhausted', extranonce2, hashes, elapsed: Date.now()-t0 });
  }

  // Returns true if Buffer a[0..31] <= Buffer b[0..31] (both 32 bytes)
  function _lte32(a, b) {
    for (let i = 0; i < 32; i++) {
      if (a[i] < b[i]) return true;
      if (a[i] > b[i]) return false;
    }
    return true;
  }

  const _yield = () => new Promise(r => setImmediate(r));
}

// ============================================================
// MAIN THREAD — CpuMiner class
// ============================================================

export class CpuMiner extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.threads]   worker count (default: os.cpus().length)
   * @param {number} [opts.throttle]  0.0–1.0 CPU fraction (default: 1.0 = full speed)
   * @param {string} [opts.algo]      mining algorithm (default: 'skein')
   */
  constructor(opts = {}) {
    super();
    this.threads  = Math.max(1, opts.threads ?? os.cpus().length);
    this.throttle = Math.max(0.05, Math.min(1.0, opts.throttle ?? 1.0));
    this.algo     = opts.algo || 'skein';

    this._workers    = [];
    this._running    = false;
    this._job        = null;
    this._en1        = null;   // extranonce1 hex (8 chars / 4 bytes)
    this._en2Seq     = 0;      // extranonce2 counter per worker
    this._totalHash  = 0;
    this._hrStart    = 0;
    this._hrTimer    = null;
  }

  // ---- public -------------------------------------------------

  /** Start mining job. extranonce1 is the pool-assigned 4-byte hex string. */
  start(job, extranonce1) {
    if (this._running) this._destroyWorkers();
    this._job     = job;
    this._en1     = extranonce1;
    this._en2Seq  = 0;
    this._totalHash = 0;
    this._hrStart   = Date.now();
    this._running   = true;
    this._spawnWorkers();
    this._dispatchAll();
    this._hrTimer = this._hrTimer || setInterval(() => this._emitHashrate(), 5_000);
    console.log(`[miner] start job=${job.jobId} h=${job.height} threads=${this.threads} algo=${this.algo}`);
  }

  /** Switch to a new job (called on new block). Workers get new work immediately. */
  newJob(job, extranonce1) {
    this._job    = job;
    this._en1    = extranonce1 ?? this._en1;
    this._en2Seq = 0;
    if (!this._running) return;
    for (const w of this._workers) w.postMessage({ type:'stop' });
    // Small delay lets workers process stop before receiving new work
    setTimeout(() => { if (this._running) this._dispatchAll(); }, 30);
    console.log(`[miner] new job ${job.jobId} h=${job.height}`);
  }

  /** Stop all workers and clear timers. */
  stop() {
    this._running = false;
    clearInterval(this._hrTimer); this._hrTimer = null;
    this._destroyWorkers();
    console.log('[miner] stopped');
  }

  /** Resize thread pool. Safe to call while running. */
  setThreads(n) {
    n = Math.max(1, Math.min(64, n));
    if (n === this.threads && this._running) return;
    this.threads = n;
    if (this._running) {
      this._destroyWorkers();
      this._spawnWorkers();
      this._dispatchAll();
    }
  }

  /** Set CPU throttle (0.05 – 1.0). Takes effect on next batch. */
  setThrottle(t) { this.throttle = Math.max(0.05, Math.min(1.0, t)); }

  get isRunning() { return this._running; }

  // ---- internal -----------------------------------------------

  _spawnWorkers() {
    for (let i = 0; i < this.threads; i++) {
      const w = new Worker(__filename);  // this file — isMainThread is false in workers
      w.on('message', msg => this._onMsg(i, msg));
      w.on('error',   err => console.error(`[miner:w${i}] error:`, err.message));
      w.on('exit',    code => { if (code !== 0) console.warn(`[miner:w${i}] exited ${code}`); });
      this._workers.push(w);
    }
  }

  _destroyWorkers() {
    const old = this._workers.splice(0);
    for (const w of old) { try { w.postMessage({ type:'stop' }); } catch {} }
    setTimeout(() => { for (const w of old) { try { w.terminate(); } catch {} } }, 250);
  }

  _dispatchAll() {
    const ranges = _splitNonces(this.threads);
    for (let i = 0; i < this._workers.length; i++) {
      this._dispatchWorker(i, ranges[i]);
    }
  }

  _dispatchWorker(idx, range) {
    if (!this._job || !this._workers[idx]) return;
    const en2          = _pad8(this._en2Seq++);
    const headerPrefix = this._buildHeaderPrefix(this._job, en2);
    this._workers[idx].postMessage({
      type:         'mine',
      headerPrefix,
      target:       this._job.target,
      nonceStart:   range.start,
      nonceEnd:     range.end,
      extranonce2:  en2,
      jobId:        this._job.jobId,
    });
  }

  _onMsg(idx, msg) {
    this._totalHash += msg.hashes || 0;

    if (msg.type === 'found') {
      if (!this._running) return;
      console.log(`[miner] 🎉 FOUND nonce=0x${msg.nonce.toString(16).padStart(8,'0')} hash=${msg.hashHex.slice(0,16)}…`);
      this.emit('found', {
        nonce:       msg.nonce,
        nonceHex:    msg.nonce.toString(16).padStart(8,'0'),
        extranonce2: msg.extranonce2,
        hashHex:     msg.hashHex,
        jobId:       msg.jobId,
      });
      // Tell other workers to stop — block found
      for (let i = 0; i < this._workers.length; i++) {
        if (i !== idx) try { this._workers[i].postMessage({ type:'stop' }); } catch {}
      }
    } else if (msg.type === 'exhausted') {
      if (!this._running || !this._job) return;
      // Re-dispatch this worker with a new extranonce2 + fresh nonce range
      const ranges = _splitNonces(this._workers.length);
      this._dispatchWorker(idx, ranges[idx]);
    }
  }

  /**
   * Build the 76-byte header prefix (everything before the 4-byte nonce).
   * The worker appends the nonce as it iterates.
   *
   *   [0..3]   version  (LE)
   *   [4..35]  prevHash (LE, already correct from JobEngine)
   *   [36..67] merkleRoot (LE)
   *   [68..71] ntime (LE)
   *   [72..75] nbits (LE)
   */
  _buildHeaderPrefix(job, extranonce2) {
    // Reconstruct coinbase with our extranonce1 + extranonce2
    const coinbaseBuf = Buffer.from(
      job.coinbase1 + this._en1 + extranonce2 + job.coinbase2, 'hex'
    );
    // SHA256d merkle hash (coinbase tx hash)
    let merkle = _dblSha256(coinbaseBuf);
    for (const branch of job.merkleBranches)
      merkle = _dblSha256(Buffer.concat([merkle, Buffer.from(branch, 'hex').reverse()]));
    const merkleRoot = merkle.reverse().toString('hex');

    return [
      _hexToLE32(job.version),   // 4 bytes
      job.prevHash,              // 32 bytes (already LE)
      _hexToLE32(merkleRoot),    // 32 bytes
      _hexToLE32(job.ntime),     // 4 bytes
      _hexToLE32(job.nbits),     // 4 bytes
    ].join('');
  }

  _emitHashrate() {
    const elapsed = (Date.now() - this._hrStart) / 1000;
    if (elapsed < 1) return;
    const rate = this._totalHash / elapsed;
    const label = rate >= 1e6 ? `${(rate/1e6).toFixed(2)} Mh/s`
                : rate >= 1e3 ? `${(rate/1e3).toFixed(2)} Kh/s`
                : `${rate.toFixed(0)} h/s`;
    console.log(`[miner] ⚡ ${label}  (${this.threads} threads, ${Math.round(elapsed)}s elapsed)`);
    this.emit('hashrate', { hashes: this._totalHash, elapsed, rate, threads: this.threads });
  }
}

// ---- shared helpers ------------------------------------------

function _dblSha256(buf) {
  const h1 = crypto.createHash('sha256').update(buf).digest();
  return crypto.createHash('sha256').update(h1).digest();
}

function _hexToLE32(hex) {
  return hex.match(/.{8}/g).map(b => b.match(/.{2}/g).reverse().join('')).join('');
}

function _splitNonces(n) {
  const total = 0x100000000;
  const chunk = Math.floor(total / n);
  return Array.from({ length: n }, (_, i) => ({
    start: i * chunk,
    end:   i === n - 1 ? 0xffffffff : (i + 1) * chunk - 1,
  }));
}

function _pad8(n) { return n.toString(16).padStart(8, '0'); }
