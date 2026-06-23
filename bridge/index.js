'use strict';
/**
 * bridge/index.js
 * Cross-chain bridge fee capture module.
 * Monitors cross-chain swap events and records operator fees.
 *
 * Supported routes (read-only monitoring, no custody):
 *   DGB ↔ SOL   (via wrapped tokens / DEX)
 *   LTC ↔ SOL   (via wrapped tokens / DEX)
 *   DGB ↔ LTC   (atomic swap ready)
 *
 * Revenue: operator captures a configurable fee % on each observed swap.
 */

const { createClient } = require('@supabase/supabase-js');

const DEFAULT_FEE_PCT = 0.005; // 0.5%

const ROUTES = [
  { id: 'dgb-sol', from: 'DGB', to: 'SOL',  active: true  },
  { id: 'ltc-sol', from: 'LTC', to: 'SOL',  active: true  },
  { id: 'dgb-ltc', from: 'DGB', to: 'LTC',  active: false }, // atomic swap, future
];

class Bridge {
  constructor(config = {}) {
    this.feePct   = config.feePct || DEFAULT_FEE_PCT;
    this.supabase = null;
    this.routes   = ROUTES;
  }

  async init() {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      this.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    }
    console.log('[bridge] Initialized — monitoring swap routes:', this.routes.filter(r => r.active).map(r => r.id).join(', '));
  }

  async recordSwap({ routeId, amountIn, amountOut, txid, timestamp }) {
    const route = this.routes.find(r => r.id === routeId);
    if (!route) throw new Error(`[bridge] Unknown route: ${routeId}`);
    const fee = amountOut * this.feePct;
    if (this.supabase) {
      await this.supabase.from('revenue_ledger').insert({
        source: 'bridge', type: 'swap_fee', amount: fee,
        network: route.to.toLowerCase(),
        metadata: JSON.stringify({ routeId, amountIn, amountOut, txid }),
        created_at: timestamp || new Date().toISOString()
      });
    }
    return { fee, route, txid };
  }

  listRoutes() { return this.routes; }

  registerRoutes(app, ward) {
    app.get('/bridge/routes', (req, res) => res.json(this.listRoutes()));
    app.post('/bridge/swap', ward.require('owner'), async (req, res) => {
      try { res.json(await this.recordSwap(req.body)); }
      catch (e) { res.status(400).json({ error: e.message }); }
    });
  }
}

module.exports = new Bridge();
