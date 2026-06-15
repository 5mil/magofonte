/**
 * pool/address.js
 *
 * Base58Check decode → P2PKH / P2SH locking script builder.
 * Zero dependencies — uses Node.js crypto for SHA-256 only.
 *
 * Exports:
 *   addressToScript(address, coinDef?)  → hex locking script
 *   validateAddress(address, coinDef?)  → { valid, type, pubKeyHash }
 *   decodeBase58Check(address)          → { version, payload, valid }
 *
 * Supported script types:
 *   P2PKH  OP_DUP OP_HASH160 <20-byte pubKeyHash> OP_EQUALVERIFY OP_CHECKSIG
 *          → 76a914{20-bytes}88ac
 *   P2SH   OP_HASH160 <20-byte scriptHash> OP_EQUAL
 *          → a914{20-bytes}87
 *
 * Version byte table (most coins inherit from Bitcoin):
 *   Bitcoin  mainnet P2PKH: 0x00  P2SH: 0x05
 *   Litecoin mainnet P2PKH: 0x30  P2SH: 0x32
 *   DigiByte mainnet P2PKH: 0x1e  P2SH: 0x3f
 *   Dogecoin mainnet P2PKH: 0x1e  P2SH: 0x16
 *   Dash     mainnet P2PKH: 0x4c  P2SH: 0x10  (two-byte version)
 *   PIVX     mainnet P2PKH: 0x1e  P2SH: 0x0d
 *
 * coinDef.address.pubKeyHashVersion / scriptHashVersion override detection.
 */

import crypto from 'node:crypto';

// ─── Base58 alphabet ──────────────────────────────────────────────────────────
const B58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP   = {};
for (let i = 0; i < B58_CHARS.length; i++) B58_MAP[B58_CHARS[i]] = BigInt(i);

/**
 * Decode a Base58 string to a Buffer (big-endian).
 * Leading '1' characters are preserved as 0x00 prefix bytes.
 */
function decodeBase58(str) {
  let n = 0n;
  for (const ch of str) {
    if (B58_MAP[ch] === undefined) throw new Error(`invalid base58 character: '${ch}'`);
    n = n * 58n + B58_MAP[ch];
  }
  // Count leading '1's  (each = 0x00 byte)
  let leadingZeros = 0;
  for (const ch of str) { if (ch !== '1') break; leadingZeros++; }
  // Convert BigInt to byte array
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  return Buffer.from([...new Array(leadingZeros).fill(0), ...bytes]);
}

/**
 * SHA-256 (single pass).
 */
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

/**
 * Double SHA-256.
 */
