/**
 * Sweeper
 *
 * Receives revenue events from all collectors, normalises them,
 * and routes final amounts to the owner treasury wallet.
 *
 * Sweep triggers:
 *   - Automatic: when pending SOL balance crosses SWEEP_THRESHOLD_SOL
 *   - Scheduled: every SWEEP_INTERVAL_HOURS hours
 *   - Manual:    POST /api/v1/monetization/sweep (owner only)
 *
 * Solana sweep path (when vault is ready):
 *   1. Build a transfer tx from pool holding account → treasury
 *   2. Call vault.signTransaction('solana', tx)
 *   3. Submit signed tx via Helius / native RPC
 *   4. Log txid to revenue_ledger
 *
 * If vault is not ready (mock / not initialised) the sweep still runs
 * but marks status:'pending_signature' instead of 'swept'.
 */

import { createClient } from '@supabase/supabase-js';

// ------------------------------------------------------------------
// Tiny Solana transfer builder (no @solana/web3.js dependency)
// Builds the minimum SystemProgram.transfer instruction buffer.
// In production, swap for the full @solana/web3.js VersionedTransaction
// builder once the package is installed.
// ------------------------------------------------------------------
function buildSolTransferTx(fromPubkey, toPubkey, lamports) {
  // Placeholder — returns a descriptor object that vault.signTransaction()
  // will receive. Real impl should return a Transaction / VersionedTransaction.
  return {
    type:      'solana_transfer',
    from:      fromPubkey,
    to:        toPubkey,
    lamports:  BigInt(lamports).toString(),
    memo:      'magofonte-sweep',
    timestamp: Date.now(),
  };
}

export class Sweeper {
  constructor(config, treasury, ledger) {
    this.config    = config;
    this.treasury  = treasury;
    this.ledger    = ledger;
    this.queue     = [];      // pending Solana/LP events
    this.poolQueue = [];      // pending DGB pool events
    this._vault    = null;    // injected after init via setVault()
    this.supabase  = null;

    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      this.supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
      );
    }

    // Auto-sweep timer for Solana LP events
    const hours = config.sweepIntervalHours || 6;
    setInterval(() => this.sweep('scheduled'), hours * 60 * 60 * 1000);
  }

  /**
   * Inject vault after it has been initialised.
   * Called from monetization/index.js once registry is populated.
   */
  setVault(vault) {
    this._vault = vault;
    console.log('[sweeper] vault connected — real Solana signing enabled');
  }

  // ----------------------------------------------------------------
  // Solana LP events
  // ----------------------------------------------------------------

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

    const batch       = [...this.queue];
    this.queue        = [];
    const totalLamports = batch.reduce(
      (acc, e) => acc + BigInt(e.amount_a || 0) + BigInt(e.amount_b || 0), 0n
    );

    // ── Real signing path ──────────────────────────────────────────
    let txid   = null;
    let status = 'pending_signature';

    if (this._vault?.ready) {
      try {
        const fromAddress = process.env.POOL_SOL_HOLDING_ADDRESS || treasuryAddress;
        const tx = buildSolTransferTx(fromAddress, treasuryAddress, totalLamports);
        const result = await this._vault.signTransaction('solana', tx);
        txid   = result.txid;
        status = result.mock ? 'mock_sweep' : 'swept';
        if (!result.mock && txid) {
          // TODO: broadcast signed tx via Helius or native RPC
          // await broadcastTx(result.signedTx);
          console.log(`[sweeper] SOL tx signed → ${txid}`);
        }
      } catch (err) {
        console.error('[sweeper] vault signing failed:', err.message);
        status = 'signing_error';
      }
    } else {
      console.warn('[sweeper] vault not ready — sweep logged without on-chain tx');
    }

    // ── Log to ledger ─────────────────────────────────────────────
    await this.ledger.record({
      source:   'lp_fees',
      type:     'sweep',
      amount:   totalLamports.toString(),
      metadata: { events: batch.length, treasury: treasuryAddress, trigger, txid, network: 'solana' },
      status,
    });

    console.log(`[sweeper] SOL sweep — ${batch.length} event(s) · ${totalLamports} lamports · status: ${status} (trigger: ${trigger})`);
    return { swept: batch.length, totalLamports: totalLamports.toString(), trigger, treasury: treasuryAddress, network: 'solana', txid, status };
  }

  // ----------------------------------------------------------------
  // DGB pool events
  // ----------------------------------------------------------------

  async queuePoolEvent(event) {
    this.poolQueue.push(event);
    const dgbThresholdSats = this.config.sweepThresholdDgbSats || 100_000_000;
    const totalPending     = this.poolQueue.reduce((acc, e) => acc + Number(e.amount || 0), 0);
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

    // DGB on-chain send: delegate to vault when available
    // The DGB node's sendtoaddress RPC is the canonical path;
    // vault provides the signing key for a raw tx alternative.
    let txid   = null;
    let status = 'pending_signature';

    if (this._vault?.ready) {
      try {
        const tx = {
          type:    'dgb_transfer',
          to:      treasuryAddress,
          sats:    totalSats,
          events:  batch.length,
          trigger,
        };
        const result = await this._vault.signTransaction('dgb', tx);
        txid   = result.txid;
        status = result.mock ? 'mock_sweep' : 'swept';
        if (!result.mock && txid) {
          console.log(`[sweeper] DGB tx signed → ${txid}`);
        }
      } catch (err) {
        console.error('[sweeper] vault DGB signing failed:', err.message);
        status = 'signing_error';
      }
    } else {
      console.warn('[sweeper] vault not ready — DGB sweep logged without on-chain tx');
    }

    await this.ledger.record({
      source:   'pool_fees',
      type:     'sweep',
      amount:   totalSats.toString(),
      metadata: { events: batch.length, treasury: treasuryAddress, trigger, txid, coin: 'dgb' },
      status,
    });

    console.log(`[sweeper] DGB sweep — ${batch.length} event(s) · ${totalSats} sat · status: ${status} (trigger: ${trigger})`);
    return { swept: batch.length, totalSats, trigger, treasury: treasuryAddress, network: 'dgb', txid, status };
  }

  // ----------------------------------------------------------------
  // Status
  // ----------------------------------------------------------------

  async status() {
    const pendingLamports = this.queue.reduce(
      (acc, e) => acc + BigInt(e.amount_a || 0) + BigInt(e.amount_b || 0), 0n
    );
    const pendingDgbSats = this.poolQueue.reduce((acc, e) => acc + Number(e.amount || 0), 0);
    const recentSweeps   = await this.ledger.list(10, 0, 'sweep');
    return {
      treasury: {
        solana: this.treasury.address('solana'),
        dgb:    this.treasury.address('dgb'),
      },
      vault: this._vault ? this._vault.status() : { ready: false, reason: 'not_connected' },
      solana: {
        pendingEvents:     this.queue.length,
        pendingLamports:   pendingLamports.toString(),
        pendingSol:        (Number(pendingLamports) / 1e9).toFixed(6),
        sweepThresholdSol: this.config.sweepThresholdSol || 0.01,
      },
      dgb: {
        pendingEvents:         this.poolQueue.length,
        pendingSats:           pendingDgbSats,
        pendingDgb:            (pendingDgbSats / 1e8).toFixed(8),
        sweepThresholdDgbSats: this.config.sweepThresholdDgbSats || 100_000_000,
      },
      sweepIntervalHours: this.config.sweepIntervalHours || 6,
      recentSweeps,
    };
  }
}
