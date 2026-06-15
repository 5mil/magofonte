/**
 * pool/bonus.js  —  BonusLedger
 *
 * Cross-pool bonus distribution for CPU-mined blocks.
 *
 * When the server's built-in CPU miner finds a block, 100% of that
 * block reward (minus an optional operator fee) is split proportionally
 * among every real miner who submitted a valid share on ANY registered
 * pool within a rolling time window.
 *
 * Design goals
 * ────────────
 *  • Completely separate from per-pool PPLNS earnings — the bonus
 *    never touches or inflates a pool's own payout queue.
 *  • Cross-pool fairness — a miner working on Skein and another on
 *    Scrypt both earn from the same CPU bonus pot, weighted by their
 *    recent share work normalised to difficulty.
 *  • Time-window based (not PPLNS) — uses a rolling window (default
 *    30 minutes) so even miners who joined recently see a bonus if
 *    they did real work in that window.
 *  • Dust filtering — bonus amounts below `dustThreshold` satoshis
 *    are carried forward to the next bonus event.
 *
 * Integration
 * ───────────
 *  1. Create a singleton BonusLedger and attach it to the registry:
 *       registry.bonusLedger = new BonusLedger(registry, opts);
 *
 *  2. Each Pool instance registers itself on startup:
 *       registry.bonusLedger.registerPool('dgb-skein', payoutTracker);
 *
 *  3. The CpuMinerSession calls ledger.cpuBlockFound(reward) when the
 *     CPU miner submits a valid block.
 *
 * Exports
 * ────────
 *  BonusLedger  —  EventEmitter
 *    .registerPool(poolId, payoutTracker)
 *    .recordShare(poolId, user, difficulty)   — called on every valid share
 *    .cpuBlockFound(rewardSatoshis)           — called when CPU miner finds block
 *    .getStats()                              — current window + all-time ledger
 *    events:
 *      'bonus:distributed'  { reward, dust, allocations, window }
 */

import { EventEmitter } from 'node:events';

export class BonusLedger extends EventEmitter {
  /**
   * @param {object} registry  — the shared MagoFonte module registry
   * @param {object} [opts]
   * @param {number} [opts.windowMs]        rolling window length in ms (default: 30 min)
   * @param {number} [opts.operatorFeePct]  operator fee 0–100 (default: 0 — full pass-through)
   * @param {number} [opts.dustThreshold]   min satoshis per user to pay out (default: 1000)
   */
  constructor(registry, opts = {}) {
    super();
    this.registry       = registry;
    this.windowMs       = opts.windowMs       ?? 30 * 60 * 1000;  // 30 minutes
    this.operatorFeePct = Math.max(0, Math.min(100, opts.operatorFeePct ?? 0));
    this.dustThreshold  = opts.dustThreshold  ?? 1000;  // satoshis

    // poolId → PayoutTracker reference (for retroactive stat queries)
    this._pools = new Map();

    // Rolling share window: array of { poolId, user, diff, ts }
    this._shares = [];

    // Dust carry-over per user: user → satoshis
    this._dust = {};

    // All-time bonus ledger: user → total satoshis credited
    this._allTime = {};

    // All-time CPU blocks found
    this._cpuBlocks = [];

    // Prune window every minute
    this._pruneTimer = setInterval(() => this._prune(), 60_000);
    // Don't block process exit
    this._pruneTimer.unref?.();

    console.log(`[bonus] ledger ready — window=${this.windowMs/60000}min fee=${this.operatorFeePct}%`);
  }

  // ----------------------------------------------------------------
  // Registration
  // ----------------------------------------------------------------

  /** Register a pool so its shares feed into the bonus window. */
  registerPool(poolId, payoutTracker) {
    this._pools.set(poolId, payoutTracker);
    console.log(`[bonus] registered pool: ${poolId}`);
  }

  unregisterPool(poolId) {
    this._pools.delete(poolId);
  }

  // ----------------------------------------------------------------
  // Share recording  (call on every accepted share from any pool)
  // ----------------------------------------------------------------

  /**
   * Record a valid share from a real miner.
   * @param {string} poolId   which pool accepted this share
   * @param {string} user     miner username / wallet address
   * @param {number} diff     share difficulty
   */
  recordShare(poolId, user, diff) {
    if (user === 'server') return;  // never count CPU miner's own work
    this._shares.push({ poolId, user, diff, ts: Date.now() });
  }

  // ----------------------------------------------------------------
  // CPU block event
  // ----------------------------------------------------------------

