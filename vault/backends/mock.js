'use strict';
/**
 * vault/backends/mock.js
 * Mock signing backend — used in dev/test.
 * Signs nothing real; returns dummy txid for logging/testing.
 * NEVER use in production.
 */

const crypto = require('crypto');

module.exports = {
  async init() {
    console.warn('[vault/mock] ⚠️  Mock backend active — transactions are NOT real');
  },

  async signTransaction(network, txData) {
    const txid = crypto.randomBytes(32).toString('hex');
    console.log(`[vault/mock] Signed ${network} tx → ${txid} (mock)`);
    return { signedTx: null, txid, mock: true };
  },

  async getPublicKey(network) {
    const keys = {
      solana: process.env.TREASURY_WALLET_ADDRESS || 'MOCK_SOL_ADDRESS',
      dgb:    process.env.TREASURY_DGB_ADDRESS    || 'MOCK_DGB_ADDRESS',
      ltc:    process.env.TREASURY_LTC_ADDRESS    || 'MOCK_LTC_ADDRESS',
    };
    return keys[network] || 'MOCK_ADDRESS';
  }
};
