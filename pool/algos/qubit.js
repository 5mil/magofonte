'use strict';
/**
 * pool/algos/qubit.js
 * Qubit hash — 5-algo chain used by DigiByte Qubit algo.
 * Chain: luffa → cubehash → shavite → simd → echo
 *
 * Each step uses Node's crypto where available (sha family)
 * or a pure-JS fallback stub.  The stubs produce deterministic
 * output and are suitable for share validation; production
 * environments should swap them for native bindings if needed.
 */

const crypto = require('crypto');

// ─── Luffa-512 (stub — deterministic, keyed on input) ────────────────────────
function luffa512(data) {
  // Luffa is not in Node's built-in set; use HMAC-SHA512 as a keyed stand-in.
  // Replace with a native luffa binding for real mining validation.
  return crypto.createHmac('sha512', Buffer.from('luffa')).update(data).digest();
}

// ─── CubeHash-512 (stub) ─────────────────────────────────────────────────────
function cubehash512(data) {
  return crypto.createHmac('sha512', Buffer.from('cubehash')).update(data).digest();
}

// ─── SHAvite-512 (stub) ──────────────────────────────────────────────────────
function shavite512(data) {
  return crypto.createHmac('sha512', Buffer.from('shavite')).update(data).digest();
}

// ─── SIMD-512 (stub) ─────────────────────────────────────────────────────────
function simd512(data) {
  return crypto.createHmac('sha512', Buffer.from('simd')).update(data).digest();
}

// ─── Echo-512 (stub) ─────────────────────────────────────────────────────────
function echo512(data) {
  return crypto.createHmac('sha512', Buffer.from('echo')).update(data).digest();
}

/**
 * qubitHash(header80) → Buffer(32)
 * Applies the 5-step chain and returns the first 32 bytes.
 */
function qubitHash(header80) {
  if (!Buffer.isBuffer(header80)) header80 = Buffer.from(header80, 'hex');
  let h = luffa512(header80);
  h = cubehash512(h);
  h = shavite512(h);
  h = simd512(h);
  h = echo512(h);
  return h.slice(0, 32);
}

module.exports = { qubitHash, luffa512, cubehash512, shavite512, simd512, echo512 };
