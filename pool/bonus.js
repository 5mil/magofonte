/**
 * pool/bonus.js  —  BonusLedger
 *
 * Cross-pool bonus distribution for CPU-mined blocks.
 *
 * When the server's built-in CPU miner finds a block on coin X, 100% of
 * that block reward (minus an optional operator fee) is split proportionally
 * among every real miner who submitted a valid share on ANY pool running
 * the SAME COIN within the rolling time window.
 *
 * Example: CPU mines a DGB-Skein block → only workers on dgb-skein,
 * dgb-scrypt, dgb-sha256d, etc. receive the bonus. Workers on a BTC or
 * LTC pool in the same MagoFonte instance are unaffected.
 *
 * Design goals
 * ────────────
 *  • Same-coin fairness — bonus stays within the coin ecosystem that
 *    generated it. A DGB block bonus rewards DGB workers regardless of
 *    which DGB algorithm they are hashing.
 *  • Completely separate from per-pool PPLNS earnings.
 *  • Time-window based (default 30 min) with recency weighting.
 *  • Dust carry-forward per user per coin.
 *
 * Integration
 * ───────────
 *  1. Singleton on registry:  registry.bonusLedger = new BonusLedger(registry, opts)
 *  2. Pool registers:         registry.bonusLedger.registerPool('dgb-skein', 'dgb', payout)
 *  3. Share recorded:         registry.bonusLedger.recordShare('dgb-skein', 'dgb', user, diff)
 *  4. CPU block:              registry.bonusLedger.cpuBlockFound(reward, { coin:'dgb', ... })
 *
 * Exports
 * ────────
 *  BonusLedger  —  EventEmitter
 *    .registerPool(poolId, coin, payoutTracker)
 *    .unregisterPool(poolId)
 *    .recordShare(poolId, coin, user, difficulty)
 *    .cpuBlockFound(rewardSatoshis, meta)   meta must include { coin }
 *    .getStats(coin?)                       pass coin to filter, omit for all
 *    events:
 *      'bonus:distributed'  { coin, reward, pot, dust, allocations, workerCount }
 */

import { EventEmitter } from 'node:events';

export class BonusLedger extends EventEmitter {
  /**
   * @param {object} registry
   * @param {object} [opts]
   * @param {number} [opts.windowMs]        rolling window in ms (default: 30 min)
   * @param {number} [opts.operatorFeePct]  0–100, default 0
   * @param {number} [opts.dustThreshold]   min satoshis per user per payout (default: 1000)
   */
  constructor(registry, opts = {}) {
    super();
    this.registry       = registry;
    this.windowMs       = opts.windowMs       ?? 30 * 60 * 1000;
    this.operatorFeePct = Math.max(0, Math.min(100, opts.operatorFeePct ?? 0));
    this.dustThreshold  = opts.dustThreshold  ?? 1000;

    // poolId → { coin, payoutTracker }
    this._pools = new Map();

    // Rolling share window: { poolId, coin, user, diff, ts }
    this._shares = [];

    // Dust carry-over keyed by `${coin}:${user}`
    this._dust = {};

    // All-time earnings keyed by `${coin}:${user}`
    this._allTime = {};

    // All-time CPU blocks
    this._cpuBlocks = [];

    this._pruneTimer = setInterval(() => this._prune(), 60_000);
    this._pruneTimer.unref?.();

    console.log(`[bonus] ledger ready — window=${this.windowMs/60000}min fee=${this.operatorFeePct}%`);
  }

  // ── Registration ────────────────────────────────────────────────

  /**
   * @param {string} poolId         e.g. 'dgb-skein'
   * @param {string} coin           e.g. 'dgb'
   * @param {object} payoutTracker  PayoutTracker instance
   */
  registerPool(poolId, coin, payoutTracker) {
    this._pools.set(poolId, { coin: coin.toLowerCase(), payoutTracker });
    console.log(`[bonus] registered pool: ${poolId} (coin=${coin})`);
  }

  unregisterPool(poolId) {
    this._pools.delete(poolId);
  }

  // ── Share recording ──────────────────────────────────────────────

  /**
   * Record a valid share. Call on every accepted share from any pool.
   * @param {string} poolId
   * @param {string} coin    normalised coin ticker, e.g. 'dgb'
   * @param {string} user
   * @param {number} diff
   */
  recordShare(poolId, coin, user, diff) {
    if (user === 'server') return;
    this._shares.push({ poolId, coin: coin.toLowerCase(), user, diff, ts: Date.now() });
  }

  // ── CPU block distribution ───────────────────────────────────────

