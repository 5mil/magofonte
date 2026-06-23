'use strict';
/**
 * pool/algos/sha256d.js
 * SHA256d — double SHA256.
 * Used by: Bitcoin, DigiByte (sha256d algo), many others.
 * This is the simplest algo: SHA256(SHA256(data)).
 */

const crypto = require('crypto');

/**
 * sha256d(data) → Buffer(32)
 */
function sha256d(data) {
  if (!Buffer.isBuffer(data)) data = Buffer.from(data, 'hex');
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(data).digest()
  ).digest();
}

/**
 * sha256dHash(header80) → Buffer(32)
 * Alias for pool compatibility — same as sha256d.
 */
const sha256dHash = sha256d;

/**
 * meetsTarget(hash, targetBuf) → bool
 * Returns true if hash (Buffer, little-endian) is below target.
 */
function meetsTarget(hash, targetBuf) {
  // Compare reversed (big-endian) for difficulty check
  const h = Buffer.from(hash).reverse();
  const t = Buffer.from(targetBuf).reverse();
  return h.compare(t) <= 0;
}

module.exports = { sha256d, sha256dHash, meetsTarget };
