'use strict';
/**
 * lancia/backends/mock.js
 * In-memory mock backend for dev/test.
 * No real machines are created — state lives in memory.
 */

const crypto = require('crypto');
const _instances = new Map();

const REGIONS = ['ord', 'iad', 'lax', 'sea', 'fra', 'nrt', 'syd'];
const SIZES   = ['dev', 'light', 'standard', 'performance', 'heavy'];

module.exports = {
  async list() {
    return Array.from(_instances.values());
  },

  async create({ name, region, image, size, stratumPort, apiPort, env, rewardAddress }) {
    const id = crypto.randomBytes(8).toString('hex');
    const inst = {
      id,
      name: name || `lancia-${id.slice(0, 6)}`,
      region: region || REGIONS[0],
      image: image || 'magofonte:latest',
      size: size || 'standard',
      stratumPort: stratumPort || 3333,
      apiPort: apiPort || 3000,
      rewardAddress: rewardAddress || '',
      env: env || '',
      status: 'running',
      url: `http://mock-${id.slice(0, 6)}.lancia.local:${apiPort || 3000}`,
      created_at: new Date().toISOString(),
    };
    _instances.set(id, inst);
    return inst;
  },

  async restart(id) {
    const inst = _instances.get(id);
    if (!inst) throw new Error(`Instance not found: ${id}`);
    inst.status = 'running';
    inst.restarted_at = new Date().toISOString();
    return inst;
  },

  async destroy(id) {
    if (!_instances.has(id)) throw new Error(`Instance not found: ${id}`);
    _instances.delete(id);
    return { destroyed: true };
  }
};
