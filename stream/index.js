/**
 * stream/index.js — ESM core module
 * API billing. Tiers: free/basic/pro. Writes to stream_subscriptions + revenue_ledger.
 */
import { createClient } from '@supabase/supabase-js';

const TIERS = {
  free:  { dailyLimit: 100,       price_sol_month: 0     },
  basic: { dailyLimit: 10000,     price_sol_month: 0.05  },
  pro:   { dailyLimit: Infinity,  price_sol_month: 0.20  },
};

class Stream {
  constructor() { this.supabase = null; this._usage = new Map(); }
  get name() { return 'stream'; }

  async init(config = {}) {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      this.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    }
    console.log('[stream] API billing active — tiers: free/basic/pro');
    return this;
  }

  async getTier(userId) {
    if (!this.supabase) return 'free';
    const { data } = await this.supabase.from('stream_subscriptions')
      .select('tier').eq('user_id', userId).gt('expires_at', new Date().toISOString()).maybeSingle();
    return data?.tier || 'free';
  }

  async checkAndMeter(userId) {
    const tier  = await this.getTier(userId);
    const limit = TIERS[tier].dailyLimit;
    const key   = `${userId}:${new Date().toISOString().slice(0, 10)}`;
    const usage = this._usage.get(key) || 0;
    if (usage >= limit) return { allowed: false, tier, usage, limit };
    this._usage.set(key, usage + 1);
    return { allowed: true, tier, usage: usage + 1, limit };
  }

  async recordSubscription({ userId, tier, txid }) {
    if (!TIERS[tier]) throw new Error(`unknown tier: ${tier}`);
    if (!this.supabase) throw new Error('db unavailable');
    const expires_at = new Date(Date.now() + 30 * 86400000).toISOString();
    await this.supabase.from('stream_subscriptions').upsert({ user_id: userId, tier, txid, subscribed_at: new Date().toISOString(), expires_at });
    await this.supabase.from('revenue_ledger').insert({
      source: 'stream', type: 'subscription', amount: TIERS[tier].price_sol_month,
      network: 'solana', metadata: JSON.stringify({ userId, tier, txid }), created_at: new Date().toISOString()
    });
    return { tier, expires_at };
  }

  get routes() {
    const self = this;
    function json(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
    return [
      ['GET',  '/tiers',      (req, res) => json(res, 200, TIERS), { public: true }],
      ['POST', '/subscribe',  async (req, res) => {
        let body = ''; req.on('data', d => body += d);
        req.on('end', async () => {
          try { json(res, 200, await self.recordSubscription(JSON.parse(body))); }
          catch (e) { json(res, 400, { error: e.message }); }
        });
      }, { minRole: 'member' }],
      ['GET',  '/status',     async (req, res) => {
        const userId = req.user?.id || 'anon';
        json(res, 200, { tier: await self.getTier(userId) });
      }, { minRole: 'member' }],
    ];
  }
}

export default new Stream();
