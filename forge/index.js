'use strict';
/**
 * forge/index.js
 * Premium feature access module.
 * Handles paid feature gates, access tokens, and operator fee collection
 * for premium MagoFonte capabilities.
 *
 * Revenue flow: user pays → forge validates → access granted → fee logged to revenue_ledger
 */

const { createClient } = require('@supabase/supabase-js');

const FEATURES = {
  'advanced-analytics': { name: 'Advanced Analytics',   price_sol: 0.1,  duration_days: 30 },
  'priority-stratum':   { name: 'Priority Stratum',      price_sol: 0.05, duration_days: 30 },
  'custom-vardiff':     { name: 'Custom VarDiff Config', price_sol: 0.02, duration_days: 30 },
  'multi-wallet':       { name: 'Multi-Wallet Routing',  price_sol: 0.15, duration_days: 30 },
  'api-access':         { name: 'API Data Access',       price_sol: 0.08, duration_days: 30 },
};

class Forge {
  constructor(config = {}) {
    this.config  = config;
    this.supabase = null;
  }

  async init() {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      this.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    }
    console.log('[forge] Initialized — premium feature gate active');
  }

  listFeatures() { return FEATURES; }

  async checkAccess(userId, featureId) {
    if (!this.supabase) return { granted: false, reason: 'supabase not configured' };
    const { data } = await this.supabase
      .from('forge_access')
      .select('*')
      .eq('user_id', userId)
      .eq('feature_id', featureId)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    return { granted: !!data, record: data };
  }

  async grantAccess(userId, featureId, txid) {
    if (!this.supabase) throw new Error('[forge] Supabase not configured');
    const feature = FEATURES[featureId];
    if (!feature) throw new Error(`[forge] Unknown feature: ${featureId}`);
    const expires_at = new Date(Date.now() + feature.duration_days * 86400000).toISOString();
    const { error } = await this.supabase.from('forge_access').upsert({
      user_id: userId, feature_id: featureId,
      granted_at: new Date().toISOString(), expires_at, txid,
      price_sol: feature.price_sol
    });
    if (error) throw error;
    // Log to revenue_ledger
    await this.supabase.from('revenue_ledger').insert({
      source: 'forge', type: 'feature_access', amount: feature.price_sol,
      network: 'solana', metadata: JSON.stringify({ userId, featureId, txid }),
      created_at: new Date().toISOString()
    });
    return { granted: true, expires_at, feature };
  }

  registerRoutes(app, ward) {
    app.get('/forge/features', (req, res) => res.json(this.listFeatures()));
    app.get('/forge/access/:featureId', ward.require('user'), async (req, res) => {
      const result = await this.checkAccess(req.user.id, req.params.featureId);
      res.json(result);
    });
    app.post('/forge/grant', ward.require('owner'), async (req, res) => {
      try {
        const result = await this.grantAccess(req.body.userId, req.body.featureId, req.body.txid);
        res.json(result);
      } catch (e) { res.status(400).json({ error: e.message }); }
    });
  }
}

module.exports = new Forge();
