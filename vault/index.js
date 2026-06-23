'use strict';
/**
 * vault/index.js  — core-compatible ESM module
 * External signing vault. Private keys never in repo.
 * Backends: mock | keystore | remote  (VAULT_BACKEND env)
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const crypto  = require('crypto');

// ─── backends ───────────────────────────────────────────────────────────────
const BACKENDS = {
  mock:     () => import('./backends/mock.js'),
  keystore: () => import('./backends/keystore.js'),
  remote:   () => import('./backends/remote.js'),
};

class Vault {
  constructor() { this._signer = null; this.ready = false; this.backend = 'mock'; }

  async init(config = {}) {
    this.backend = process.env.VAULT_BACKEND || config.backend || 'mock';
    const loader = BACKENDS[this.backend];
    if (!loader) throw new Error(`Unknown vault backend: ${this.backend}`);
    const mod = await loader();
    this._signer = mod.default;
    await this._signer.init();
    this.ready = true;
    console.log(`[vault] backend: ${this.backend}`);
    return this;
  }

  async signTransaction(network, txData) {
    if (!this.ready) throw new Error('[vault] call init() first');
    return this._signer.signTransaction(network, txData);
  }

  async getPublicKey(network) {
    if (!this.ready) throw new Error('[vault] not ready');
    return this._signer.getPublicKey(network);
  }

  status() { return { backend: this.backend, ready: this.ready }; }

  get name() { return 'vault'; }

  // core module protocol — expose status route
  get routes() {
    const self = this;
    return [
      ['GET', '/status', (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(self.status()));
      }, { minRole: 'owner' }],
    ];
  }
}

const vault = new Vault();
export default vault;
