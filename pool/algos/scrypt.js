'use strict';
/**
 * pool/algos/scrypt.js
 * Pure-JS Scrypt implementation for DGB Scrypt algo mining.
 * Used by: Litecoin, DigiByte (scrypt), many altcoins.
 *
 * Parameters (DGB/LTC standard):
 *   N = 1024, r = 1, p = 1, dkLen = 32
 */

const crypto = require('crypto');

// ─── PBKDF2-SHA256 (used internally) ─────────────────────────────────────────
function pbkdf2sha256(password, salt, c, dkLen) {
  let dk = Buffer.alloc(0);
  let i = 1;
  while (dk.length < dkLen) {
    let u = crypto.createHmac('sha256', password).update(salt).update(Buffer.from([0,0,0,i])).digest();
    let t = Buffer.from(u);
    for (let j = 1; j < c; j++) {
      u = crypto.createHmac('sha256', password).update(u).digest();
      for (let k = 0; k < t.length; k++) t[k] ^= u[k];
    }
    dk = Buffer.concat([dk, t]);
    i++;
  }
  return dk.slice(0, dkLen);
}

// ─── Salsa20/8 core ───────────────────────────────────────────────────────────
function salsa20_8(B) {
  const x = new Uint32Array(16);
  for (let i = 0; i < 16; i++) x[i] = B.readUInt32LE(i * 4);
  const z = new Uint32Array(x);
  for (let i = 0; i < 8; i += 2) {
    function R(a, b) { return (a << b) | (a >>> (32 - b)); }
    z[ 4] ^= R(z[ 0]+z[12],  7); z[ 8] ^= R(z[ 4]+z[ 0],  9);
    z[12] ^= R(z[ 8]+z[ 4], 13); z[ 0] ^= R(z[12]+z[ 8], 18);
    z[ 9] ^= R(z[ 5]+z[ 1],  7); z[13] ^= R(z[ 9]+z[ 5],  9);
    z[ 1] ^= R(z[13]+z[ 9], 13); z[ 5] ^= R(z[ 1]+z[13], 18);
    z[14] ^= R(z[10]+z[ 6],  7); z[ 2] ^= R(z[14]+z[10],  9);
    z[ 6] ^= R(z[ 2]+z[14], 13); z[10] ^= R(z[ 6]+z[ 2], 18);
    z[ 3] ^= R(z[15]+z[11],  7); z[ 7] ^= R(z[ 3]+z[15],  9);
    z[11] ^= R(z[ 7]+z[ 3], 13); z[15] ^= R(z[11]+z[ 7], 18);
    z[ 1] ^= R(z[ 0]+z[ 3],  7); z[ 2] ^= R(z[ 1]+z[ 0],  9);
    z[ 3] ^= R(z[ 2]+z[ 1], 13); z[ 0] ^= R(z[ 3]+z[ 2], 18);
    z[ 6] ^= R(z[ 5]+z[ 4],  7); z[ 7] ^= R(z[ 6]+z[ 5],  9);
    z[ 4] ^= R(z[ 7]+z[ 6], 13); z[ 5] ^= R(z[ 4]+z[ 7], 18);
    z[11] ^= R(z[10]+z[ 9],  7); z[ 8] ^= R(z[11]+z[10],  9);
    z[ 9] ^= R(z[ 8]+z[11], 13); z[10] ^= R(z[ 9]+z[ 8], 18);
    z[12] ^= R(z[15]+z[14],  7); z[13] ^= R(z[12]+z[15],  9);
    z[14] ^= R(z[13]+z[12], 13); z[15] ^= R(z[14]+z[13], 18);
  }
  const out = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) out.writeUInt32LE((x[i] + z[i]) >>> 0, i * 4);
  return out;
}

// ─── BlockMix ─────────────────────────────────────────────────────────────────
function blockMix(B, r) {
  const blocks = 2 * r;
  const bsize = 64;
  let X = B.slice((blocks - 1) * bsize, blocks * bsize);
  const Y = [];
  for (let i = 0; i < blocks; i++) {
    const bi = B.slice(i * bsize, (i + 1) * bsize);
    const xored = Buffer.alloc(bsize);
    for (let j = 0; j < bsize; j++) xored[j] = X[j] ^ bi[j];
    X = salsa20_8(xored);
    Y.push(Buffer.from(X));
  }
  const out = Buffer.alloc(blocks * bsize);
  for (let i = 0; i < r; i++) Y[i * 2].copy(out, i * bsize);
  for (let i = 0; i < r; i++) Y[i * 2 + 1].copy(out, (r + i) * bsize);
  return out;
}

// ─── ROMix ────────────────────────────────────────────────────────────────────
function roMix(B, N, r) {
  const bsize = 128 * r;
  let X = Buffer.from(B);
  const V = [];
  for (let i = 0; i < N; i++) { V.push(Buffer.from(X)); X = blockMix(X, r); }
  for (let i = 0; i < N; i++) {
    const j = X.readUInt32LE((2 * r - 1) * 64) % N;
    const T = Buffer.alloc(bsize);
    for (let k = 0; k < bsize; k++) T[k] = X[k] ^ V[j][k];
    X = blockMix(T, r);
  }
  return X;
}

// ─── Public API ───────────────────────────────────────────────────────────────
/**
 * scrypt(password, salt, N, r, p, dkLen) → Buffer
 * Standard parameters for DGB/LTC: N=1024, r=1, p=1, dkLen=32
 */
function scrypt(password, salt, N = 1024, r = 1, p = 1, dkLen = 32) {
  if (!Buffer.isBuffer(password)) password = Buffer.from(password);
  if (!Buffer.isBuffer(salt)) salt = Buffer.from(salt);
  const bsize = 128 * r;
  const B = pbkdf2sha256(password, salt, 1, p * bsize);
  const blocks = [];
  for (let i = 0; i < p; i++) blocks.push(roMix(B.slice(i * bsize, (i + 1) * bsize), N, r));
  return pbkdf2sha256(password, Buffer.concat(blocks), 1, dkLen);
}

/**
 * dgbScryptHash(header80) → Buffer(32)
 * Double-Scrypt: scrypt(scrypt(header)) — matches DGB Scrypt PoW
 */
function dgbScryptHash(header80) {
  if (!Buffer.isBuffer(header80)) header80 = Buffer.from(header80, 'hex');
  const first = scrypt(header80, header80, 1024, 1, 1, 32);
  return scrypt(first, first, 1024, 1, 1, 32);
}

module.exports = { scrypt, dgbScryptHash };