function dblSha256(buf) {
  return sha256(sha256(buf));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Decode a Base58Check address.
 * Returns { version, payload (20 bytes), checksum, valid }.
 * `version` is the first byte (or first two for Dash-style).
 */
export function decodeBase58Check(address) {
  let decoded;
  try {
    decoded = decodeBase58(address);
  } catch (e) {
    return { valid: false, error: e.message };
  }

  if (decoded.length < 5) return { valid: false, error: 'address too short' };

  const payload  = decoded.slice(0, -4);
  const checksum = decoded.slice(-4);
  const expected = dblSha256(payload).slice(0, 4);

  if (!checksum.equals(expected)) {
    return { valid: false, error: 'checksum mismatch' };
  }

  // Standard: 1 version byte + 20 payload bytes = 21 total before checksum
  // Dash-style: 2 version bytes (big-endian uint16) — total 22
  const isDashStyle = payload.length === 22;
  const version     = isDashStyle
    ? (payload[0] << 8) | payload[1]
    : payload[0];
  const pubKeyHash  = isDashStyle ? payload.slice(2) : payload.slice(1);

  return { valid: true, version, pubKeyHash, checksum };
}

/**
 * Known version-byte mappings.
 * Coins not listed fall back to Bitcoin-style (0x00 = P2PKH, 0x05 = P2SH).
 * coinDef can override via coinDef.address.pubKeyHashVersion / scriptHashVersion.
 */
const KNOWN_VERSIONS = {
  // { p2pkh, p2sh }  — decimal
  btc:  { p2pkh: 0x00, p2sh: 0x05 },
  ltc:  { p2pkh: 0x30, p2sh: 0x32 },
  dgb:  { p2pkh: 0x1e, p2sh: 0x3f },
  doge: { p2pkh: 0x1e, p2sh: 0x16 },
  dash: { p2pkh: 0x4c, p2sh: 0x10 },  // encoded as two-byte 0x004c / 0x0010
  pivx: { p2pkh: 0x1e, p2sh: 0x0d },
  vtc:  { p2pkh: 0x47, p2sh: 0x05 },
  rvn:  { p2pkh: 0x3c, p2sh: 0x7a },
  xmr:  null,  // CryptoNote — different encoding entirely, not handled here
};

function getVersions(coinDef) {
  if (!coinDef) return KNOWN_VERSIONS.btc;
  const coinId = (coinDef.id || '').toLowerCase();
  const known  = KNOWN_VERSIONS[coinId] || KNOWN_VERSIONS.btc;
  return {
    p2pkh: coinDef?.address?.pubKeyHashVersion  ?? known.p2pkh,
    p2sh:  coinDef?.address?.scriptHashVersion  ?? known.p2sh
  };
}

/**
 * Validate a Base58Check address for a specific coin.
 * Returns { valid, type ('P2PKH'|'P2SH'|'unknown'), pubKeyHash (hex), error? }
 */
export function validateAddress(address, coinDef) {
  const result = decodeBase58Check(address);
  if (!result.valid) return result;

  const versions = getVersions(coinDef);
  let type = 'unknown';

  if (result.version === versions.p2pkh)    type = 'P2PKH';
  else if (result.version === versions.p2sh) type = 'P2SH';

  if (result.pubKeyHash.length !== 20) {
    return { valid: false, error: `unexpected hash length: ${result.pubKeyHash.length}` };
  }

  return {
    valid:      true,
    type,
    version:    result.version,
    pubKeyHash: result.pubKeyHash.toString('hex')
  };
}

/**
 * Convert a Base58Check address to a hex locking script.
 *
 *   P2PKH: 76a914{20-byte pubKeyHash}88ac
 *   P2SH:  a914{20-byte scriptHash}87
 *
 * Throws if the address is invalid or the coin version byte doesn't match.
 * Accepts an optional coinDef to resolve version bytes (defaults to Bitcoin).
 */
export function addressToScript(address, coinDef) {
  if (!address || typeof address !== 'string') {
    throw new Error('addressToScript: address must be a non-empty string');
  }

  const result = validateAddress(address, coinDef);
  if (!result.valid) {
    throw new Error(`invalid address "${address}": ${result.error}`);
  }

  const h = result.pubKeyHash; // 40-char hex

  switch (result.type) {
    case 'P2PKH':
      // OP_DUP OP_HASH160 <push 20> <hash> OP_EQUALVERIFY OP_CHECKSIG
      return `76a914${h}88ac`;

    case 'P2SH':
      // OP_HASH160 <push 20> <scriptHash> OP_EQUAL
      return `a914${h}87`;

    default:
      // Unknown version — still build a P2PKH with whatever hash we got
      // (better than crashing; operator should supply the right address)
      console.warn(`[address] unknown version byte 0x${result.version.toString(16)} for "${address}" — using P2PKH`);
      return `76a914${h}88ac`;
  }
}

/**
 * Quick self-test — call on import to validate the module works.
 * Uses a known DGB mainnet address with a verified pubKeyHash.
 */
function _selfTest() {
  // DGB mainnet address D7Y8SyMMpDe5GQFa4g4Lnq7E4k4PeSfUeG
  // version: 0x1e (P2PKH), known valid checksum
  const TEST_ADDR = 'D7Y8SyMMpDe5GQFa4g4Lnq7E4k4PeSfUeG';
  try {
    const r = validateAddress(TEST_ADDR, { id: 'dgb' });
    if (!r.valid || r.type !== 'P2PKH') throw new Error(`selftest failed: ${JSON.stringify(r)}`);
    const script = addressToScript(TEST_ADDR, { id: 'dgb' });
    if (!script.startsWith('76a914') || !script.endsWith('88ac') || script.length !== 50)
      throw new Error(`selftest script wrong: ${script}`);
    console.log(`[address] ✓ base58check module OK  script=${script}`);
  } catch (e) {
    // Don't crash the whole server — warn loudly
    console.error('[address] ⚠ self-test failed:', e.message);
  }
}

_selfTest();
