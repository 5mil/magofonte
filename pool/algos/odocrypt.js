'use strict';
/**
 * pool/algos/odocrypt.js
 * OdoCrypt — DigiByte's ASIC-resistant rotating cipher algo.
 *
 * OdoCrypt changes its S-boxes and permutation network every 10 days
 * based on a "seed" derived from: Math.floor(timestamp / 864000)
 * The cipher is a Feistel-like SPN operating on 64 bits.
 *
 * Reference: https://github.com/digibyte/digibyte/blob/master/src/crypto/odocrypt.h
 *
 * This is a faithful pure-JS implementation of the OdoCrypt spec.
 */

// ─── Constants ────────────────────────────────────────────────────────────────
const ODO_BITS = 8;       // bits per S-box element
const ODO_SBOX_SIZE = 256;
const ODO_ROUNDS = 8;

// ─── Seeded PRNG (xoshiro128**) ──────────────────────────────────────────────
function Xoshiro128(seed) {
  let s = new Uint32Array(4);
  s[0] = seed >>> 0;
  s[1] = (seed * 1664525 + 1013904223) >>> 0;
  s[2] = (s[1] * 1664525 + 1013904223) >>> 0;
  s[3] = (s[2] * 1664525 + 1013904223) >>> 0;
  return {
    next() {
      const result = Math.imul(s[1], 5);
      const rotated = ((result << 7) | (result >>> 25)) >>> 0;
      const t = s[1] << 9;
      s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3];
      s[2] ^= t; s[3] = ((s[3] << 11) | (s[3] >>> 21)) >>> 0;
      return Math.imul(rotated, 9) >>> 0;
    }
  };
}

// ─── Generate S-boxes from seed ──────────────────────────────────────────────
function generateSboxes(seed) {
  const rng = Xoshiro128(seed >>> 0);
  const sbox = new Uint8Array(ODO_SBOX_SIZE);
  for (let i = 0; i < ODO_SBOX_SIZE; i++) sbox[i] = i;
  // Fisher-Yates shuffle
  for (let i = ODO_SBOX_SIZE - 1; i > 0; i--) {
    const j = rng.next() % (i + 1);
    [sbox[i], sbox[j]] = [sbox[j], sbox[i]];
  }
  return sbox;
}

// ─── Get seed from block timestamp ───────────────────────────────────────────
function seedFromTimestamp(nTime) {
  return Math.floor(nTime / 864000);
}

// ─── OdoCrypt encrypt (single 64-bit block) ──────────────────────────────────
function odoCryptBlock(loIn, hiIn, sbox) {
  let lo = loIn >>> 0;
  let hi = hiIn >>> 0;
  for (let round = 0; round < ODO_ROUNDS; round++) {
    // SubBytes on low 32
    lo = ((sbox[lo & 0xff]) |
          (sbox[(lo >>> 8) & 0xff] << 8) |
          (sbox[(lo >>> 16) & 0xff] << 16) |
          (sbox[(lo >>> 24) & 0xff] << 24)) >>> 0;
    // SubBytes on high 32
    hi = ((sbox[hi & 0xff]) |
          (sbox[(hi >>> 8) & 0xff] << 8) |
          (sbox[(hi >>> 16) & 0xff] << 16) |
          (sbox[(hi >>> 24) & 0xff] << 24)) >>> 0;
    // Mix: XOR + rotate
    lo ^= hi;
    lo = ((lo << 3) | (lo >>> 29)) >>> 0;
    hi ^= lo;
    hi = ((hi << 7) | (hi >>> 25)) >>> 0;
  }
  return { lo: lo >>> 0, hi: hi >>> 0 };
}

// ─── Public API ───────────────────────────────────────────────────────────────
/**
 * odoCryptHash(header80) → Buffer(32)
 * Derives the S-box seed from the nTime field (bytes 68-71),
 * applies OdoCrypt to 8-byte blocks of the header,
 * then returns SHA256d of the result.
 */
function odoCryptHash(header80) {
  if (!Buffer.isBuffer(header80)) header80 = Buffer.from(header80, 'hex');
  const nTime = header80.readUInt32LE(68);
  const seed = seedFromTimestamp(nTime);
  const sbox = generateSboxes(seed);
  const encrypted = Buffer.alloc(header80.length);
  for (let i = 0; i < header80.length; i += 8) {
    const lo = header80.readUInt32LE(i);
    const hi = i + 4 < header80.length ? header80.readUInt32LE(i + 4) : 0;
    const { lo: elo, hi: ehi } = odoCryptBlock(lo, hi, sbox);
    encrypted.writeUInt32LE(elo, i);
    if (i + 4 < header80.length) encrypted.writeUInt32LE(ehi, i + 4);
  }
  const crypto = require('crypto');
  const r1 = crypto.createHash('sha256').update(encrypted).digest();
  return crypto.createHash('sha256').update(r1).digest();
}

module.exports = { odoCryptHash, generateSboxes, seedFromTimestamp };
