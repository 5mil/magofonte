/**
 * forge/index.js — ESM core module
 * Premium feature gate. Writes to forge_access + revenue_ledger.
 */
import { createClient } from '@supabase/supabase-js';

const FEATURES = {
  'advanced-analytics': { name: 'Advanced Analytics',   price_sol: 0.10, duration_days: 30 },
  'priority-stratum':   { name: 'Priority Stratum',      price_sol: 0.05, duration_days: 30 },
  'custom-vardiff':     { name: 'Custom VarDiff Config', price_sol: 0.02, duration_days: 30 },
  'multi-wallet':       { name: 'Multi-Wallet Routing',  price_sol: 0.15, duration_days: 30 },
  'api-access':         { name: 'API Data Access',       price_sol: 0.08, duration_days: 30 },
};

class Forge {
  constructor() { this.supabase = null; }
  get name() { return 'forge'; }

  async init(config = {}) {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      this.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    }
    console.log('[forge] premium feature gate ready');
    return this;
  }

  async checkAccess(userId, featureId) {
    if (!this.supabase) return { granted: false, reason: 'db_unavailable' };
    const { data } = await this.supabase.from('forge_access').select('*')
      .eq('user_id', userId).eq('feature_id', featureId)
      .gt('expires_at', new Date().toISOString()).maybeSingle();
    return { granted: !!data, record: data };
  }

  async grantAccess(userId, featureId, txid) {
    const f = FEATURES[featureId];
    if (!f) throw new Error(`unknown feature: ${featureId}`);
    if (!this.supabase) throw new Error('db unavailable');
    const expires_at = new Date(Date.now() + f.duration_days * 86400000).toISOString();
    await this.supabase.from('forge_access').upsert({
      user_id: userId, feature_id: featureId,
      granted_at: new Date().toISOString(), expires_at, txid, price_sol: f.price_sol
    });
    await this.supabase.from('revenue_ledger').insert({
      source: 'forge', type: 'feature_access', amount: f.price_sol, network: 'solana',
      metadata: JSON.stringify({ userId, featureId, txid }), created_at: new Date().toISOString()
    });
    return { granted: true, expires_at, feature: f };
  }

  get routes() {
    const self = this;
    function json(res, code, body) {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    }
    return [
      ['GET',  '/features',              (req, res) => json(res, 200, FEATURES), { public: true }],
      ['GET',  '/access/:featureId',     async (req, res) => {
        const r = await self.checkAccess(req.user?.id || 'anon', req.params.featureId);
        json(res, 200, r);
      }, { minRole: 'member' }],
      ['POST', '/grant',                 async (req, res) => {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', async () => {
          try { const b = JSON.parse(body); json(res, 200, await self.grantAccess(b.userId, b.featureId, b.txid)); }
          catch (e) { json(res, 400, { error: e.message }); }
        });
      }, { minRole: 'owner' }],
    ];
  }
}

export default new Forge();
