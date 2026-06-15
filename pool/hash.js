/**
 * pool/hash.js
 *
 * Algorithm dispatcher — routes a block header to the correct
 * hash function based on the pool's algo field.
 *
 * DGB supports five algorithms. Each uses a different hash:
 *
 *   skein     → dblSkein512   (this file handles)
 *   sha256d   → SHA256d       (Bitcoin-style)
 *   scrypt    → scrypt        (not implemented here — needs addon)
 *   qubit     → qubit chain   (not implemented here)
 *   odo       → OdoCrypt      (not implemented here)
 *
 * Returns a 32-byte Buffer (the "mining hash") that is compared
 * against the target/difficulty.
 *
 * The 80-byte block header for stratum is assembled by ShareValidator:
 *   version(4) + prevhash(32) + merkleroot(32) + ntime(4) + bits(4) + nonce(4)
 * All fields are big-endian as transmitted by stratum, then byte-reversed
 * into the internal LE representation before hashing.
 *
 * Exports:
 *   hashHeader(headerBuf, algo)  → Buffer (32 bytes, big-endian hash)
 *   SUPPORTED_ALGOS              → Set of algo id strings
 */

import crypto                        from 'node:crypto';
import { dblSkein512 }               from './skein.js';

export const SUPPORTED_ALGOS = new Set(['skein', 'sha256d', 'scrypt', 'qubit', 'odo']);

/**
 * Hash an 80-byte block header with the given algorithm.
 *
 * @param {Buffer} headerBuf  Raw 80-byte block header (as built by ShareValidator)
 * @param {string} algo       Algorithm id: 'skein' | 'sha256d' | ...
 * @returns {Buffer}          32-byte hash, big-endian (for target comparison)
 */
export function hashHeader(headerBuf, algo) {
  switch (algo) {

    case 'skein': {
      // DGB Skein: double-Skein-512(header), take first 32 bytes
      // Full 64-byte output is computed; network target is compared
      // against the first 32 bytes (big-endian).
      const full = dblSkein512(headerBuf);
      // Reverse bytes for big-endian display / comparison
      // (Skein output is already in the mining byte order for DGB)
      return full.slice(0, 32);
    }

    case 'sha256d':
    default: {
      // Standard Bitcoin double-SHA256
      const h1 = crypto.createHash('sha256').update(headerBuf).digest();
      return crypto.createHash('sha256').update(h1).digest();
    }

    // scrypt, qubit, odo — stubs that fall back to sha256d
    // Replace with proper implementations if mining those algos
    case 'scrypt':
    case 'qubit':
    case 'odo': {
      console.warn(`[hash] algo '${algo}' not fully implemented — falling back to sha256d`);
      const h1 = crypto.createHash('sha256').update(headerBuf).digest();
      return crypto.createHash('sha256').update(h1).digest();
    }
  }
}

/**
 * Convenience: hash and return hex string (big-endian, 64 chars).
 */
export function hashHeaderHex(headerBuf, algo) {
  return hashHeader(headerBuf, algo).toString('hex');
}
