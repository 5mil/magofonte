/**
 * Pool Fee Collector
 *
 * Hooks into the MagoFonte registry event bus to capture revenue
 * from every block found by the pool (CPU miner or external Stratum miners).
 *
 * Revenue sources:
 *   block:found  — operator fee % deducted from coinbase reward before PPLNS payout
 *   bonus:paid   — operator cut of CPU bonus blocks (BonusLedger.operatorFeePct)
 *
 * The DGB amounts are logged to Supabase revenue_ledger and routed to
 * TREASURY_DGB_ADDRESS (falls back to DGB_REWARD_ADDRESS).
 *
 * Operator fee is set via config.operatorFeePct (default: 1% = 0.01)
 * Set to 0 to run a 0-fee pool while still logging all block events.
 */

export class PoolCollector {
  constructor(config, sweeper, ledger, registry) {
    this.config   = config;
    this.sweeper  = sweeper;
    this.ledger   = ledger;
    this.registry = registry;

    // Operator fee as a fraction  e.g. 0.01 = 1%
    this.feePct = config.operatorFeePct ?? 0.01;

    this._attach();
  }

  _attach() {
    // block:found — emitted by MinerSession and CpuMinerSession on every found block
    this.registry.on('block:found', async ({ user, height, reward }) => {
      await this._onBlockFound({ user, height, reward });
    });

    // bonus:paid — emitted by BonusLedger after distributing a CPU block
    // Carries the operator cut already computed by BonusLedger.operatorFeePct
    this.registry.on('bonus:paid', async ({ height, coin, operatorCut, totalReward }) => {
      await this._onBonusPaid({ height, coin, operatorCut, totalReward });
    });

    console.log(`[pool-collector] attached — operator fee ${(this.feePct * 100).toFixed(2)}%`);
  }

  async _onBlockFound({ user, height, reward }) {
    if (!reward || reward <= 0) return;

    const feeSats    = Math.floor(reward * this.feePct);
    const treasury   = process.env.TREASURY_DGB_ADDRESS
                    || process.env.DGB_REWARD_ADDRESS
                    || null;

    console.log(
      `[pool-collector] block h=${height} reward=${reward}sat fee=${feeSats}sat (${(this.feePct*100).toFixed(2)}%) → ${treasury ?? 'no treasury set'}`
    );

    const event = {
      source:      'pool_fees',
      type:        'block_fee',
      amount:      feeSats.toString(),
      metadata: {
        height,
        miner:       user,
        total_reward: reward,
        fee_pct:     this.feePct,
        treasury,
        coin:        'dgb',
        captured_at: new Date().toISOString(),
      },
      status: 'pending',
    };

    await this.ledger.record(event);

    if (feeSats > 0) {
      await this.sweeper.queuePoolEvent(event);
    }
  }

  async _onBonusPaid({ height, coin, operatorCut, totalReward }) {
    if (!operatorCut || operatorCut <= 0) return;

    const treasury = process.env.TREASURY_DGB_ADDRESS
                  || process.env.DGB_REWARD_ADDRESS
                  || null;

    console.log(
      `[pool-collector] CPU bonus h=${height} operatorCut=${operatorCut}sat → ${treasury ?? 'no treasury set'}`
    );

    const event = {
      source:   'pool_fees',
      type:     'bonus_cut',
      amount:   operatorCut.toString(),
      metadata: {
        height,
        coin:         coin || 'dgb',
        total_reward: totalReward,
        treasury,
        captured_at:  new Date().toISOString(),
      },
      status: 'pending',
    };

    await this.ledger.record(event);
    await this.sweeper.queuePoolEvent(event);
  }

  stats() {
    return {
      source:     'pool_fees',
      feePct:     this.feePct,
      treasury:   process.env.TREASURY_DGB_ADDRESS || process.env.DGB_REWARD_ADDRESS || null,
      listening:  ['block:found', 'bonus:paid'],
    };
  }
}
