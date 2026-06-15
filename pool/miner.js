/**
 * pool/miner.js
 *
 * CPU miner for MagoFonte — runs entirely inside Node.js worker_threads.
 * No native addons. No external packages. Uses pool/skein.js directly.
 *
 * Architecture:
 *   CpuMiner (main thread)
 *     ├─ Worker thread 0  (cores[0])
 *     ├─ Worker thread 1  (cores[1])
 *     └─ Worker thread N  (one per logical CPU)
 *
 * Each worker receives a job (header template + nonce range) and searches
 * for a nonce whose Skein hash meets the network target. When found it
 * posts { type:'found', nonce, hashHex } back to the main thread.
 *
 * Job distribution:
 *   The 32-bit nonce space (0x00000000–0xffffffff) is split into equal
 *   ranges per worker. If none find a solution the miner asks for a new
 *   job (new extranonce2) and tries again.
 *
 * Exports:
 *   CpuMiner  — EventEmitter
 *     .start(job, extranonce1)   begin mining a job
 *     .stop()                    stop all workers
 *     .setThreads(n)             resize pool (restarts if mining)
 *     events:
 *       'found'   { nonce, extranonce2, hashHex, jobId }
 *       'hashrate' { hashes, elapsed, rate }  emitted every ~5 s
 *
 * The caller (Pool module) receives 'found' and submits the share
 * exactly as if an external miner had submitted it via Stratum.
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import os              from 'node:os';
import crypto         from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dblSkein512 } from './skein.js';

const __filename = fileURLToPath(import.meta.url);

// ────────────────────────────────────────────────────────────────
// Worker thread code — runs when this file is loaded as a worker
// ────────────────────────────────────────────────────────────────

if (!isMainThread) {
  // ── Worker: receives messages from main thread, searches nonces ──
  //
  // Message types from main thread:
  //   { type: 'mine', job, nonceStart, nonceEnd, extranonce2 }
  //   { type: 'stop' }
  //
  // Messages sent back to main thread:
  //   { type: 'found',    nonce, extranonce2, hashHex, jobId, hashes }
  //   { type: 'exhausted', extranonce2, hashes }  (entire range searched, no solution)
  //   { type: 'hashrate',  hashes, elapsed }

  let running  = false;
  let stopFlag = false;

  parentPort.on('message', msg => {
    if (msg.type === 'stop') {
      stopFlag = true; running = false;
      return;
    }
    if (msg.type === 'mine') {
      stopFlag = false;
      _mine(msg).catch(e => parentPort.postMessage({ type: 'error', message: e.message }));
    }
  });

  async function _mine({ job, nonceStart, nonceEnd, extranonce2 }) {
    running = true;
    const startTime = Date.now();
    let hashes = 0;

    // Build the partial header (everything except the last 4 bytes = nonce)
    // Header layout (80 bytes, all LE):
    //   [0..3]   version
    //   [4..35]  prevHash
    //   [36..67] merkleRoot
    //   [68..71] ntime
    //   [72..75] nbits
    //   [76..79] nonce   ← we iterate this
    const header = Buffer.alloc(80);
    Buffer.from(job.headerPrefix, 'hex').copy(header, 0);  // first 76 bytes

    const targetBuf = Buffer.from(job.target.padStart(64, '0'), 'hex');

    // Nonce loop — synchronous tight loop, yields to event loop every 10k hashes
    const BATCH = 10_000;
    let nonce = nonceStart;

    while (nonce <= nonceEnd && !stopFlag) {
      const batchEnd = Math.min(nonce + BATCH - 1, nonceEnd);

      for (let n = nonce; n <= batchEnd; n++) {
        // Write nonce as LE 32-bit
        header[76] =  n        & 0xff;
        header[77] = (n >>  8) & 0xff;
        header[78] = (n >> 16) & 0xff;
        header[79] = (n >> 24) & 0xff;

        const hashBuf = dblSkein512(header).slice(0, 32);
        hashes++;

        // Compare hash <= target (both big-endian byte strings)
        if (_lte(hashBuf, targetBuf)) {
          const hashHex = hashBuf.toString('hex');
          parentPort.postMessage({
            type: 'found',
            nonce: n,
            extranonce2,
            hashHex,
            jobId: job.jobId,
            hashes,
          });
          running = false;
          return;
        }
      }

      nonce = batchEnd + 1;

      // Yield to allow message processing between batches
      await new Promise(r => setImmediate(r));
    }

    parentPort.postMessage({ type: 'exhausted', extranonce2, hashes, elapsed: Date.now() - startTime });
    running = false;
  }

  // Compare two 32-byte Buffers: returns true if a <= b
  function _lte(a, b) {
    for (let i = 0; i < 32; i++) {
      if (a[i] < b[i]) return true;
      if (a[i] > b[i]) return false;
    }
    return true;  // equal
  }

  // Done — worker thread setup complete
}

// ────────────────────────────────────────────────────────────────
// Main thread — CpuMiner class
// ────────────────────────────────────────────────────────────────

export class CpuMiner extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} [opts.threads]       number of worker threads (default: all logical CPUs)
   * @param {number} [opts.throttle]      0.0–1.0 fraction of time spent mining (default: 1.0)
   * @param {string} [opts.algo]          hash algorithm (default: 'skein')
   */
  constructor(opts = {}) {
    super();
    this.threads  = opts.threads  || os.cpus().length;
    this.throttle = Math.max(0, Math.min(1, opts.throttle ?? 1.0));
    this.algo     = opts.algo || 'skein';
    this._workers = [];
    this._running = false;
    this._currentJob = null;
    this._extranonce1 = null;
    this._en2Counter  = 0;
    this._totalHashes = 0;
    this._hrStart     = Date.now();
    this._hrTimer     = null;
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Start mining a new job.
   * @param {object} job          Job object from JobEngine
   * @param {string} extranonce1  Pool-assigned extranonce1 (hex, 4 bytes = 8 chars)
   */
  start(job, extranonce1) {
    this._currentJob   = job;
    this._extranonce1  = extranonce1;
    this._en2Counter   = 0;
    this._running      = true;
    this._totalHashes  = 0;
    this._hrStart      = Date.now();

    this._spawnWorkers();
    this._dispatchAll();

    if (!this._hrTimer) {
      this._hrTimer = setInterval(() => this._reportHashrate(), 5_000);
    }
    console.log(`[miner] started — ${this._workers.length} threads, algo=${this.algo}, job=${job.jobId}`);
  }

  /** Stop all workers. */
  stop() {
    this._running = false;
    clearInterval(this._hrTimer);
    this._hrTimer = null;
    for (const w of this._workers) {
      try { w.postMessage({ type: 'stop' }); } catch {}
    }
    // Terminate workers cleanly after a tick
    setTimeout(() => {
      for (const w of this._workers) { try { w.terminate(); } catch {} }
      this._workers = [];
    }, 200);
    console.log('[miner] stopped');
  }

  /** Update to a new job without stopping workers (they get a new mine message). */
  newJob(job, extranonce1) {
    this._currentJob  = job;
    this._extranonce1 = extranonce1 ?? this._extranonce1;
    this._en2Counter  = 0;
    if (!this._running) return;
    // Signal all workers to stop their current search, then re-dispatch
    for (const w of this._workers) try { w.postMessage({ type: 'stop' }); } catch {}
    setTimeout(() => this._dispatchAll(), 50);
    console.log(`[miner] new job ${job.jobId} h=${job.height}`);
  }

  /** Resize thread count. Restarts if currently mining. */
  setThreads(n) {
    const wasRunning = this._running;
    const job = this._currentJob;
    const en1 = this._extranonce1;
    if (wasRunning) this.stop();
    this.threads = Math.max(1, Math.min(n, 64));
    if (wasRunning && job) setTimeout(() => this.start(job, en1), 300);
  }

  /** Set CPU throttle 0.0–1.0 (1.0 = full speed, 0.5 = ~50% CPU). */
  setThrottle(t) {
    this.throttle = Math.max(0.05, Math.min(1.0, t));
  }

  get isRunning() { return this._running; }

  // ── Internal ──────────────────────────────────────────────────────────

  _spawnWorkers() {
    // Terminate any existing workers first
    for (const w of this._workers) { try { w.terminate(); } catch {} }
    this._workers = [];

    for (let i = 0; i < this.threads; i++) {
      const w = new Worker(__filename);  // re-use this same file
      w.on('message', msg => this._onWorkerMsg(i, msg));
      w.on('error',   err => console.error(`[miner] worker ${i} error:`, err.message));
      w.on('exit',    code => { if (code !== 0) console.warn(`[miner] worker ${i} exited ${code}`); });
      this._workers.push(w);
    }
  }

  _dispatchAll() {
    if (!this._currentJob || !this._running) return;
    const job   = this._currentJob;
    const nonces = this._splitNonceSpace(this._workers.length);
    for (let i = 0; i < this._workers.length; i++) {
      this._dispatch(i, job, nonces[i]);
    }
  }

  _dispatch(workerIdx, job, { nonceStart, nonceEnd }) {
    const extranonce2 = pad32(this._en2Counter++);  // 4-byte hex
    const headerPrefix = this._buildHeaderPrefix(job, extranonce2);
    this._workers[workerIdx]?.postMessage({
      type: 'mine',
      job: {
        jobId:        job.jobId,
        headerPrefix, // 76 bytes (everything before nonce)
        target:       job.target,
      },
      nonceStart,
      nonceEnd,
      extranonce2,
    });
  }

  _onWorkerMsg(workerIdx, msg) {
    if (msg.type === 'found') {
      this._totalHashes += msg.hashes || 0;
      if (!this._running) return;
      console.log(`[miner] 🎉 FOUND nonce=0x${msg.nonce.toString(16).padStart(8,'0')} hash=${msg.hashHex.slice(0,16)}…`);
      this.emit('found', {
        nonce:       msg.nonce,
        nonceHex:    msg.nonce.toString(16).padStart(8, '0'),
        extranonce2: msg.extranonce2,
        hashHex:     msg.hashHex,
        jobId:       msg.jobId,
      });
    } else if (msg.type === 'exhausted') {
      this._totalHashes += msg.hashes || 0;
      if (!this._running || !this._currentJob) return;
      // Re-dispatch this worker with a new extranonce2 (rolls nonce space)
      const job    = this._currentJob;
      const nonces = this._splitNonceSpace(this._workers.length);
      this._dispatch(workerIdx, job, nonces[workerIdx]);
    } else if (msg.type === 'error') {
      console.error(`[miner] worker ${workerIdx}:`, msg.message);
    }
  }

  _buildHeaderPrefix(job, extranonce2) {
    // Assemble the first 76 bytes of the 80-byte block header.
    // The miner worker appends the 4-byte nonce as it iterates.
    //
    // Layout (all fields little-endian as per stratum):
    //   [0..3]   version   (4 bytes)
    //   [4..35]  prevHash  (32 bytes, already LE from JobEngine)
    //   [36..67] merkleRoot (32 bytes)
    //   [68..71] ntime     (4 bytes)
    //   [72..75] nbits     (4 bytes)
    //   [76..79] nonce     ← appended by worker

    const coinbaseBuf = Buffer.from(
      job.coinbase1 + this._extranonce1 + extranonce2 + job.coinbase2, 'hex'
    );
    let merkle = dblSha256(coinbaseBuf);
    for (const branch of job.merkleBranches)
      merkle = dblSha256(Buffer.concat([merkle, Buffer.from(branch, 'hex').reverse()]));
    const merkleRoot = merkle.reverse().toString('hex');

    return [
      hexToLE32(job.version),   // 4
      job.prevHash,             // 32 (already LE)
      hexToLE32(merkleRoot),    // 32
      hexToLE32(job.ntime),     // 4
      hexToLE32(job.nbits),     // 4
    ].join('');
  }

  _splitNonceSpace(n) {
    // Divide 0x00000000–0xffffffff into n equal ranges
    const total = 0x100000000;
    const chunk = Math.floor(total / n);
    return Array.from({ length: n }, (_, i) => ({
      nonceStart: i * chunk,
      nonceEnd:   i === n - 1 ? 0xffffffff : (i + 1) * chunk - 1,
    }));
  }

  _reportHashrate() {
    const elapsed = (Date.now() - this._hrStart) / 1000;
    if (elapsed < 1) return;
    const rate = this._totalHashes / elapsed;
    this.emit('hashrate', { hashes: this._totalHashes, elapsed, rate });
    const label = rate > 1000 ? `${(rate/1000).toFixed(2)} Kh/s` : `${rate.toFixed(0)} h/s`;
    console.log(`[miner] hashrate: ${label} over ${elapsed.toFixed(0)}s (${this._workers.length} threads)`);
  }
}

