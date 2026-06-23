'use strict';
/**
 * stream/index.js
 * Data stream / API subscription billing module.
 * Meters API usage and charges subscribers at configurable rates.
 *
 * Tiers:
 *   free   — 100 req/day, no charge
 *   basic  — 10,000 req/day, 0.05 SOL/month
 *   pro    — unlimited,   0.20 SOL/month
 *
 * Revenue: monthly subscription fee logged to revenue_ledger.
 */

const { createClient } = require('@supabase/supabase-js');

const TIERS = {
  free:  { dailyLimit: 100,      price_sol_month: 0     },
  basic: { dailyLimit: 10000,    price_sol_month: 0.05  },
  pro:   { dailyLimit: Infinity, price_sol_month: 0.20  },
};

class Stream {
  constructor(config = {}) {
    this.supabase = null;
    this._usage   = new Map(); // in-memory: userId → { count, day }
  }

  async init() {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      this.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    }
    console.log('[stream] Initialized — API billing active');
  }

  async getTier(userId) {
    if (!this.supabase) return 'free';
    const { data } = await this.supabase
      .from('stream_subscriptions')
      .select('tier')
      .eq('user_id', userId)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    return data?.tier || 'free';
  }

  async checkAndMeter(userId) {
    const tier = await this.getTier(userId);
    const limit = TIERS[tier].dailyLimit;
    const today = new Date().toISOString().slice(0, 10);
    const key = `${userId}:${today}`;
    const usage = this._usage.get(key) || 0;
    if (usage >= limit) return { allowed: false, tier, usage, limit };
    this._usage.set(key, usage + 1);
    return { allowed: true, tier, usage: usage + 1, limit };
  }

  async recordSubscription({ userId, tier, txid }) {
    if (!TIERS[tier]) throw new Error(`[stream] Unknown tier: ${tier}`);
    if (!this.supabase) throw new Error('[stream] Supabase not configured');
    const expires_at = new Date(Date.now() + 30 * 86400000).toISOString();
    await this.supabase.from('stream_subscriptions').upsert({
      user_id: userId, tier, txid,
      subscribed_at: new Date().toISOString(), expires_at
    });
    await this.supabase.from('revenue_ledger').insert({
      source: 'stream', type: 'subscription', amount: TIERS[tier].price_sol_month,
      network: 'solana', metadata: JSON.stringify({ userId, tier, txid }),
      created_at: new Date().toISOString()
    });
    return { tier, expires_at };
  }

  middleware() {
    return async (req, res, next) => {
      const userId = req.user?.id || req.headers['x-api-key'] || 'anon';
      const result = await this.checkAndMeter(userId);
      if (!result.allowed) {
        return res.status(429).json({ error: 'Rate limit exceeded', tier: result.tier, upgrade: '/stream/subscribe' });
      }
      res.setHeader('X-RateLimit-Tier', result.tier);
      res.setHeader('X-RateLimit-Remaining', result.limit - result.usage);
      next();
    };
  }

  registerRoutes(app, ward) {
    app.get('/stream/tiers', (req, res) => res.json(TIERS));
    app.post('/stream/subscribe', ward.require('user'), async (req, res) => {
      try { res.json(await this.recordSubscription(req.body)); }
      catch (e) { res.status(400).json({ error: e.message }); }
    });
  }
}

module.exports = new Stream();
