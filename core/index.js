/**
 * MagoFonte — Core
 * Module host, HTTP server, plugin registry.
 * Each module exports: { name, init(config, registry), routes?, hooks? }
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const cfg = JSON.parse(readFileSync(new URL('../magofonte.config.json', import.meta.url)));

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

// --- Minimal HTTP router ---
const routes = {};

function addRoute(method, path, handler) {
  routes[`${method}:${path}`] = handler;
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const key = `${req.method}:${req.url.split('?')[0]}`;
  const handler = routes[key];
  if (handler) return handler(req, res);

  // prefix match for routes with params
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

// Core health route
addRoute('GET', '/health', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    modules: Object.keys(registry.modules),
    uptime: process.uptime()
  }));
});

// --- Load enabled modules ---
async function loadModules() {
  const modCfg = cfg.modules;
  const moduleNames = Object.keys(modCfg).filter(k => modCfg[k].enabled);

  for (const name of moduleNames) {
    try {
      const modPath = path.resolve(`${name}/index.js`);
      const mod = await import(pathToFileURL(modPath));
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

const { host, port } = cfg.server;
server.listen(port, host, () => {
  console.log(`[core] MagoFonte listening on http://${host}:${port}`);
  console.log(`[core] modules loaded: ${Object.keys(registry.modules).join(', ')}`);
});
