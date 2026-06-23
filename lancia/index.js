/**
 * lancia/index.js — ESM core module
 * Fleet management for Lancia instances.
 * Backends: mock (default) | fly (Fly.io Machines API)
 * Set LANCIA_BACKEND=fly + FLY_API_TOKEN + FLY_APP_NAME for production.
 */

const BACKENDS = {
  mock: () => import('./backends/mock.js'),
  fly:  () => import('./backends/fly.js'),
};

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

class Lancia {
  constructor() { this.backend = null; }
  get name() { return 'lancia'; }

  async init(config = {}) {
    const bName = process.env.LANCIA_BACKEND || config.backend || 'mock';
    const loader = BACKENDS[bName] || BACKENDS.mock;
    const mod = await loader();
    this.backend = mod.default;
    console.log(`[lancia] backend: ${bName}`);
    return this;
  }

  get routes() {
    const self = this;
    return [
      // GET /api/v1/lancia/instances
      ['GET', '/instances', async (req, res) => {
        try { const instances = await self.backend.list(); json(res, 200, { instances, total: instances.length }); }
        catch (e) { json(res, 500, { error: e.message }); }
      }, { minRole: 'member' }],

      // POST /api/v1/lancia/instances
      ['POST', '/instances', async (req, res) => {
        let body = ''; req.on('data', d => body += d);
        req.on('end', async () => {
          try {
            const b = JSON.parse(body);
            if (!b.name) return json(res, 400, { error: 'name required' });
            json(res, 201, await self.backend.create(b));
          } catch (e) { json(res, 500, { error: e.message }); }
        });
      }, { minRole: 'owner' }],

      // POST /api/v1/lancia/instances/:id/restart
      ['POST', '/instances/:id/restart', async (req, res) => {
        try { json(res, 200, await self.backend.restart(req.params.id)); }
        catch (e) { json(res, 500, { error: e.message }); }
      }, { minRole: 'owner' }],

      // DELETE /api/v1/lancia/instances/:id
      ['DELETE', '/instances/:id', async (req, res) => {
        try { await self.backend.destroy(req.params.id); json(res, 200, { destroyed: true, id: req.params.id }); }
        catch (e) { json(res, 500, { error: e.message }); }
      }, { minRole: 'owner' }],

      // POST /api/v1/lancia/instances/start-all
      ['POST', '/instances/start-all', async (req, res) => {
        try {
          const list    = await self.backend.list();
          const results = await Promise.allSettled(list.map(i => self.backend.restart(i.id)));
          json(res, 200, { started: results.filter(r => r.status==='fulfilled').length, total: list.length });
        } catch (e) { json(res, 500, { error: e.message }); }
      }, { minRole: 'owner' }],

      // POST /api/v1/lancia/instances/stop-all
      ['POST', '/instances/stop-all', async (req, res) => {
        try {
          const list    = await self.backend.list();
          const results = await Promise.allSettled(list.map(i => self.backend.destroy(i.id)));
          json(res, 200, { stopped: results.filter(r => r.status==='fulfilled').length, total: list.length });
        } catch (e) { json(res, 500, { error: e.message }); }
      }, { minRole: 'owner' }],
    ];
  }
}

export default new Lancia();
