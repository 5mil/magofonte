/**
 * bridge/index.js — ESM core module
 * Cross-chain swap fee capture. Writes to revenue_ledger.
 */
import { createClient } from '@supabase/supabase-js';

const DEFAULT_FEE_PCT = 0.005;
const ROUTES = [
  { id: 'dgb-sol', from: 'DGB', to: 'SOL', active: true  },
  { id: 'ltc-sol', from: 'LTC', to: 'SOL', active: true  },
  { id: 'dgb-ltc', from: 'DGB', to: 'LTC', active: false },
];

class Bridge {
  constructor() { this.supabase = null; this.feePct = DEFAULT_FEE_PCT; }
  get name() { return 'bridge'; }

  async init(config = {}) {
    this.feePct = config.feePct || DEFAULT_FEE_PCT;
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      this.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    }
    console.log('[bridge] swap routes:', ROUTES.filter(r => r.active).map(r => r.id).join(', '));
    return this;
  }

  async recordSwap({ routeId, amountIn, amountOut, txid, timestamp }) {
    const route = ROUTES.find(r => r.id === routeId);
    if (!route) throw new Error(`unknown route: ${routeId}`);
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

  get routes() {
    const self = this;
    function json(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
    return [
      ['GET',  '/routes', (req, res) => json(res, 200, ROUTES), { public: true }],
      ['POST', '/swap',   async (req, res) => {
        let body = ''; req.on('data', d => body += d);
        req.on('end', async () => {
          try { json(res, 200, await self.recordSwap(JSON.parse(body))); }
          catch (e) { json(res, 400, { error: e.message }); }
        });
      }, { minRole: 'owner' }],
    ];
  }
}

export default new Bridge();
