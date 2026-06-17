/**
 * MagoFonte — ward/scopeMap.js
 *
 * Canonical route → scope → minRole table.
 *
 * Every route in the system declares:
 *   scope:   the scope token required in the bearer cert/token
 *   minRole: the minimum role rank required (second independent check)
 *
 * Both must pass. A token with role:admin but missing scope:wallet:export
 * cannot export keys, even if the role check would pass alone.
 *
 * Used by:
 *   - core/index.js addRoute() to attach metadata to each route
 *   - ward/index.js authenticate() to validate inbound tokens
 *   - sigil dashboard to render scope badges on the API reference panel
 */

export const SCOPE_MAP = {
  // ── Pool ──────────────────────────────────────────────────────────────────
  'GET:/api/v1/pool/status':             { scope: 'pool:read',      minRole: 'member'   },
  'GET:/api/v1/pool/miners':             { scope: 'pool:read',      minRole: 'member'   },
  'GET:/api/v1/pool/payout':             { scope: 'pool:read',      minRole: 'member'   },
  'GET:/api/v1/pool/job':                { scope: 'pool:read',      minRole: 'member'   },
  'GET:/api/v1/pool/node':               { scope: 'pool:read',      minRole: 'member'   },
  'POST:/api/v1/pool/job/new':           { scope: 'pool:write',     minRole: 'operator' },
  'POST:/api/v1/pool/reward-address':    { scope: 'pool:write',     minRole: 'operator' },
  'POST:/api/v1/pool/validate-address':  { scope: 'pool:read',      minRole: 'operator' },
  'POST:/api/v1/pool/upstreams':         { scope: 'pool:admin',     minRole: 'admin'    },
  'DELETE:/api/v1/pool/upstreams/:id':   { scope: 'pool:admin',     minRole: 'admin'    },

  // ── Pool Settings ─────────────────────────────────────────────────────────
  'GET:/api/v1/pool/settings/pools':                           { scope: 'pool:read',      minRole: 'operator' },
  'POST:/api/v1/pool/settings/pools':                          { scope: 'pool:admin',     minRole: 'admin'    },
  'PATCH:/api/v1/pool/settings/pools/:id':                     { scope: 'pool:admin',     minRole: 'admin'    },
  'DELETE:/api/v1/pool/settings/pools/:id':                    { scope: 'pool:admin',     minRole: 'admin'    },
  'POST:/api/v1/pool/settings/active':                         { scope: 'pool:admin',     minRole: 'admin'    },
  'GET:/api/v1/pool/settings/pools/:id/monetization':          { scope: 'monetization:read',  minRole: 'operator' },
  'POST:/api/v1/pool/settings/pools/:id/monetization/:type':   { scope: 'monetization:admin', minRole: 'admin'    },
  'GET:/api/v1/pool/settings/monetization-types':              { scope: 'monetization:read',  minRole: 'operator' },

  // ── CPU Miner ─────────────────────────────────────────────────────────────
  'GET:/api/v1/pool/cpu-miner':          { scope: 'cpu-miner:read',  minRole: 'operator' },
  'POST:/api/v1/pool/cpu-miner/start':   { scope: 'cpu-miner:admin', minRole: 'admin'    },
  'POST:/api/v1/pool/cpu-miner/stop':    { scope: 'cpu-miner:admin', minRole: 'admin'    },
  'PATCH:/api/v1/pool/cpu-miner':        { scope: 'cpu-miner:admin', minRole: 'admin'    },

  // ── Bonus / Treasury ──────────────────────────────────────────────────────
  'GET:/api/v1/pool/bonus':              { scope: 'bonus:read',      minRole: 'operator' },
  'GET:/api/v1/treasury':                { scope: 'treasury:read',   minRole: 'admin'    },
  'POST:/api/v1/treasury/sweep':         { scope: 'treasury:admin',  minRole: 'owner'    },
  'POST:/api/v1/treasury/address':       { scope: 'treasury:admin',  minRole: 'owner'    },

  // ── Wallet ────────────────────────────────────────────────────────────────
  'GET:/api/v1/wallet/:coin':                      { scope: 'wallet:read',   minRole: 'operator' },
  'POST:/api/v1/wallet/:coin/generate':            { scope: 'wallet:write',  minRole: 'admin'    },
  'POST:/api/v1/wallet/:coin/import':              { scope: 'wallet:write',  minRole: 'admin'    },
  'GET:/api/v1/wallet/:coin/:label/export':        { scope: 'wallet:export', minRole: 'owner'    },
  'POST:/api/v1/wallet/:coin/:label/setActive':    { scope: 'wallet:write',  minRole: 'admin'    },
  'DELETE:/api/v1/wallet/:coin/:label':            { scope: 'wallet:write',  minRole: 'admin'    },

  // ── Node ──────────────────────────────────────────────────────────────────
  'GET:/api/v1/node/status':             { scope: 'node:read',   minRole: 'member'   },
  'POST:/api/v1/node/start':             { scope: 'node:write',  minRole: 'admin'    },
  'POST:/api/v1/node/stop':              { scope: 'node:write',  minRole: 'admin'    },
  'POST:/api/v1/node/restart':           { scope: 'node:write',  minRole: 'admin'    },
  'POST:/api/v1/node/register':          { scope: 'node:write',  minRole: 'admin'    },

  // ── Ward (auth/users) ─────────────────────────────────────────────────────
  'GET:/api/v1/ward/me':                          { scope: 'ward:read',   minRole: 'member'   },
  'GET:/api/v1/ward/users':                        { scope: 'ward:read',   minRole: 'admin'    },
  'POST:/api/v1/ward/users':                       { scope: 'ward:admin',  minRole: 'admin'    },
  'PATCH:/api/v1/ward/users/:id/role':             { scope: 'ward:admin',  minRole: 'admin'    },
  'DELETE:/api/v1/ward/users/:id':                 { scope: 'ward:owner',  minRole: 'owner'    },
  'POST:/api/v1/ward/users/:id/password':          { scope: 'ward:read',   minRole: 'member'   },
  'GET:/api/v1/ward/audit':                        { scope: 'ward:admin',  minRole: 'admin'    },
  'GET:/api/v1/ward/audit/verify':                 { scope: 'ward:owner',  minRole: 'owner'    },

  // ── Cert provisioning ─────────────────────────────────────────────────────
  'POST:/api/v1/ward/provision':                   { scope: 'ward:owner',  minRole: 'owner'    },
  'POST:/api/v1/ward/cert/revoke':                 { scope: 'ward:owner',  minRole: 'owner'    },
};

/**
 * Look up scope and minRole for a given method + path.
 * Returns null if the route is not in the map (public routes).
 *
 * Supports :param segments — tries exact match first, then pattern match.
 *
 * @param {string} method  - 'GET' | 'POST' | 'PATCH' | 'DELETE'
 * @param {string} urlPath - e.g. '/api/v1/pool/status'
 * @returns {{ scope: string, minRole: string } | null}
 */
export function lookupScope(method, urlPath) {
  // Exact match
  const exact = SCOPE_MAP[`${method}:${urlPath}`];
  if (exact) return exact;

  // Pattern match — replace :param segments
  for (const [key, meta] of Object.entries(SCOPE_MAP)) {
    const [m, p] = key.split(/:(.+)/);
    if (m !== method) continue;
    const regex = new RegExp('^' + p.replace(/:[^/]+/g, '[^/]+') + '$');
    if (regex.test(urlPath)) return meta;
  }

  return null; // not in scope map = public route (health, jwks, etc.)
}
