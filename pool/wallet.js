'use strict';
/**
 * pool/wallet.js — Key Primitive Library
 *
 * Pure-Node.js, zero-dependency wallet primitives.
 * Coin-agnostic: pass a coin definition (from coins/*.json) and this
 * module handles everything from raw private-key bytes to WIF and P2PKH address.
 *
 * Coin def requirements:
 *   coin.addressVersion  {number}  — P2PKH version byte  (DGB = 30, BTC = 0, LTC = 48 …)
 *   coin.wifVersion      {number}  — WIF prefix byte     (DGB = 128, BTC = 128 …)
 *                                    Falls back to 0x80 (128) if absent.
 *
 * Public API:
 *   generateKey(coin)            → { wif, address, privateKeyHex }
 *   fromWIF(wifStr, coin)        → { wif, address, privateKeyHex }
 *   wifToAddress(wifStr, coin)   → address string
 */

const crypto = require('crypto');

// ─── Base58 ──────────────────────────────────────────────────────────────────
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buf) {
  let num = BigInt('0x' + buf.toString('hex'));
  let result = '';
  const base = 58n;
  while (num > 0n) {
    const rem = num % base;
    num = num / base;
    result = BASE58_ALPHABET[Number(rem)] + result;
  }
  for (const byte of buf) {
    if (byte === 0) result = '1' + result;
    else break;
  }
  return result;
}

function base58Decode(str) {
  let num = 0n;
  for (const ch of str) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid Base58 character: ${ch}`);
    num = num * 58n + BigInt(idx);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const bytes = Buffer.from(hex, 'hex');
  let leadingZeros = 0;
  for (const ch of str) {
    if (ch === '1') leadingZeros++;
    else break;
  }
  return Buffer.concat([Buffer.alloc(leadingZeros), bytes]);
}

// ─── Base58Check ─────────────────────────────────────────────────────────────
function sha256d(buf) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(buf).digest()
  ).digest();
}

function base58CheckEncode(versionByte, payload) {
  const versionedPayload = Buffer.concat([Buffer.from([versionByte]), payload]);
  const checksum = sha256d(versionedPayload).slice(0, 4);
  return base58Encode(Buffer.concat([versionedPayload, checksum]));
}

function base58CheckDecode(str) {
  const buf = base58Decode(str);
  if (buf.length < 5) throw new Error('Base58Check string too short');
  const payload  = buf.slice(0, buf.length - 4);
  const checksum = buf.slice(buf.length - 4);
  const expected = sha256d(payload).slice(0, 4);
  if (!checksum.equals(expected)) throw new Error('Base58Check checksum mismatch');
  return { version: payload[0], data: payload.slice(1) };
}

// ─── Elliptic-curve (secp256k1) via Node built-in ECDH ───────────────────────
function privateKeyToPublicKey(privKeyBuf) {
  // Node's ECDH lets us derive the compressed public key without any native addon.
  const ecdh = crypto.createECDH('prime256p1'.replace('256p1', '256v1') !== 'prime256v1'
    ? 'prime256v1' : 'prime256v1'); // normalise name
  // Rebuild using the correct curve name for secp256k1
  const ecdhK1 = crypto.createECDH('secp256k1');
  ecdhK1.setPrivateKey(privKeyBuf);
  return ecdhK1.getPublicKey(null, 'compressed'); // 33 bytes
}

// ─── Address derivation ───────────────────────────────────────────────────────
function pubKeyToAddress(pubKeyBuf, addressVersion) {
  const sha256Hash  = crypto.createHash('sha256').update(pubKeyBuf).digest();
  const ripemd160   = crypto.createHash('ripemd160').update(sha256Hash).digest();
  return base58CheckEncode(addressVersion, ripemd160);
}

// ─── WIF encoding / decoding ──────────────────────────────────────────────────
function privKeyToWIF(privKeyBuf, wifVersion) {
  // Append 0x01 compression flag
  const payload = Buffer.concat([privKeyBuf, Buffer.from([0x01])]);
  return base58CheckEncode(wifVersion, payload);
}

function wifToPrivKey(wifStr, wifVersion) {
  const { version, data } = base58CheckDecode(wifStr);
  if (version !== wifVersion) {
    throw new Error(`WIF version byte mismatch: expected ${wifVersion}, got ${version}`);
  }
  // Strip optional compression flag
  const privKey = (data.length === 33 && data[32] === 0x01) ? data.slice(0, 32) : data;
  if (privKey.length !== 32) throw new Error('Invalid private key length in WIF');
  return privKey;
}

// ─── Public API ───────────────────────────────────────────────────────────────
function _resolveVersions(coin) {
  const addrVer = coin.addressVersion;
  const wifVer  = coin.wifVersion != null ? coin.wifVersion : 0x80;
  if (addrVer == null) throw new Error(`Coin definition missing addressVersion`);
  return { addrVer, wifVer };
}

/**
 * Generate a brand-new keypair for the given coin.
 * @param {object} coin  — coin definition from coins/*.json
 * @returns {{ wif: string, address: string, privateKeyHex: string }}
 */
function generateKey(coin) {
  const { addrVer, wifVer } = _resolveVersions(coin);
  let privKey;
  do {
    privKey = crypto.randomBytes(32);
  } while (
    // Reject keys outside the valid secp256k1 range (astronomically rare)
    privKey.equals(Buffer.alloc(32)) ||
    BigInt('0x' + privKey.toString('hex')) >=
      BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141')
  );
  const pubKey  = privateKeyToPublicKey(privKey);
  const address = pubKeyToAddress(pubKey, addrVer);
  const wif     = privKeyToWIF(privKey, wifVer);
  return { wif, address, privateKeyHex: privKey.toString('hex') };
}

/**
 * Import an existing WIF private key for the given coin.
 * @param {string} wifStr — WIF-encoded private key
 * @param {object} coin   — coin definition from coins/*.json
 * @returns {{ wif: string, address: string, privateKeyHex: string }}
 */
function fromWIF(wifStr, coin) {
  const { addrVer, wifVer } = _resolveVersions(coin);
  const privKey = wifToPrivKey(wifStr, wifVer);
  const pubKey  = privateKeyToPublicKey(privKey);
  const address = pubKeyToAddress(pubKey, addrVer);
  return { wif: wifStr, address, privateKeyHex: privKey.toString('hex') };
}

/**
 * Derive only the address from a WIF string.
 * @param {string} wifStr
 * @param {object} coin
 * @returns {string} address
 */
function wifToAddress(wifStr, coin) {
  return fromWIF(wifStr, coin).address;
}

module.exports = { generateKey, fromWIF, wifToAddress };
