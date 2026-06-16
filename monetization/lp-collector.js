/**
 * LP Fee Collector
 *
 * Reads lp_positions from Supabase, computes claimable fee amounts
 * (tokens_owed_a + tokens_owed_b), queries on-chain state via
 * public free RPC, and emits revenue events for the sweeper.
 *
 * Supports: Meteora DLMM, Raydium CLMM
 * Free RPC entries: Helius (free), Solana public mainnet
 */

import { createClient } from '@supabase/supabase-js';

const FREE_RPC_ENDPOINTS = [
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  'https://rpc.helius.xyz/?api-key=' + (process.env.HELIUS_API_KEY || ''),
];

export class LpCollector {
  constructor(config, sweeper, ledger) {
    this.config  = config;
    this.sweeper = sweeper;
    this.ledger  = ledger;
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }

  /**
   * Main collection cycle:
   * 1. Fetch all lp_positions from Supabase
   * 2. For each position, check tokens_owed_a + tokens_owed_b
   * 3. If above threshold, emit a revenue event
   * 4. Pass events to sweeper for treasury routing
   */
  async collect() {
    console.log('[lp-collector] starting collection cycle');

    const { data: positions, error } = await this.supabase
      .from('lp_positions')
      .select('*')
      .gt('tokens_owed_a', 0)  // only rows with claimable fees
      .order('updated_at', { ascending: false });

    if (error) {
      console.error('[lp-collector] failed to fetch positions:', error.message);
      return { collected: 0, error: error.message };
    }

    if (!positions || positions.length === 0) {
      console.log('[lp-collector] no claimable positions found');
      return { collected: 0 };
    }

    const events = [];
    for (const pos of positions) {
      const event = await this._processPosition(pos);
      if (event) events.push(event);
    }

    if (events.length > 0) {
      await this.sweeper.queueEvents(events);
    }

    console.log(`[lp-collector] cycle complete — ${events.length} revenue event(s) queued`);
    return { collected: events.length, events };
  }

  async _processPosition(pos) {
    const claimableA = BigInt(pos.tokens_owed_a || 0);
    const claimableB = BigInt(pos.tokens_owed_b || 0);

    if (claimableA === 0n && claimableB === 0n) return null;

    const minThreshold = BigInt(this.config.minClaimThreshold || 1000); // lamports
    if (claimableA + claimableB < minThreshold) {
      console.log(`[lp-collector] position ${pos.position_pubkey} below threshold, skipping`);
      return null;
    }

    // Determine protocol and build claim instruction
    const protocol = pos.protocol?.toLowerCase() || 'meteora';
    const claimIx  = this._buildClaimInstruction(pos, protocol);

    // Log the revenue event
    const event = {
      source:       'lp_fees',
      protocol,
      position:     pos.position_pubkey,
      pool:         pos.pool_pubkey,
      amount_a:     claimableA.toString(),
      amount_b:     claimableB.toString(),
      fee_tier:     pos.fee_tier,
      claim_ix:     claimIx,
      status:       'pending',
      captured_at:  new Date().toISOString(),
    };

    await this.ledger.record({
      source:      'lp_fees',
      type:        'fee_claim',
      amount:      (claimableA + claimableB).toString(),
      metadata:    event,
      status:      'pending',
    });

    return event;
  }

  /**
   * Builds the claim instruction descriptor for the sweeper.
   * The sweeper/signer will execute this using the treasury keypair.
   *
   * For Meteora DLMM: claimFee instruction
   * For Raydium CLMM: collectFee instruction
   */
  _buildClaimInstruction(pos, protocol) {
    const base = {
      position_pubkey: pos.position_pubkey,
      pool_pubkey:     pos.pool_pubkey,
      owner:           process.env.TREASURY_WALLET_ADDRESS,
    };

    if (protocol === 'meteora') {
      return { ...base, program: 'LBUZKhRxPF3XUpBCjp4YzTKgLLjgVmh6wNGnsLQBVEYt', ix_type: 'claimFee' };
    } else if (protocol === 'raydium') {
      return { ...base, program: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', ix_type: 'collectFee' };
    }

    return { ...base, program: null, ix_type: 'unknown', note: 'manual claim required' };
  }

  // Refresh on-chain owed amounts from Solana RPC (free endpoints)
  async refreshOnChain(positionPubkey) {
    for (const rpc of FREE_RPC_ENDPOINTS) {
      if (!rpc || rpc.endsWith('=')) continue; // skip empty key
      try {
        const resp = await fetch(rpc, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method:  'getAccountInfo',
            params:  [positionPubkey, { encoding: 'jsonParsed' }],
          }),
          signal: AbortSignal.timeout(5000),
        });
        const json = await resp.json();
        if (json?.result?.value) return json.result.value;
      } catch {
        continue; // try next RPC
      }
    }
    return null;
  }
}
