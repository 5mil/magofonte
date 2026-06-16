/**
 * Sweeper
 *
 * Receives revenue events from all collectors, normalizes them,
 * and routes the final amounts to the owner treasury wallet.
 *
 * Sweep triggers:
 *   - Automatic: when pending SOL balance crosses SWEEP_THRESHOLD_SOL
 *   - Scheduled: every SWEEP_INTERVAL_HOURS hours
 *   - Manual:    POST /api/v1/monetization/sweep (owner only)
 *
 * Pool events (DGB) are handled separately via queuePoolEvent — they
 * are logged and swept to TREASURY_DGB_ADDRESS rather than the Solana wallet.
 */

import { createClient } from '@supabase/supabase-js';

export class Sweeper {
  constructor(config, treasury, ledger) {
    this.config   = config;
    this.treasury = treasury;
    this.ledger   = ledger;
    this.queue    = [];     // pending Solana/LP events
    this.poolQueue = [];    // pending DGB pool events
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Auto-sweep timer for Solana LP events
    const hours = config.sweepIntervalHours || 6;
    setInterval(() => this.sweep('scheduled'), hours * 60 * 60 * 1000);
  }

  // --- Solana LP events ---

  async queueEvents(events) {
    this.queue.push(...events);
    const thresholdLamports = BigInt(
      Math.floor((this.config.sweepThresholdSol || 0.01) * 1e9)
    );
    const totalPending = this.queue.reduce(
      (acc, e) => acc + BigInt(e.amount_a || 0) + BigInt(e.amount_b || 0), 0n
    );
    if (totalPending >= thresholdLamports) {
      console.log('[sweeper] SOL threshold crossed — triggering auto-sweep');
      await this.sweep('auto');
    }
  }

  async sweep(trigger = 'manual') {
    if (this.queue.length === 0) {
      return { swept: 0, trigger, note: 'nothing to sweep' };
    }
    const treasuryAddress = this.treasury.address('solana');
    if (!treasuryAddress) {
      console.error('[sweeper] no Solana treasury address configured');
      return { swept: 0, trigger, error: 'TREASURY_WALLET_ADDRESS not set' };
    }
    const batch = [...this.queue];
    this.queue  = [];
    let swept   = 0;
    for (const event of batch) {
      try {
        await this.ledger.record({
          source:   event.source,
          type:     'sweep',
          amount:   (BigInt(event.amount_a || 0) + BigInt(event.amount_b || 0)).toString(),
          metadata: { ...event, treasury: treasuryAddress, trigger },
          status:   'swept',
        });
        swept++;
      } catch (err) {
        console.error('[sweeper] failed to process SOL event:', err.message);
      }
    }
    console.log(`[sweeper] SOL sweep complete — ${swept} event(s) → ${treasuryAddress} (trigger: ${trigger})`);
    return { swept, trigger, treasury: treasuryAddress, network: 'solana' };
  }

  // --- DGB pool events ---

  async queuePoolEvent(event) {
    this.poolQueue.push(event);
    const dgbThresholdSats = this.config.sweepThresholdDgbSats || 100_000_000; // 1 DGB default
    const totalPending = this.poolQueue.reduce((acc, e) => acc + Number(e.amount || 0), 0);
    if (totalPending >= dgbThresholdSats) {
      console.log('[sweeper] DGB threshold crossed — triggering pool sweep');
      await this.sweepPool('auto');
    }
  }

  async sweepPool(trigger = 'manual') {
    if (this.poolQueue.length === 0) {
      return { swept: 0, trigger, note: 'nothing to sweep', network: 'dgb' };
    }
    const treasuryAddress = this.treasury.address('dgb');
    if (!treasuryAddress) {
      console.error('[sweeper] no DGB treasury address configured');
      return { swept: 0, trigger, error: 'TREASURY_DGB_ADDRESS not set', network: 'dgb' };
    }
    const batch      = [...this.poolQueue];
    this.poolQueue   = [];
    const totalSats  = batch.reduce((acc, e) => acc + Number(e.amount || 0), 0);
    await this.ledger.record({
      source:   'pool_fees',
      type:     'sweep',
      amount:   totalSats.toString(),
      metadata: { events: batch.length, treasury: treasuryAddress, trigger, coin: 'dgb' },
      status:   'swept',
    });
    console.log(`[sweeper] DGB sweep complete — ${totalSats}sat across ${batch.length} event(s) → ${treasuryAddress} (trigger: ${trigger})`);
    return { swept: batch.length, totalSats, trigger, treasury: treasuryAddress, network: 'dgb' };
  }

  async status() {
    const pendingAmt = this.queue.reduce(
      (acc, e) => acc + BigInt(e.amount_a || 0) + BigInt(e.amount_b || 0), 0n
    );
    const pendingDgbSats = this.poolQueue.reduce((acc, e) => acc + Number(e.amount || 0), 0);
    const recentSweeps   = await this.ledger.list(10, 0, 'sweep');
    return {
      treasury: {
        solana: this.treasury.address('solana'),
        dgb:    this.treasury.address('dgb'),
      },
      solana: {
        pendingEvents:    this.queue.length,
        pendingLamports:  pendingAmt.toString(),
        pendingSol:       (Number(pendingAmt) / 1e9).toFixed(6),
        sweepThresholdSol: this.config.sweepThresholdSol || 0.01,
      },
      dgb: {
        pendingEvents:       this.poolQueue.length,
        pendingSats:         pendingDgbSats,
        pendingDgb:          (pendingDgbSats / 1e8).toFixed(8),
        sweepThresholdDgbSats: this.config.sweepThresholdDgbSats || 100_000_000,
      },
      sweepIntervalHours: this.config.sweepIntervalHours || 6,
      recentSweeps,
    };
  }
}
