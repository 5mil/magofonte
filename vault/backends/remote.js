'use strict';
/**
 * vault/backends/remote.js
 * Remote signing service backend.
 * Calls an external HTTPS signing endpoint (self-hosted or Fireblocks-compatible).
 *
 * Required env vars:
 *   VAULT_REMOTE_URL      — e.g. https://signer.yourserver.com
 *   VAULT_REMOTE_TOKEN    — Bearer token for auth
 */

const https = require('https');

async function post(url, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': `Bearer ${token}`
      }
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve(JSON.parse(raw)));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

module.exports = {
  async init() {
    this._url   = process.env.VAULT_REMOTE_URL;
    this._token = process.env.VAULT_REMOTE_TOKEN;
    if (!this._url || !this._token) {
      throw new Error('[vault/remote] VAULT_REMOTE_URL and VAULT_REMOTE_TOKEN must be set');
    }
    console.log(`[vault/remote] Remote signer configured at ${this._url}`);
  },

  async signTransaction(network, txData) {
    return post(`${this._url}/sign`, this._token, { network, txData });
  },

  async getPublicKey(network) {
    return post(`${this._url}/pubkey`, this._token, { network });
  }
};
