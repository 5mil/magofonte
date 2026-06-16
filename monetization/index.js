/**
 * MagoFonte — monetization module
 *
 * Collects revenue from all registered sources and sweeps
 * normalized amounts to the owner-controlled treasury wallet.
 *
 * Active collectors:
 *   • LpCollector   — Meteora/Raydium LP fees → Solana treasury
 *   • PoolCollector  — DGB block operator fee + CPU bonus cut → DGB treasury
 *
 * Routes (all owner-gated):
 *   GET  /status    — pending balances, treasury addresses
 *   GET  /ledger    — paginated revenue event log
 *   POST /sweep     — manual sweep (Solana)
 *   POST /sweep-dgb — manual sweep (DGB)
 *   GET  /sources   — registered revenue sources + state
 */

import { LpCollector }   from './lp-collector.js';
import { PoolCollector } from './pool-collector.js';
import { Sweeper }       from './sweeper.js';
import { Ledger }        from './ledger.js';
import { Treasury }      from './treasury.js';

const Monetization = {
  name: 'monetization',

  async init(config, registry) {
    this.config   = config;
    this.registry = registry;

    this.treasury      = new Treasury(config);
    this.ledger        = new Ledger(config);
    this.sweeper       = new Sweeper(config, this.treasury, this.ledger);
    this.lpCollector   = new LpCollector(config, this.sweeper, this.ledger);
    this.poolCollector = new PoolCollector(config, this.sweeper, this.ledger, registry);

    // Start automated LP collection loop
    this._startLoop();

    return this;
  },

  _startLoop() {
    const intervalMs = (this.config.collectIntervalMinutes || 30) * 60 * 1000;
    const run = async () => {
      try { await this.lpCollector.collect(); }
      catch (err) { console.error('[monetization] LP collection error:', err.message); }
    };
    run();
    setInterval(run, intervalMs);
    console.log(`[monetization] LP collector loop started — every ${this.config.collectIntervalMinutes || 30} min`);
  },

  get routes() {
    const self = this;
    return [
      ['GET', '/status', async (req, res) => {
        if (!self._ownerGuard(req, res)) return;
        const status = await self.sweeper.status();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
      }],

      ['GET', '/ledger', async (req, res) => {
        if (!self._ownerGuard(req, res)) return;
        const qs     = req.url.includes('?') ? new URLSearchParams(req.url.split('?')[1]) : new URLSearchParams();
        const limit  = parseInt(qs.get('limit')  || '50', 10);
        const offset = parseInt(qs.get('offset') || '0',  10);
        const events = await self.ledger.list(limit, offset);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(events));
      }],

      ['POST', '/sweep', async (req, res) => {
        if (!self._ownerGuard(req, res)) return;
        const result = await self.sweeper.sweep('manual');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }],

      ['POST', '/sweep-dgb', async (req, res) => {
        if (!self._ownerGuard(req, res)) return;
        const result = await self.sweeper.sweepPool('manual');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }],

      ['GET', '/sources', async (req, res) => {
        if (!self._ownerGuard(req, res)) return;
        const sources = [
          { id: 'lp_fees',   name: 'LP Fee Collector (Solana)',  status: 'active',   online: true,  ...{} },
          { id: 'pool_fees', name: 'Pool Fee Collector (DGB)',   status: 'active',   online: true,  ...self.poolCollector.stats() },
          { id: 'forge',     name: 'Premium Access',             status: 'disabled', online: true  },
          { id: 'bridge',    name: 'Bridge Fees',                status: 'disabled', online: true  },
          { id: 'sigil',     name: 'Affiliate Rewards',          status: 'disabled', online: true  },
          { id: 'mesh',      name: 'Compute Rewards',            status: 'disabled', online: true  },
        ];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sources }));
      }],
    ];
  },

  _ownerGuard(req, res) {
    const ward = this.registry?.get?.('ward');
    if (ward) {
      const ok = ward.hasRole(req, 'owner');
      if (!ok) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Owner role required' }));
        return false;
      }
    }
    return true;
  },
};

export default Monetization;