  /**
   * Called when the server's CPU miner finds a valid block.
   * Distributes the reward across all workers active in the window.
   *
   * @param {number} rewardSatoshis  total coinbase value in satoshis
   * @param {object} [meta]          optional { height, coin, hashHex }
   * @returns {object}  distribution result
   */
  cpuBlockFound(rewardSatoshis, meta = {}) {
    this._prune();

    const now       = Date.now();
    const window    = this._shares.filter(s => now - s.ts <= this.windowMs);

    // ---- operator fee ----
    const feeSats   = Math.floor(rewardSatoshis * this.operatorFeePct / 100);
    const pot       = rewardSatoshis - feeSats;

    if (window.length === 0 || pot <= 0) {
      console.log(`[bonus] CPU block found but no active workers in window — reward carried as dust`);
      this._cpuBlocks.push({ ...meta, reward: rewardSatoshis, allocated: 0, allocations: {}, ts: now });
      return { reward: rewardSatoshis, pot, dust: pot, allocations: {} };
    }

    // ---- aggregate diff per user, weighted by recency ----
    // Shares closer to now get slightly more weight (linear decay to 0.5× at window start)
    // This rewards miners who are actively working right now over those who worked an hour ago.
    const userWeight = {};
    for (const s of window) {
      const age     = now - s.ts;
      const recency = 1.0 - 0.5 * (age / this.windowMs);  // 1.0 (fresh) → 0.5 (at window edge)
      userWeight[s.user] = (userWeight[s.user] || 0) + s.diff * recency;
    }

    const totalWeight = Object.values(userWeight).reduce((a, b) => a + b, 0);

    // ---- compute raw allocations + add carried dust ----
    const rawAlloc = {};
    for (const [user, weight] of Object.entries(userWeight)) {
      const base  = Math.floor(pot * weight / totalWeight);
      const carry = this._dust[user] || 0;
      rawAlloc[user] = base + carry;
    }

    // ---- apply dust threshold ----
    const allocations = {};
    let   totalPaid   = 0;
    let   newDust     = 0;
    for (const [user, amount] of Object.entries(rawAlloc)) {
      if (amount >= this.dustThreshold) {
        allocations[user]  = amount;
        totalPaid         += amount;
        this._dust[user]   = 0;
        this._allTime[user] = (this._allTime[user] || 0) + amount;
      } else {
        // Carry forward — will be added to next event
        this._dust[user] = amount;
        newDust         += amount;
      }
    }

    const result = {
      reward:      rewardSatoshis,
      operatorFee: feeSats,
      pot,
      totalPaid,
      dust:        newDust,
      allocations,
      workerCount: Object.keys(userWeight).length,
      windowShares: window.length,
      meta,
    };

    this._cpuBlocks.push({
      ...meta,
      reward: rewardSatoshis,
      allocated: totalPaid,
      allocations,
      ts: now,
    });

    console.log(
      `[bonus] CPU block — pot=${pot}sat → ${Object.keys(allocations).length} workers,`+
      ` dust carried=${newDust}sat, fee=${feeSats}sat`
    );
    for (const [user, amt] of Object.entries(allocations))
      console.log(`  [bonus]   ${user}: +${amt}sat`);

    this.emit('bonus:distributed', result);
    this.registry.emit('bonus:distributed', result);
    return result;
  }

  // ----------------------------------------------------------------
  // Stats
  // ----------------------------------------------------------------

  getStats() {
    this._prune();
    const now    = Date.now();
    const window = this._shares.filter(s => now - s.ts <= this.windowMs);

    // Per-user share weight in current window
    const userWeight = {};
    for (const s of window) {
      const recency = 1.0 - 0.5 * ((now - s.ts) / this.windowMs);
      userWeight[s.user] = (userWeight[s.user] || 0) + s.diff * recency;
    }
    const totalWeight = Object.values(userWeight).reduce((a, b) => a + b, 0) || 1;
    const userShares  = {};
    for (const [u, w] of Object.entries(userWeight))
      userShares[u] = { weight: w, sharePct: +(w / totalWeight * 100).toFixed(2) };

    return {
      windowMs:       this.windowMs,
      windowShares:   window.length,
      activePools:    [...this._pools.keys()],
      activeWorkers:  Object.keys(userWeight).length,
      userShares,
      dust:           { ...this._dust },
      allTimeEarnings: { ...this._allTime },
      cpuBlocksFound:  this._cpuBlocks.length,
      recentCpuBlocks: this._cpuBlocks.slice(-10),
    };
  }

  // ----------------------------------------------------------------
  // Internal
  // ----------------------------------------------------------------

  _prune() {
    const cutoff = Date.now() - this.windowMs;
    // Keep a small buffer beyond the window for the next cpuBlockFound call
    const keep   = this.windowMs + 60_000;
    this._shares = this._shares.filter(s => Date.now() - s.ts < keep);
  }

  destroy() {
    clearInterval(this._pruneTimer);
  }
}
