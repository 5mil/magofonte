/**
 * MagoFonte — ward/certEngine.js
 *
 * Ed25519 credential certificate engine.
 *
 * Responsibilities:
 *   - Generate Ed25519 keypairs via SubtleCrypto (browser) or node:crypto (server)
 *   - Private key stored with extractable:false in IndexedDB — never accessible to JS after creation
 *   - One-time downloadable cert JSON generated at provisioning
 *   - Cert payload: iss, aud, sub, iat, exp, jti, role, scope[], env{}
 *   - Scope profiles keyed by deployment tier
 *   - Inbound tokens with 'kid' field are rejected (no external key lookup surface)
 *
 * Cert payload shape:
 * {
 *   cert_id:   "LNC-2026-XXXX",        // random 4-char hex suffix
 *   iss:       "magofonte:lancia",      // MUST match EXPECTED_ISS on server
 *   sub:       "<username>",
 *   aud:       ["magofonte:<instanceId>"],  // server validates this
 *   iat:       <unix seconds>,
 *   exp:       <unix seconds>,           // iat + term in seconds
 *   jti:       "<uuid>",                 // for revocation denylist
 *   role:      "owner",                  // only owner gets cert-based auth
 *   scope:     ["pool:read", ...],       // explicit permitted actions
 *   env: {
 *     instance_id: "<name>",
 *     provider:    "hetzner",
 *     tier:        "forge",
 *     term_months: 12
 *   },
 *   owner_pubkey: "<base64url ed25519 public key>",
 *   signature:    "<base64url ed25519 sig of all above fields>"
 * }
 */

import crypto from 'node:crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

export const EXPECTED_ISS      = 'magofonte:lancia';
export const CERT_VERSION      = 1;

// Term lengths in seconds
const TERM_SECONDS = {
  1:  30  * 24 * 60 * 60,
  6:  182 * 24 * 60 * 60,
  12: 365 * 24 * 60 * 60,
  24: 730 * 24 * 60 * 60,
  'free': 30 * 24 * 60 * 60   // free tier: 30 days, auto-renewable
};

// ─── Scope profiles by deployment tier ───────────────────────────────────────
//
// Scope tokens are intentionally granular — not just roles.
// A token with role:owner but missing scope:wallet:export cannot export keys.
// Tier profiles define the MAXIMUM scope a cert of that tier may carry.
// The owner may request a subset at cert generation time.

export const SCOPE_PROFILES = {
  'free-tier': [
    'pool:read',
    'pool:write',
    'node:read',
    'wallet:read',
    'wallet:write',
    'ward:read',
    'ward:admin',
    'ward:owner',
    'monetization:read',
    'monetization:admin',
    'bonus:read',
    'cpu-miner:read'
    // wallet:export — intentionally absent on free tier
    // treasury:admin — no treasury on free tier
    // cpu-miner:admin — not available on free tier
  ],
  'hearth': [
    'pool:read',
    'pool:write',
    'pool:admin',
    'node:read',
    'node:write',
    'wallet:read',
    'wallet:write',
    'wallet:export',          // hearth+ unlocks key export
    'ward:read',
    'ward:admin',
    'ward:owner',
    'monetization:read',
    'monetization:admin',
    'bonus:read',
    'cpu-miner:read',
    'cpu-miner:admin',
    'treasury:read'
    // treasury:admin — forge+ only
  ],
  'forge': [
    'pool:read',
    'pool:write',
    'pool:admin',
    'node:read',
    'node:write',
    'wallet:read',
    'wallet:write',
    'wallet:export',
    'ward:read',
    'ward:admin',
    'ward:owner',
    'monetization:read',
    'monetization:admin',
    'bonus:read',
    'bonus:admin',
    'cpu-miner:read',
    'cpu-miner:admin',
    'treasury:read',
    'treasury:admin'          // forge+ unlocks treasury sweep/address
  ],
  'foundry': [
    'pool:read', 'pool:write', 'pool:admin',
    'node:read', 'node:write',
    'wallet:read', 'wallet:write', 'wallet:export',
    'ward:read', 'ward:admin', 'ward:owner',
    'monetization:read', 'monetization:admin',
    'bonus:read', 'bonus:admin',
    'cpu-miner:read', 'cpu-miner:admin',
    'treasury:read', 'treasury:admin',
    'fleet:read', 'fleet:admin'   // foundry+ adds fleet management
  ],
  'citadel': [
    'pool:read', 'pool:write', 'pool:admin',
    'node:read', 'node:write',
    'wallet:read', 'wallet:write', 'wallet:export',
    'ward:read', 'ward:admin', 'ward:owner',
    'monetization:read', 'monetization:admin',
    'bonus:read', 'bonus:admin',
    'cpu-miner:read', 'cpu-miner:admin',
    'treasury:read', 'treasury:admin',
    'fleet:read', 'fleet:admin',
    'premium:admin'              // citadel-only premium controls
  ]
};

