'use strict';
/**
 * vault/index.js
 * External signing vault — treasury transaction signing layer.
 *
 * DESIGN PRINCIPLE: Private keys NEVER live in this repo or any env var.
 * This module provides the interface that connects to an external signer:
 *   - Hardware wallet (Ledger/Trezor via USB)
 *   - Remote signing service (e.g. Fireblocks, self-hosted)
 *   - Local keystore file (encrypted, password-unlocked at runtime)
 *
 * The vault exposes a single async signTransaction(network, txData) method.
 * The actual signing backend is selected via VAULT_BACKEND env var.
 */

const backends = {
  ledger:   () => require('./backends/ledger'),
  remote:   () => require('./backends/remote'),
  keystore: () => require('./backends/keystore'),
  mock:     () => require('./backends/mock'),
};

class Vault {
  constructor(config = {}) {
    this.backend = process.env.VAULT_BACKEND || config.backend || 'mock';
    this.ready = false;
    this._signer = null;
  }

  async init() {
    const loader = backends[this.backend];
    if (!loader) throw new Error(`Unknown vault backend: ${this.backend}`);
    this._signer = loader();
    await this._signer.init();
    this.ready = true;
    console.log(`[vault] Initialized with backend: ${this.backend}`);
  }

  /**
   * signTransaction(network, txData) → { signedTx, txid }
   * network: 'solana' | 'dgb' | 'ltc'
   * txData: network-specific raw transaction object
   */
  async signTransaction(network, txData) {
    if (!this.ready) throw new Error('[vault] Not initialized — call vault.init() first');
    return this._signer.signTransaction(network, txData);
  }

  /**
   * getPublicKey(network) → string (address or pubkey)
   */
  async getPublicKey(network) {
    if (!this.ready) throw new Error('[vault] Not initialized');
    return this._signer.getPublicKey(network);
  }

  status() {
    return { backend: this.backend, ready: this.ready };
  }
}

module.exports = new Vault();
