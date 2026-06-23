import crypto from 'node:crypto';
import fs     from 'node:fs';
import path   from 'node:path';

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

export default {
  async init() {
    const ksPath = process.env.VAULT_KEYSTORE_PATH;
    const ksPass = process.env.VAULT_KEYSTORE_PASS;
    if (!ksPath || !ksPass) throw new Error('[vault/keystore] VAULT_KEYSTORE_PATH + VAULT_KEYSTORE_PASS required');
    const raw = JSON.parse(fs.readFileSync(path.resolve(ksPath), 'utf8'));
    for (const [net, entry] of Object.entries(raw.networks || {})) _keys[net] = decrypt(entry, ksPass);
    console.log('[vault/keystore] loaded:', Object.keys(_keys).join(', '));
  },
  async signTransaction(network, txData) {
    const privKey = _keys[network];
    if (!privKey) throw new Error(`[vault/keystore] no key for ${network}`);
    return { signedTx: null, txid: null, privKey, needsSigning: true };
  },
  async getPublicKey(network) {
    const key = _keys[network];
    if (!key) throw new Error(`[vault/keystore] no key for ${network}`);
    return process.env[`TREASURY_${network.toUpperCase()}_ADDRESS`] || key.slice(0, 44);
  }
};
