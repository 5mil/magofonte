/**
 * MagoFonte — Core
 * Module host, HTTP server, plugin registry.
 * Each module exports: { name, init(config, registry), routes?, hooks? }
 *
 * API Key Auth (lancia branch)
 * ----------------------------
 * Set API_KEY env var to a secret string.
 * All /api/* requests must include it via:
 *   Authorization: Bearer <key>
 *   OR ?apiKey=<key> query param
 * /health and GET / are always public.
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// ─── Config ───────────────────────────────────────────────────────────────────
const cfg = JSON.parse(readFileSync(new URL('../magofonte.config.json', import.meta.url)));

// Allow PORT override from env (Render/Railway/Fly inject this)
const PORT = parseInt(process.env.PORT || cfg.server?.port || 8080, 10);
const HOST = process.env.HOST || cfg.server?.host || '0.0.0.0';

// API key — read from env; if absent, API is open (dev mode warning)
const API_KEY = process.env.API_KEY || null;
if (!API_KEY) {
  console.warn('[core] ⚠  API_KEY not set — all /api/* routes are unprotected (set API_KEY in env)');
}

// ─── Registry ─────────────────────────────────────────────────────────────────
const registry = {
  modules: {},
  hooks: {},

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

// ─── API Key middleware ────────────────────────────────────────────────────────
function checkApiKey(req, res) {
  if (!API_KEY) return true; // no key configured — open

  const url = req.url.split('?')[0];
  if (url === '/health' || url === '/' || req.method === 'OPTIONS') return true;
  if (!url.startsWith('/api/')) return true;

  // Authorization: Bearer <key>
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    if (authHeader.slice(7).trim() === API_KEY) return true;
  }

  // ?apiKey=<key>
  const qs = req.url.includes('?') ? new URLSearchParams(req.url.split('?')[1]) : null;
  if (qs && qs.get('apiKey') === API_KEY) return true;

  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: 'Unauthorized',
    hint:  'Provide API_KEY via Authorization: Bearer <key> header or ?apiKey= query param'
  }));
  return false;
}

// ─── HTTP router ──────────────────────────────────────────────────────────────
const routes = {};

function addRoute(method, routePath, handler) {
  routes[`${method}:${routePath}`] = handler;
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // Serve index.html at root (always public)
  if (req.method === 'GET' && req.url.split('?')[0] === '/') {
    try {
      const html = readFileSync(new URL('../index.html', import.meta.url));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html);
    } catch {
      return notFound(res);
    }
  }

  // API key gate
  if (!checkApiKey(req, res)) return;

  const key = `${req.method}:${req.url.split('?')[0]}`;
  const handler = routes[key];
  if (handler) return handler(req, res);

  // Prefix match for routes with :params
  for (const [pattern, fn] of Object.entries(routes)) {
    const [m, p] = pattern.split(':');
    if (m !== req.method) continue;
    const regex = new RegExp('^' + p.replace(/:[^/]+/g, '([^/]+)') + '$');
    const match = req.url.split('?')[0].match(regex);
    if (match) {
      const keys = [...p.matchAll(/:([^/]+)/g)].map(x => x[1]);
      req.params = Object.fromEntries(keys.map((k, i) => [k, match[i + 1]]));
      return fn(req, res);
    }
  }

  notFound(res);
});

// Health route — always public
addRoute('GET', '/health', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status:  'ok',
    branch:  'lancia',
    modules: Object.keys(registry.modules),
    uptime:  process.uptime(),
    apiKey:  API_KEY ? 'enabled' : 'disabled',
  }));
});

// ─── Load enabled modules ─────────────────────────────────────────────────────
async function loadModules() {
  const modCfg      = cfg.modules;
  const moduleNames = Object.keys(modCfg).filter(k => modCfg[k].enabled);

  for (const name of moduleNames) {
    try {
      const modPath  = path.resolve(`${name}/index.js`);
      const mod      = await import(pathToFileURL(modPath));
      const instance = await mod.default.init(
        { ...cfg[name], ...modCfg[name] },
        registry
      );
      registry.register(instance);
      if (instance.routes) {
        for (const [method, routePath, handler] of instance.routes) {
          addRoute(method, `/api/v1/${name}${routePath}`, handler);
        }
      }
    } catch (err) {
      console.error(`[core] failed to load module "${name}":`, err.message);
    }
  }
}

await loadModules();

server.listen(PORT, HOST, () => {
  console.log(`[core] MagoFonte ✨ lancia branch`);
  console.log(`[core] listening on http://${HOST}:${PORT}`);
  console.log(`[core] modules: ${Object.keys(registry.modules).join(', ')}`);
  console.log(`[core] api key: ${API_KEY ? 'ENABLED' : 'DISABLED (set API_KEY env var)'}`);
});
