'use strict';
/**
 * vault/backends/keystore.js
 * Keystore backend — AES-256-GCM encrypted key file.
 *
 * The keystore file is NEVER committed to the repo.
 * Path is set via VAULT_KEYSTORE_PATH env var.
 * Password is set via VAULT_KEYSTORE_PASS env var (or prompted at runtime).
 *
 * File format (JSON):
 * {
 *   "version": 1,
 *   "networks": {
 *     "solana": { "iv": "hex", "tag": "hex", "data": "hex" },
 *     "dgb":    { "iv": "hex", "tag": "hex", "data": "hex" },
 *     "ltc":    { "iv": "hex", "tag": "hex", "data": "hex" }
 *   }
 * }
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

let _keys = {};

function decrypt(entry, password) {
  const key = crypto.scryptSync(password, 'magofonte-vault-salt', 32);
  const iv  = Buffer.from(entry.iv,   'hex');
  const tag = Buffer.from(entry.tag,  'hex');
  const enc = Buffer.from(entry.data, 'hex');
  const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(enc), dec.final()]).toString('utf8');
}

module.exports = {
  async init() {
    const ksPath = process.env.VAULT_KEYSTORE_PATH;
    const ksPass = process.env.VAULT_KEYSTORE_PASS;
    if (!ksPath || !ksPass) {
      throw new Error('[vault/keystore] VAULT_KEYSTORE_PATH and VAULT_KEYSTORE_PASS must be set');
    }
    const raw  = JSON.parse(fs.readFileSync(path.resolve(ksPath), 'utf8'));
    for (const [net, entry] of Object.entries(raw.networks || {})) {
      _keys[net] = decrypt(entry, ksPass);
    }
    console.log('[vault/keystore] Keystore loaded for networks:', Object.keys(_keys).join(', '));
  },

  async signTransaction(network, txData) {
    const privKey = _keys[network];
    if (!privKey) throw new Error(`[vault/keystore] No key for network: ${network}`);
    // Actual signing logic is network-specific — wire in @solana/web3.js or dgb lib here
    // This stub returns the key reference for downstream signers
    return { signedTx: null, txid: null, privKey, needsSigning: true };
  },

  async getPublicKey(network) {
    const privKey = _keys[network];
    if (!privKey) throw new Error(`[vault/keystore] No key for network: ${network}`);
    // Return the treasury address from env — public key derivation is network-specific
    return process.env[`TREASURY_${network.toUpperCase()}_ADDRESS`] || privKey.slice(0, 44);
  }
};