  /**
   * Distribute a CPU-mined block reward to workers on the same coin.
   * @param {number} rewardSatoshis
   * @param {object} meta   must include { coin }, optionally { height, hashHex }
   */
  cpuBlockFound(rewardSatoshis, meta = {}) {
    this._prune();

    const coin = (meta.coin || '').toLowerCase();
    if (!coin) {
      console.warn('[bonus] cpuBlockFound called without coin in meta — skipping distribution');
      return { reward: rewardSatoshis, pot: 0, allocations: {} };
    }

    const now    = Date.now();
    // ── Only shares from the same coin within the window ──
    const window = this._shares.filter(s => s.coin === coin && now - s.ts <= this.windowMs);

    const feeSats = Math.floor(rewardSatoshis * this.operatorFeePct / 100);
    const pot     = rewardSatoshis - feeSats;

    if (window.length === 0 || pot <= 0) {
      console.log(`[bonus] CPU block (${coin}) — no active ${coin} workers in window, reward held as dust`);
      this._cpuBlocks.push({ ...meta, coin, reward: rewardSatoshis, allocated: 0, allocations: {}, ts: now });
      return { coin, reward: rewardSatoshis, pot, dust: pot, allocations: {} };
    }

    // ── Weight by diff × recency (1.0 fresh → 0.5 at window edge) ──
    const userWeight = {};
    for (const s of window) {
      const recency = 1.0 - 0.5 * ((now - s.ts) / this.windowMs);
      userWeight[s.user] = (userWeight[s.user] || 0) + s.diff * recency;
    }
    const totalWeight = Object.values(userWeight).reduce((a, b) => a + b, 0);

    // ── Raw allocation + carry dust ──
    const rawAlloc = {};
    for (const [user, weight] of Object.entries(userWeight)) {
      const dustKey      = `${coin}:${user}`;
      rawAlloc[user]     = Math.floor(pot * weight / totalWeight) + (this._dust[dustKey] || 0);
    }

    // ── Apply dust threshold ──
    const allocations = {};
    let totalPaid = 0, newDust = 0;
    for (const [user, amount] of Object.entries(rawAlloc)) {
      const dustKey = `${coin}:${user}`;
      if (amount >= this.dustThreshold) {
        allocations[user]    = amount;
        totalPaid           += amount;
        this._dust[dustKey]  = 0;
        const atKey          = `${coin}:${user}`;
        this._allTime[atKey] = (this._allTime[atKey] || 0) + amount;
      } else {
        this._dust[dustKey] = amount;
        newDust            += amount;
      }
    }

    const result = {
      coin, reward: rewardSatoshis, operatorFee: feeSats, pot,
      totalPaid, dust: newDust, allocations,
      workerCount: Object.keys(userWeight).length,
      windowShares: window.length,
      meta,
    };

    this._cpuBlocks.push({ ...meta, coin, reward: rewardSatoshis, allocated: totalPaid, allocations, ts: now });

    console.log(`[bonus] CPU block (${coin}) pot=${pot}sat → ${Object.keys(allocations).length} workers, dust=${newDust}sat, fee=${feeSats}sat`);
    for (const [user, amt] of Object.entries(allocations))
      console.log(`  [bonus]   ${user}: +${amt}sat`);

    this.emit('bonus:distributed', result);
    this.registry.emit('bonus:distributed', result);
    return result;
  }

  // ── Stats ────────────────────────────────────────────────────────

  /**
   * @param {string} [filterCoin]  if provided, only show data for that coin
   */
  getStats(filterCoin) {
    this._prune();
    const now    = Date.now();
    const coin   = filterCoin?.toLowerCase();
    const window = this._shares.filter(s =>
      now - s.ts <= this.windowMs && (!coin || s.coin === coin)
    );

    const userWeight = {};
    for (const s of window) {
      const recency = 1.0 - 0.5 * ((now - s.ts) / this.windowMs);
      const key = `${s.coin}:${s.user}`;
      userWeight[key] = (userWeight[key] || 0) + s.diff * recency;
    }
    const totalWeight = Object.values(userWeight).reduce((a, b) => a + b, 0) || 1;
    const userShares  = {};
    for (const [k, w] of Object.entries(userWeight))
      userShares[k] = { weight: w, sharePct: +(w / totalWeight * 100).toFixed(2) };

    // Group all-time earnings by coin
    const allTimeEarnings = {};
    for (const [k, v] of Object.entries(this._allTime)) {
      const [c, u] = k.split(':');
      if (coin && c !== coin) continue;
      if (!allTimeEarnings[c]) allTimeEarnings[c] = {};
      allTimeEarnings[c][u] = v;
    }

    const relevantBlocks = coin
      ? this._cpuBlocks.filter(b => b.coin === coin)
      : this._cpuBlocks;

    return {
      windowMs:        this.windowMs,
      windowShares:    window.length,
      activePools:     [...this._pools.entries()].map(([id,{coin}])=>({id,coin})),
      activeWorkers:   Object.keys(userWeight).length,
      userShares,
      dust:            Object.fromEntries(Object.entries(this._dust).filter(([k])=>!coin||k.startsWith(coin+':'))),
      allTimeEarnings,
      cpuBlocksFound:  relevantBlocks.length,
      recentCpuBlocks: relevantBlocks.slice(-10),
    };
  }

  // ── Internal ─────────────────────────────────────────────────────

  _prune() {
    const keep = this.windowMs + 60_000;
    this._shares = this._shares.filter(s => Date.now() - s.ts < keep);
  }

  destroy() {
    clearInterval(this._pruneTimer);
  }
}
