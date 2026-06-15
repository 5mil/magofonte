/**
 * pool/skein.js
 *
 * Skein-512-512 — pure JavaScript implementation.
 * Zero dependencies. No native addons. No WASM.
 *
 * Used by DigiByte Skein algorithm (algo id: "skein") for block header hashing.
 *
 * DGB Skein mining:
 *   hash = Skein512( Skein512(header_80_bytes) )
 *   (double-Skein, same as Bitcoin uses double-SHA256)
 *
 * References:
 *   Skein v1.3 specification: https://www.skein-hash.info/sites/default/files/skein1.3.pdf
 *   NIST submission reference implementation (C): skein_block.c
 *
 * Implementation notes:
 *   - Skein-512 internal state = 8 x 64-bit words (UBI chaining)
 *   - Threefish-512 tweakable block cipher as the compression function
 *   - MIX operation: add + rotate + XOR
 *   - 72 rounds (9 groups of 8, with key injection every 4 rounds)
 *   - Output = first N bits of final state (512 bits here)
 *   - All arithmetic is mod 2^64 using BigInt
 *
 * Exports:
 *   skein512(input: Buffer | Uint8Array) → Buffer  (64 bytes)
 *   skein512Hex(input) → string (128 hex chars)
 *   dblSkein512(input) → Buffer  (double-hash, as DGB uses)
 *   dblSkein512Hex(input) → string
 */

'use strict';

// ─── 64-bit arithmetic helpers (BigInt-based) ────────────────────────────────

const M64  = 0xFFFFFFFFFFFFFFFFn;  // 2^64 - 1
const B64  = 0x10000000000000000n; // 2^64

function add64(a, b)         { return (a + b) & M64; }
function xor64(a, b)         { return (a ^ b); }
function rotl64(v, n)        { return ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M64; }

// ─── Threefish-512 rotation constants (from Skein spec Table 3) ──────────────

// R[d][j] where d = round mod 8, j = MIX pair index 0..3
const R = [
  [46, 36, 19, 37],
  [33, 27, 14, 42],
  [17, 49, 36, 39],
  [44,  9, 54, 56],
  [39, 30, 34, 24],
  [13, 50, 10, 17],
  [25, 29, 39, 43],
  [ 8, 35, 56, 22],
];

// Permutation P for Threefish-512 (from spec)
const PERM = [2, 1, 4, 7, 6, 5, 0, 3];

// ─── Threefish-512 encrypt (used by UBI as the compression function) ────────

/**
 * Encrypt one 512-bit block with Threefish-512.
 * @param {BigInt[]} key   8-word key + 1 extra C240 word (9 total)
 * @param {BigInt[]} tweak 2-word tweak + 1 derived word (3 total)
 * @param {BigInt[]} block 8 plaintext words (modified in place)
 */
function threefish512(key, tweak, block) {
  const w = block.slice();  // working copy

  // Precompute extended tweak word t2 = t0 ^ t1
  // (already done by caller, passed as tweak[2])

  // 72 rounds, key injection every 4 rounds
  for (let d = 0; d < 72; d++) {
    if (d % 4 === 0) {
      // Key injection at round d: subkey s = d/4
      const s = d / 4;
      for (let i = 0; i < 8; i++) {
        w[i] = add64(w[i], key[(s + i) % 9]);
      }
      w[5] = add64(w[5], tweak[s % 3]);
      w[6] = add64(w[6], tweak[(s + 1) % 3]);
      w[7] = add64(w[7], BigInt(s));
    }

    // MIX operations for this round
    const rd = d % 8;
    const tmp = [w[0],w[1],w[2],w[3],w[4],w[5],w[6],w[7]];

    // 4 MIX pairs per round: (0,1),(2,3),(4,5),(6,7)
    for (let j = 0; j < 4; j++) {
      const x = j * 2;
      const y = x + 1;
      tmp[x] = add64(tmp[x], tmp[y]);
      tmp[y] = xor64(rotl64(tmp[y], R[rd][j]), tmp[x]);
    }

    // Permutation
    for (let i = 0; i < 8; i++) w[PERM[i]] = tmp[i];
  }

  // Final key injection (subkey 18)
  const s = 18;
  for (let i = 0; i < 8; i++) {
    w[i] = add64(w[i], key[(s + i) % 9]);
  }
  w[5] = add64(w[5], tweak[s % 3]);
  w[6] = add64(w[6], tweak[(s + 1) % 3]);
  w[7] = add64(w[7], BigInt(s));

  for (let i = 0; i < 8; i++) block[i] = w[i];
}

// ─── UBI (Unique Block Iteration) ──────────────────────────────────────────

// Tweak type constants (T_type field in tweak word 1, bits 120..125)
const T_CFG  = BigInt(4)  << 56n;   // Configuration block
const T_MSG  = BigInt(48) << 56n;   // Message block
const T_OUT  = BigInt(63) << 56n;   // Output transform
const T_FIRST = 1n << 62n;           // First block flag
const T_LAST  = 1n << 63n;           // Last block flag

// Skein C240 constant (from spec, used to build key schedule)
const C240 = 0x1BD11BDAA9FC1A22n;

/**
 * Run one UBI call.
 * @param {BigInt[]} G     8-word chaining state (modified in place)
 * @param {Buffer}   msg   message bytes (padded to 64-byte blocks)
 * @param {BigInt}   tweak_type  T_CFG | T_MSG | T_OUT etc.
 */
