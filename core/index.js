/**
 * MagoFonte — Core
 * Module host, HTTP server, plugin registry.
 *
 * Auth model (lancia — hardened)
 * ───────────────────────────────
 * Authentication and authorization are owned entirely by the ward module.
 * There is no API key. There is no shared secret in environment variables.
 *
 * Every route carries scope + minRole metadata.
 * ward.authenticate(minRole, scope) is called automatically by the router
 * before any handler fires — no route can forget to call it.
 *
 * Public routes (no auth):
 *   GET  /
 *   GET  /health
 *   GET  /.well-known/jwks.json
 *   POST /api/v1/ward/setup          (first-run only)
 *   GET  /api/v1/ward/challenge
 *   POST /api/v1/ward/login
 *   POST /api/v1/ward/login/cert
 *   POST /api/v1/ward/refresh
 *
 * Route registration:
 *   Module routes are 3-tuples:  [method, path, handler]
 *   OR 4-tuples:                 [method, path, handler, { scope, minRole, public }]
 *   If meta is omitted, defaults to authenticate('member', null).
 *   { public: true } skips auth entirely.
 */

import http           from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path           from 'node:path';
import { lookupScope } from '../ward/scopeMap.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const cfg = JSON.parse(readFileSync(new URL('../magofonte.config.json', import.meta.url)));

const PORT = parseInt(process.env.PORT || cfg.server?.port || 8080, 10);
const HOST = process.env.HOST || cfg.server?.host || '0.0.0.0';

// Explicit CORS origins — wildcard * is not permitted in the hardened build.
// Configure via cfg.cors.origins or CORS_ORIGINS env var (comma-separated).
const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : (cfg.cors?.origins || ['http://localhost:8080', 'http://127.0.0.1:8080']);

function corsOrigin(req) {
  const origin = req.headers['origin'] || '';
  return CORS_ORIGINS.includes(origin) ? origin : CORS_ORIGINS[0];
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const registry = {
  modules: {},
  hooks:   {},

  register(mod) {
    this.modules[mod.name] = mod;
    console.log(`[core] registered module: ${mod.name}`);
  },

  on(event, fn) {
    if (!this.hooks[event]) this.hooks[event] = [];
    this.hooks[event].push(fn);
  },

  emit(event, data) {
    (this.hooks[event] || []).forEach(fn => fn(data));
  },

  get(name) {
    return this.modules[name];
  }
};

// ─── Route table ──────────────────────────────────────────────────────────────
//
// Each entry: { handler, meta }
// meta: { scope?: string, minRole?: string, public?: boolean }
//
// Routes registered before ward loads carry issuers = null.
// After loadModules(), ward is resolved once from the registry.

const routes = {};
let   wardModule = null;  // resolved after all modules load

/**
 * Register a route.
 *
 * @param {string}   method
 * @param {string}   routePath
 * @param {Function} handler
 * @param {object}   [meta]           - { scope, minRole, public }
 */
function addRoute(method, routePath, handler, meta = {}) {
  routes[`${method}:${routePath}`] = { handler, meta };
}

// ─── Auth gate ────────────────────────────────────────────────────────────────
//
// Called by the router for every matched route.
// Returns a Promise that resolves to true (proceed) or false (response already sent).

async function applyAuth(req, res, routePath, meta) {
  // Public routes — no auth
  if (meta.public) return true;

  // Ward not yet loaded (should not happen in production — routes load after ward)
  if (!wardModule) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'auth_unavailable' }));
    return false;
  }

  // Derive scope + minRole:
  //   1. Explicit meta on the route (set by module)
  //   2. Lookup from scopeMap (canonical table)
  //   3. Default: member, no scope
  let scope   = meta.scope   ?? null;
  let minRole = meta.minRole ?? null;

  if (scope === null && minRole === null) {
    const mapped = lookupScope(req.method, routePath);
    if (mapped) {
      scope   = mapped.scope;
      minRole = mapped.minRole;
    }
  }

  minRole = minRole ?? 'member';

  // Run ward.authenticate() as middleware — returns a Promise
  return new Promise(resolve => {
    const mw = wardModule.authenticate(minRole, scope);
    mw(req, res, () => resolve(true));
    // If mw sends a response without calling next, the promise never resolves.
    // Attach a one-shot 'finish' listener to resolve(false) in that case.
    res.once('finish', () => resolve(false));
  });
}

// ─── HTTP router ──────────────────────────────────────────────────────────────

function _404(res) {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
}

