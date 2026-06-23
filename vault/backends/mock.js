const crypto = (await import('node:crypto')).default;
export default {
  async init() { console.warn('[vault/mock] ⚠  mock backend — NOT real'); },
  async signTransaction(network, txData) {
    const txid = crypto.randomBytes(32).toString('hex');
    console.log(`[vault/mock] signed ${network} → ${txid} (mock)`);
    return { signedTx: null, txid, mock: true };
  },
  async getPublicKey(network) {
    const keys = {
      solana: process.env.TREASURY_WALLET_ADDRESS || 'MOCK_SOL',
      dgb:    process.env.TREASURY_DGB_ADDRESS    || 'MOCK_DGB',
      ltc:    process.env.TREASURY_LTC_ADDRESS    || 'MOCK_LTC',
    };
    return keys[network] || 'MOCK';
  }
};