function ubi(G, msg, tweakType) {
  const blockSize = 64;  // 512 bits
  const numBlocks = Math.ceil(msg.length / blockSize) || 1;

  let bytesProcessed = 0n;

  for (let b = 0; b < numBlocks; b++) {
    const start  = b * blockSize;
    const end    = Math.min(start + blockSize, msg.length);
    const isLast = (b === numBlocks - 1);
    const chunk  = Buffer.alloc(blockSize, 0);
    msg.copy(chunk, 0, start, end);

    bytesProcessed += BigInt(end - start);

    // Build tweak
    let t0 = bytesProcessed;
    let t1 = tweakType;
    if (b === 0)      t1 |= T_FIRST;
    if (isLast)       t1 |= T_LAST;
    const t2 = t0 ^ t1;

    // Build extended key from G + C240 parity
    const key = G.slice();
    let parity = C240;
    for (const w of G) parity = xor64(parity, w);
    key.push(parity);

    // Read block as 8 little-endian 64-bit words
    const block = [];
    for (let i = 0; i < 8; i++) {
      block.push(readLE64(chunk, i * 8));
    }

    // Encrypt with Threefish-512
    threefish512(key, [t0, t1, t2], block);

    // Feed-forward XOR with input block (Matyas–Meyer–Oseas construction)
    const plaintext = [];
    for (let i = 0; i < 8; i++) {
      plaintext.push(readLE64(chunk, i * 8));
    }
    for (let i = 0; i < 8; i++) {
      G[i] = xor64(block[i], plaintext[i]);
    }
  }
}

// ─── Skein-512 ─────────────────────────────────────────────────────────────

/**
 * Hash `input` with Skein-512-512.
 * Returns a 64-byte Buffer.
 */
export function skein512(input) {
  const msg = Buffer.isBuffer(input) ? input : Buffer.from(input);

  // ─ Init: G0 = UBI(0^512, config_block, T_CFG)
  const G = [0n,0n,0n,0n,0n,0n,0n,0n];

  // Configuration block: "SHA3" magic + version + output length
  // Schema (32 bytes): "SHA3" (4) + 0x0001 version LE16 + 0x0000 LE16 + output_bits LE64 + 0...
  const cfg = Buffer.alloc(32, 0);
  cfg.write('SHA3', 0, 'ascii');         // 4-byte magic
  cfg.writeUInt16LE(1, 4);              // schema version 1
  cfg.writeBigUInt64LE(512n, 8);        // output length in bits
  ubi(G, cfg, T_CFG);

  // ─ Message: G = UBI(G, message, T_MSG)
  ubi(G, msg, T_MSG);

  // ─ Output transform: G_out = UBI(G, counter_block, T_OUT)
  // Counter block = 64-bit little-endian output block index (just 0 for 512-bit output)
  const counter = Buffer.alloc(8, 0);  // counter = 0
  ubi(G, counter, T_OUT);

  // Serialise state to bytes (little-endian 64-bit words)
  const out = Buffer.alloc(64);
  for (let i = 0; i < 8; i++) writeLE64(out, i * 8, G[i]);
  return out;
}

/**
 * Hash `input` with Skein-512-512, return 128-char hex string.
 */
export function skein512Hex(input) {
  return skein512(input).toString('hex');
}

/**
 * Double-Skein-512 — Skein512(Skein512(input)).
 * This is what DGB Skein algorithm uses for block header hashing,
 * mirroring how Bitcoin uses SHA256d.
 */
export function dblSkein512(input) {
  return skein512(skein512(input));
}

/**
 * Double-Skein-512, return hex string.
 */
export function dblSkein512Hex(input) {
  return dblSkein512(input).toString('hex');
}

// ─── Little-endian 64-bit I/O helpers ────────────────────────────────────────

function readLE64(buf, offset) {
  // Read 8 bytes at offset as little-endian unsigned 64-bit BigInt
  let v = 0n;
  for (let i = 7; i >= 0; i--) {
    v = (v << 8n) | BigInt(buf[offset + i]);
  }
  return v;
}

function writeLE64(buf, offset, v) {
  // Write 64-bit BigInt as 8 little-endian bytes
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

// ─── Self-test (NIST test vector) ─────────────────────────────────────────────
//
// From the Skein v1.3 specification, Appendix C (known-answer tests):
// Skein-512-512( 0xFF ) =
//   71 B7 BC E6 FE 64 52 22
//   7D 57 43 38 35 1D 9E F9
//   0D 1C 82 09 FA 30 4E F7
//   03 41 E8 48 4B 71 95 33
//   5C CD 3C B7 08 15 FA 56
//   06 1B 4A 94 A8 38 94 B3
//   11 59 9A B9 03 28 EA 80
//   65 85 95 0D 2B 5B 36 71
//
// We test this on import to catch any BigInt/endianness bugs early.

(function _selfTest() {
  const input    = Buffer.from([0xFF]);
  const expected = '71b7bce6fe6452227d574338351d9ef90d1c8209fa304ef70341e8484b7195335ccd3cb70815fa56061b4a94a838894b31115​99ab90328ea8006585950d2b5b3671';
  try {
    const got = skein512Hex(input);
    if (got === expected) {
      console.log('[skein] ✓ Skein-512 self-test passed');
    } else {
      console.error(`[skein] ✗ SELF-TEST FAILED`);
      console.error(`  expected: ${expected}`);
      console.error(`  got:      ${got}`);
    }
  } catch (e) {
    console.error('[skein] ✗ self-test threw:', e.message);
  }
})();