const server = http.createServer(async (req, res) => {
  // CORS — explicit origin list, not wildcard
  const origin = corsOrigin(req);
  res.setHeader('Access-Control-Allow-Origin',  origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // Serve root index.html (always public)
  if (req.method === 'GET' && req.url.split('?')[0] === '/') {
    try {
      const html = readFileSync(new URL('../index.html', import.meta.url));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html);
    } catch { return _404(res); }
  }

  const urlPath = req.url.split('?')[0];

  // ── Exact route match ──────────────────────────────────────────────────────
  const exactKey = `${req.method}:${urlPath}`;
  if (routes[exactKey]) {
    const { handler, meta } = routes[exactKey];
    const ok = await applyAuth(req, res, urlPath, meta);
    if (ok) return handler(req, res);
    return;
  }

  // ── Prefix / :param route match ────────────────────────────────────────────
  for (const [pattern, { handler, meta }] of Object.entries(routes)) {
    const colonIdx = pattern.indexOf(':');
    // pattern format is "METHOD:path" — split on first colon
    const method  = pattern.slice(0, colonIdx);
    const patPath = pattern.slice(colonIdx + 1);
    if (method !== req.method) continue;
    const regex = new RegExp('^' + patPath.replace(/:[^/]+/g, '([^/]+)') + '$');
    const match = urlPath.match(regex);
    if (match) {
      const keys   = [...patPath.matchAll(/:([^/]+)/g)].map(x => x[1]);
      req.params   = Object.fromEntries(keys.map((k, i) => [k, match[i + 1]]));
      const ok = await applyAuth(req, res, urlPath, meta);
      if (ok) return handler(req, res);
      return;
    }
  }

  _404(res);
});

// ─── Built-in public routes ───────────────────────────────────────────────────

// Health — always public, no auth
addRoute('GET', '/health', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status:  'ok',
    branch:  'lancia',
    modules: Object.keys(registry.modules),
    uptime:  process.uptime(),
    ward:    wardModule ? 'ready' : 'loading',
    auth:    'ed25519-scope-bound',
  }));
}, { public: true });

// JWKS — always public, served at well-known path
addRoute('GET', '/.well-known/jwks.json', (req, res) => {
  if (!wardModule) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'issuer_not_ready' }));
  }
  // Forward to ward's /.well-known/jwks handler
  // ward registers this at /api/v1/ward/.well-known/jwks — call issuer directly
  const { issuer } = wardModule;
  if (!issuer) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'issuer_not_ready' }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(issuer.jwks()));
}, { public: true });

// ─── Load modules ─────────────────────────────────────────────────────────────
//
// Modules are loaded in config order.
// Ward MUST be first (or at least before any module whose routes need auth).
// After all modules load, wardModule is resolved from the registry.
//
// Module route format:
//   3-tuple: [method, path, handler]
//   4-tuple: [method, path, handler, meta]
//
// meta.public = true  → no auth
// meta.scope + meta.minRole → explicit override (skip scopeMap lookup)
// no meta → scopeMap lookup, then default to member

async function loadModules() {
  const modCfg      = cfg.modules;
  const moduleNames = Object.keys(modCfg).filter(k => modCfg[k].enabled);

  // Ensure ward loads first so authenticate() is available for subsequent modules
  const ordered = [
    ...moduleNames.filter(n => n === 'ward'),
    ...moduleNames.filter(n => n !== 'ward'),
  ];

  for (const name of ordered) {
    try {
      const modPath  = path.resolve(`${name}/index.js`);
      const mod      = await import(pathToFileURL(modPath));
      const instance = await mod.default.init(
        { ...cfg[name], ...modCfg[name] },
        registry
      );
      registry.register(instance);

      if (instance.routes) {
        for (const route of instance.routes) {
          const [method, routePath, handler, meta = {}] = route;
          addRoute(method, `/api/v1/${name}${routePath}`, handler, meta);
        }
      }

      // Resolve ward reference immediately after ward loads
      if (name === 'ward') {
        wardModule = instance;
        // Attach issuer reference so /.well-known/jwks.json can reach it
        if (!wardModule.issuer) {
          // ward/index.js may not export issuer directly — import it
          const issuerMod = await import(pathToFileURL(path.resolve('ward/issuer.js')));
          wardModule.issuer = issuerMod;
        }
        console.log('[core] ward loaded — scope-bound auth active');
      }
    } catch (err) {
      console.error(`[core] failed to load module "${name}":`, err.message, err.stack);
    }
  }

  if (!wardModule) {
    console.warn('[core] ⚠  ward module not loaded — all /api/* routes are UNPROTECTED');
  }
}

await loadModules();

server.listen(PORT, HOST, () => {
  console.log(`[core] MagoFonte ✨ lancia`);
  console.log(`[core] http://${HOST}:${PORT}`);
  console.log(`[core] modules: ${Object.keys(registry.modules).join(', ')}`);
  console.log(`[core] auth: ${wardModule ? 'Ed25519 scope-bound (ward)' : '⚠  UNPROTECTED'}`);
  console.log(`[core] cors: ${CORS_ORIGINS.join(', ')}`);
});