// ─── Cert ID generator ────────────────────────────────────────────────────────

function genCertId() {
  const year = new Date().getFullYear();
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `LNC-${year}-${rand}`;
}

// ─── Server-side cert helpers ─────────────────────────────────────────────────
//
// These run in Node.js during provisioning.
// The browser-side flow uses SubtleCrypto (see certEngine.browser.js).

/**
 * Build an unsigned cert payload.
 * Called after the browser sends its public key to /ward/provision.
 *
 * @param {object} opts
 * @param {string} opts.username
 * @param {string} opts.instanceId   - e.g. "forge-pool-01"
 * @param {string} opts.tier         - 'free-tier' | 'hearth' | 'forge' | 'foundry' | 'citadel'
 * @param {number} opts.termMonths   - 1 | 6 | 12 | 24 | 'free'
 * @param {string} opts.ownerPubkeyB64 - base64url ed25519 public key from browser
 * @param {string[]} [opts.scopeOverride] - optional subset of tier scope
 * @returns {object} unsigned cert payload (ready to be signed by owner's privkey in browser)
 */
export function buildCertPayload(opts) {
  const { username, instanceId, tier, termMonths, ownerPubkeyB64, scopeOverride } = opts;

  if (!SCOPE_PROFILES[tier]) {
    throw new Error(`unknown tier: ${tier}`);
  }
  const maxScope = SCOPE_PROFILES[tier];
  const scope    = scopeOverride
    ? scopeOverride.filter(s => maxScope.includes(s))  // clamp to tier max
    : maxScope;

  if (scope.length === 0) {
    throw new Error('cert scope is empty after tier clamping');
  }

  const now = Math.floor(Date.now() / 1000);
  const ttl = TERM_SECONDS[termMonths] ?? TERM_SECONDS[1];

  return {
    version:      CERT_VERSION,
    cert_id:      genCertId(),
    iss:          EXPECTED_ISS,
    sub:          username,
    aud:          [`magofonte:${instanceId}`],
    iat:          now,
    exp:          now + ttl,
    jti:          crypto.randomUUID(),
    role:         'owner',
    scope,
    env: {
      instance_id:  instanceId,
      tier,
      term_months:  termMonths,
    },
    owner_pubkey: ownerPubkeyB64
    // 'signature' field added by browser after signing
  };
}

/**
 * Verify a cert payload's signature on the server side.
 * Called during the cert-based login challenge flow.
 *
 * IMPORTANT: This only verifies the signature.
 * Full validation (iss, aud, exp, jti, scope) is done in issuer.js verifyToken().
 *
 * @param {object} certPayload  - full cert including 'signature' field
 * @returns {boolean}
 */
export function verifyCertSignature(certPayload) {
  const { signature, ...rest } = certPayload;
  if (!signature) return false;

  const pubkeyBuf = Buffer.from(certPayload.owner_pubkey, 'base64url');
  const dataBuf   = Buffer.from(JSON.stringify(rest));
  const sigBuf    = Buffer.from(signature, 'base64url');

  try {
    return crypto.verify(null, dataBuf, {
      key:    pubkeyBuf,
      format: 'raw',
      type:   'public',
      dsaEncoding: 'ieee-p1363'
    }, sigBuf);
  } catch {
    return false;
  }
}

/**
 * Verify the scope of a cert against a required scope token.
 * Used by the authenticate middleware in ward/index.js.
 *
 * @param {object} certPayload
 * @param {string} requiredScope  - e.g. 'wallet:export'
 * @returns {boolean}
 */
export function certHasScope(certPayload, requiredScope) {
  if (!requiredScope) return true;
  return Array.isArray(certPayload.scope) && certPayload.scope.includes(requiredScope);
}

/**
 * Verify audience — cert must be bound to this server's instance ID.
 *
 * @param {object} certPayload
 * @param {string} serverInstanceId  - from env SERVER_INSTANCE_ID or magofonte.config.json
 * @returns {boolean}
 */
export function certAudienceValid(certPayload, serverInstanceId) {
  if (!Array.isArray(certPayload.aud)) return false;
  return certPayload.aud.includes(`magofonte:${serverInstanceId}`);
}
