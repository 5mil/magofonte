/**
 * Treasury
 *
 * Owner-controlled wallet configuration.
 * The treasury address is the single destination for all
 * revenue streams flowing through the monetization module.
 *
 * - Address is set via TREASURY_WALLET_ADDRESS env var
 * - Only the owner role can read or change it via the API
 * - The private key NEVER lives in this module — signing
 *   is handled externally (hardware wallet, Ledger, or
 *   a separate signing service)
 *
 * Supported networks:
 *   solana  — default (LP fees, token rewards)
 *   dgb     — pool mining rewards
 *   ltc     — future
 */

export class Treasury {
  constructor(config) {
    this.config = config;
  }

  address(network = 'solana') {
    switch (network) {
      case 'solana': return process.env.TREASURY_WALLET_ADDRESS    || null;
      case 'dgb':    return process.env.TREASURY_DGB_ADDRESS        || process.env.DGB_REWARD_ADDRESS || null;
      case 'ltc':    return process.env.TREASURY_LTC_ADDRESS        || null;
      default:       return process.env.TREASURY_WALLET_ADDRESS     || null;
    }
  }

  allAddresses() {
    return {
      solana: this.address('solana'),
      dgb:    this.address('dgb'),
      ltc:    this.address('ltc'),
    };
  }

  isConfigured(network = 'solana') {
    return !!this.address(network);
  }

  summary() {
    const addrs = this.allAddresses();
    return {
      solana: addrs.solana ? `${addrs.solana.slice(0,6)}…${addrs.solana.slice(-4)}` : 'not set',
      dgb:    addrs.dgb    ? `${addrs.dgb.slice(0,6)}…${addrs.dgb.slice(-4)}`    : 'not set',
      ltc:    addrs.ltc    ? `${addrs.ltc.slice(0,6)}…${addrs.ltc.slice(-4)}`    : 'not set',
    };
  }
}
