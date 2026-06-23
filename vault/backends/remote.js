import https from 'node:https';

async function post(url, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Authorization': `Bearer ${token}` }
    }, res => { let r = ''; res.on('data', d => r += d); res.on('end', () => resolve(JSON.parse(r))); });
    req.on('error', reject); req.write(data); req.end();
  });
}

export default {
  _url: null, _token: null,
  async init() {
    this._url   = process.env.VAULT_REMOTE_URL;
    this._token = process.env.VAULT_REMOTE_TOKEN;
    if (!this._url || !this._token) throw new Error('[vault/remote] VAULT_REMOTE_URL + VAULT_REMOTE_TOKEN required');
    console.log(`[vault/remote] ${this._url}`);
  },
  async signTransaction(network, txData) { return post(`${this._url}/sign`,   this._token, { network, txData }); },
  async getPublicKey(network)            { return post(`${this._url}/pubkey`, this._token, { network }); }
};
