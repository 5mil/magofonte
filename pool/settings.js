/**
 * pool/settings.js
 *
 * Pool Settings Manager
 *
 * Manages:
 *  - Multiple pool configurations (one per available node)
 *  - Active pool selection + hot-swap
 *  - Monetization registry per coin node
 *    (mining, lightning routing, RPC endpoint, staking, channel leasing, etc.)
 *
 * All settings persist to pool/settings.json on disk.
 * Exposed via REST at /api/v1/pool/settings/*
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = path.join(__dir, 'settings.json');

// ─── Monetization type definitions ─────────────────────────────────────────────
//
// Each type defines what settings it needs and how to check availability
// for a given coin definition.

export const MONETIZATION_TYPES = {

  mining: {
    id:          'mining',
    label:       'Proof-of-Work Mining',
    description: 'Run a stratum pool. Workers connect and mine blocks. Reward goes to blockRewardAddress.',
    availableFor: (coin) => !!coin.algo,   // any mineable coin
    settings: {
      algo:               { type: 'select',  label: 'Algorithm',          options: (coin) => coin.algos || [coin.algo] },
      stratumPort:        { type: 'number',  label: 'Stratum port',       default: 3333 },
      blockRewardAddress: { type: 'string',  label: 'Payout address',     required: true },
      payoutScheme:       { type: 'select',  label: 'Payout scheme',      options: ['PPLNS', 'PPS', 'SOLO'], default: 'PPLNS' },
      pplnsWindow:        { type: 'number',  label: 'PPLNS window',       default: 100 },
      defaultDiff:        { type: 'number',  label: 'Default difficulty', default: 0.01 },
      varDiff:            { type: 'boolean', label: 'Variable difficulty',default: true },
      blockPollMs:        { type: 'number',  label: 'Block poll (ms)',    default: 500 }
    }
  },

  lightning_routing: {
    id:          'lightning_routing',
    label:       'Lightning Routing Fees',
    description: 'Run a Lightning Network node (LND/CLN). Earn fees for forwarding payments through your channels.',
    availableFor: (coin) => ['btc', 'ltc', 'dgb'].includes(coin.id),
    settings: {
      implementation: { type: 'select', label: 'Implementation', options: ['lnd', 'cln'], default: 'lnd' },
      baseFeesMsat:   { type: 'number', label: 'Base fee (msat)',   default: 1000 },
      feeRatePpm:     { type: 'number', label: 'Fee rate (ppm)',    default: 100 },
      autoRebalance:  { type: 'boolean',label: 'Auto-rebalance',   default: false },
      minChannelSat:  { type: 'number', label: 'Min channel (sat)',default: 1000000 },
      targetChannels: { type: 'number', label: 'Target channels',  default: 10 }
    }
  },

  rpc_endpoint: {
    id:          'rpc_endpoint',
    label:       'Public RPC Endpoint',
    description: 'Expose your node RPC publicly (authenticated). Earn fees per API call from dApps, wallets, explorers.',
    availableFor: (coin) => !!coin.daemon?.rpcPort,
    settings: {
      publicPort:   { type: 'number',  label: 'Public port',    default: 8545 },
      rateLimitRpm: { type: 'number',  label: 'Rate limit/min', default: 100 },
      requireApiKey:{ type: 'boolean', label: 'Require API key',default: true },
      feePerCall:   { type: 'number',  label: 'Fee per 1k calls (sat)', default: 0 },
      allowedMethods: { type: 'array', label: 'Allowed methods', default: ['getblockcount','getblocktemplate','sendrawtransaction'] }
    }
  },

  staking: {
    id:          'staking',
    label:       'Proof-of-Stake / Validation',
    description: 'Stake coins on PoS chains. Earn block rewards + transaction fees as a validator.',
    availableFor: (coin) => !!coin.staking,
    settings: {
      validatorAddress: { type: 'string',  label: 'Validator address', required: true },
      commission:       { type: 'number',  label: 'Commission %',      default: 5 },
      autoCompound:     { type: 'boolean', label: 'Auto-compound',     default: true },
      minDelegation:    { type: 'number',  label: 'Min delegation',    default: 0 }
    }
  },

  channel_leasing: {
    id:          'channel_leasing',
    label:       'Lightning Channel Leasing',
    description: 'Sell inbound liquidity on Amboss Magma / Lightning Pool. Get paid to open channels to others.',
    availableFor: (coin) => ['btc', 'ltc'].includes(coin.id),
    settings: {
      marketplace:    { type: 'select', label: 'Marketplace', options: ['amboss_magma', 'lightning_pool', 'liquidity_ads'], default: 'amboss_magma' },
      minChannelSat:  { type: 'number', label: 'Min channel (sat)',  default: 2000000 },
      maxChannelSat:  { type: 'number', label: 'Max channel (sat)',  default: 100000000 },
      leaseFeeBase:   { type: 'number', label: 'Lease fee (sat)',    default: 5000 },
      leaseFeeRatePpm:{ type: 'number', label: 'Lease rate (ppm)',   default: 2500 },
      minDurationDays:{ type: 'number', label: 'Min duration (days)',default: 30 }
    }
  },

  masternode: {
    id:          'masternode',
    label:       'Masternode',
    description: 'Run a masternode (Dash, PIVX, etc.). Earn a portion of block rewards for hosting a full node with collateral.',
    availableFor: (coin) => !!coin.masternode,
    settings: {
      collateralAddress: { type: 'string', label: 'Collateral address', required: true },
      collateralAmount:  { type: 'number', label: 'Collateral (coins)', required: true },
      masternodeKey:     { type: 'string', label: 'Masternode key',     required: true }
    }
  },

  merge_mining: {
    id:          'merge_mining',
    label:       'Merged Mining',
    description: 'Mine multiple chains simultaneously at no extra cost. DGB supports merged mining with Litecoin (Scrypt algo).',
    availableFor: (coin) => !!coin.mergeMining,
    settings: {
      parentChain:    { type: 'string', label: 'Parent chain',   default: 'ltc' },
      parentNodeHost: { type: 'string', label: 'Parent node',    default: '127.0.0.1' },
      parentNodePort: { type: 'number', label: 'Parent RPC port',default: 9332 }
    }
  },

  mempool_services: {
    id:          'mempool_services',
    label:       'Mempool / Explorer Services',
    description: 'Run a mempool explorer or block explorer. Monetize via ads, premium API access, or donations.',
    availableFor: (coin) => !!coin.daemon?.rpcPort,
    settings: {
      explorerPort:  { type: 'number',  label: 'Explorer port', default: 3002 },
      enableApi:     { type: 'boolean', label: 'Enable API',    default: true },
      enableWebhooks:{ type: 'boolean', label: 'Enable webhooks',default: false }
    }
  }
};

// ─── Pool definition schema ──────────────────────────────────────────────────────────
// A "pool" in settings = one mining pool config bound to one node.
// Multiple pools can exist (one per coin node, or multiple algos for DGB).

// DEFAULT_POOL_TEMPLATE is used when a new pool is registered from a coin def.
export function buildDefaultPool(coinDef) {
  return {
    id:          coinDef.id,
    coin:        coinDef.id,
    name:        `${coinDef.name} Party Mine`,
    enabled:     false,
    algo:        coinDef.algo || coinDef.algos?.[0] || 'unknown',
    stratumPort: coinDef.stratum?.port || 3333,
    blockRewardAddress: '',
    payoutScheme:  'PPLNS',
    pplnsWindow:   100,
    defaultDiff:   coinDef.stratum?.defaultDiff || 0.01,
    varDiff:       coinDef.stratum?.varDiff     || { enabled: true, minDiff: 0.001, maxDiff: 1000, targetTime: 15, retargetTime: 60, variancePercent: 30 },
    blockPollMs:   500,
    // Which monetization types are active for this coin
    monetization: {
      mining:           { enabled: false, config: {} },
      lightning_routing:{ enabled: false, config: {} },
      rpc_endpoint:     { enabled: false, config: {} },
      staking:          { enabled: false, config: {} },
      channel_leasing:  { enabled: false, config: {} },
      masternode:       { enabled: false, config: {} },
      merge_mining:     { enabled: false, config: {} },
      mempool_services: { enabled: false, config: {} }
    },
    createdAt: Date.now()
  };
}

// ─── SettingsManager ───────────────────────────────────────────────────────────

export class SettingsManager {
  constructor(registry) {
    this.registry = registry;
    this.data = this._load();
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch {
      return {
        activePool: null,     // pool id currently running
        pools:      {},       // id → pool config
        global: {
          stratumHost: '0.0.0.0',
          apiHost:     '0.0.0.0',
          apiPort:     8080
        }
      };
    }
  }

  save() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(this.data, null, 2));
  }

  // ── Pool CRUD ─────────────────────────────────────────────────────────────

  // Register a pool from a loaded coin definition
  registerPool(coinDef, overrides = {}) {
    const pool = { ...buildDefaultPool(coinDef), ...overrides };
    this.data.pools[pool.id] = pool;
    this.save();
    console.log(`[settings] registered pool: ${pool.name}`);
    return pool;
  }

  updatePool(poolId, patch) {
    if (!this.data.pools[poolId]) throw new Error(`pool not found: ${poolId}`);
    this.data.pools[poolId] = deepMerge(this.data.pools[poolId], patch);
    this.save();
    this.registry.emit('settings:pool:updated', { poolId, pool: this.data.pools[poolId] });
    return this.data.pools[poolId];
  }

  deletePool(poolId) {
    delete this.data.pools[poolId];
    if (this.data.activePool === poolId) this.data.activePool = null;
    this.save();
    this.registry.emit('settings:pool:deleted', { poolId });
  }

  getPool(poolId)  { return this.data.pools[poolId] ?? null; }
  listPools()      { return Object.values(this.data.pools); }

  // ── Active pool ────────────────────────────────────────────────────────────

  setActivePool(poolId) {
    if (poolId && !this.data.pools[poolId]) throw new Error(`pool not found: ${poolId}`);
    this.data.activePool = poolId;
    this.save();
    this.registry.emit('settings:activePool:changed', { poolId });
    return poolId;
  }

  getActivePool() {
    return this.data.activePool ? this.data.pools[this.data.activePool] : null;
  }

  // ── Monetization ───────────────────────────────────────────────────────────

  // Get all monetization types available for a given coin,
  // annotated with whether they are currently enabled.
  getMonetizationOptions(poolId) {
    const pool = this.getPool(poolId);
    if (!pool) return [];
    // Load coin def to determine availability
    let coinDef = null;
    try {
      const defPath = path.join(__dir, `../coins/${pool.coin}.json`);
      coinDef = JSON.parse(fs.readFileSync(defPath, 'utf8'));
    } catch { coinDef = { id: pool.coin }; }

    return Object.values(MONETIZATION_TYPES).map(type => ({
      ...type,
      available: type.availableFor(coinDef),
      enabled:   pool.monetization?.[type.id]?.enabled ?? false,
      config:    pool.monetization?.[type.id]?.config   ?? {},
      // Resolve dynamic option lists
      settings: Object.fromEntries(
        Object.entries(type.settings).map(([k, s]) => [
          k,
          { ...s, options: typeof s.options === 'function' ? s.options(coinDef) : s.options }
        ])
      )
    }));
  }

  // Enable/disable/configure a monetization type on a pool
  setMonetization(poolId, typeId, enabled, config = {}) {
    if (!MONETIZATION_TYPES[typeId]) throw new Error(`unknown monetization type: ${typeId}`);
    const pool = this.getPool(poolId);
    if (!pool) throw new Error(`pool not found: ${poolId}`);
    pool.monetization[typeId] = { enabled, config: { ...(pool.monetization[typeId]?.config || {}), ...config } };
    this.data.pools[poolId] = pool;
    this.save();
    this.registry.emit('settings:monetization:changed', { poolId, typeId, enabled, config });
    console.log(`[settings] ${enabled ? 'enabled' : 'disabled'} ${typeId} for pool ${poolId}`);
    return pool.monetization[typeId];
  }

  // ── Auto-register from node:ready ────────────────────────────────────────
  // When a coin node comes online, register a pool for it
  // if one doesn't exist yet.
  autoRegisterFromNode(coinId) {
    if (this.data.pools[coinId]) {
      console.log(`[settings] pool already registered for ${coinId}`);
      return this.data.pools[coinId];
    }
    try {
      const defPath = path.join(__dir, `../coins/${coinId}.json`);
      const coinDef = JSON.parse(fs.readFileSync(defPath, 'utf8'));
      const pool    = this.registerPool(coinDef);
      console.log(`[settings] auto-registered pool for ${coinId}`);
      this.registry.emit('settings:pool:autoRegistered', { poolId: coinId, pool });
      return pool;
    } catch(err) {
      console.warn(`[settings] could not auto-register pool for ${coinId}:`, err.message);
      return null;
    }
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function deepMerge(target, source) {
  const out = { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object')
      out[k] = deepMerge(target[k], v);
    else
      out[k] = v;
  }
  return out;
}
