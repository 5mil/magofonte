'use strict';
/**
 * lancia/backends/fly.js
 * Fly.io Machines API backend for Lancia instance management.
 *
 * Required env vars:
 *   FLY_API_TOKEN   — Fly.io personal access token
 *   FLY_APP_NAME    — your Fly.io app name (e.g. "magofonte")
 *
 * Docs: https://fly.io/docs/machines/api/
 */

const https = require('https');

const FLY_API = 'api.machines.dev';
const APP     = () => process.env.FLY_APP_NAME || 'magofonte';
const TOKEN   = () => process.env.FLY_API_TOKEN;

const SIZE_MAP = {
  dev:         'shared-cpu-1x',
  light:       'shared-cpu-2x',
  standard:    'performance-1x',
  performance: 'performance-2x',
  heavy:       'performance-4x',
};

async function flyRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: FLY_API, port: 443,
      path: `/v1/apps/${APP()}${path}`, method,
      headers: {
        'Authorization': `Bearer ${TOKEN()}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

module.exports = {
  async list() {
    const machines = await flyRequest('GET', '/machines');
    return (machines || []).map(m => ({
      id: m.id, name: m.name,
      region: m.region, status: m.state,
      image: m.config?.image,
      size: Object.keys(SIZE_MAP).find(k => SIZE_MAP[k] === m.config?.guest?.cpu_kind) || 'standard',
      url: m.private_ip ? `http://${m.private_ip}:3000` : null,
      created_at: m.created_at,
    }));
  },

  async create({ name, region, image, size, stratumPort, apiPort, env, rewardAddress }) {
    const machine = await flyRequest('POST', '/machines', {
      name,
      region: region || 'ord',
      config: {
        image: image || 'registry.fly.io/magofonte:latest',
        guest: { cpu_kind: SIZE_MAP[size] || SIZE_MAP.standard, cpus: 1, memory_mb: 512 },
        services: [
          { ports: [{ port: stratumPort || 3333, handlers: ['tcp'] }], protocol: 'tcp', internal_port: stratumPort || 3333 },
          { ports: [{ port: 443, handlers: ['tls','http'] }], protocol: 'tcp', internal_port: apiPort || 3000 },
        ],
        env: {
          REWARD_ADDRESS: rewardAddress || '',
          ...(env ? Object.fromEntries(env.split('\n').filter(Boolean).map(l => l.split('='))) : {})
        }
      }
    });
    return { id: machine.id, name: machine.name, region: machine.region, status: machine.state, image, size, url: null };
  },

  async restart(id) {
    return flyRequest('POST', `/machines/${id}/restart`);
  },

  async destroy(id) {
    await flyRequest('POST', `/machines/${id}/stop`);
    return flyRequest('DELETE', `/machines/${id}`);
  }
};