// ── Shared helpers (used by both main thread and workers) ───────────────────

function dblSha256(buf) {
  // Inline SHA256d — avoids importing crypto inside worker path
  // (workers use dblSkein512 directly; this is only called in main thread
  //  inside _buildHeaderPrefix for the merkle computation)
  const { createHash } = await_crypto();
  const h1 = createHash('sha256').update(buf).digest();
  return createHash('sha256').update(h1).digest();
}

// Lazy crypto import (synchronous in Node — always available)
function await_crypto() {
  return (await_crypto._c || (await_crypto._c = (() => { const c = {}; Object.assign(c, (() => { const {createHash} = (function(){ let _c; return () => _c || (_c = new Proxy({},{get:(_,k) => require_crypto()[k]})); })()(); return {createHash:(...a)=>require_crypto().createHash(...a)}; })()); return require_crypto(); })));
}
// Actually, Node crypto is always available synchronously in ESM:
import _crypto from 'node:crypto';
function _sha256d(buf) {
  const h1 = _crypto.createHash('sha256').update(buf).digest();
  return _crypto.createHash('sha256').update(h1).digest();
}
// Override the broken helper above:
Object.defineProperty(globalThis, '__miner_dblSha256', { value: _sha256d });

// Replace the broken dblSha256 reference in _buildHeaderPrefix:
// (We redefine cleanly here — the function above is unreachable)
CpuMiner.prototype._buildHeaderPrefix = function(job, extranonce2) {
  const coinbaseBuf = Buffer.from(
    job.coinbase1 + this._extranonce1 + extranonce2 + job.coinbase2, 'hex'
  );
  let merkle = _sha256d(coinbaseBuf);
  for (const branch of job.merkleBranches)
    merkle = _sha256d(Buffer.concat([merkle, Buffer.from(branch, 'hex').reverse()]));
  const merkleRoot = merkle.reverse().toString('hex');
  return [
    hexToLE32(job.version),
    job.prevHash,
    hexToLE32(merkleRoot),
    hexToLE32(job.ntime),
    hexToLE32(job.nbits),
  ].join('');
};

function hexToLE32(hex) {
  return hex.match(/.{8}/g).map(b => b.match(/.{2}/g).reverse().join('')).join('');
}

function pad32(n) {
  return n.toString(16).padStart(8, '0');
}
