/**
 * MagoFonte — ward/issuer.js
 *
 * Ed25519 JWS token issuer and verifier.
 *
 * Security guarantees:
 *   1. Claims validated BEFORE any key operation (CVE-2025-59936 pattern impossible)
 *   2. Algorithm hardcoded to 'EdDSA' — header.alg checked first, anything else rejected
 *   3. 'iss' validated with strict equality only — no prefix/regex (CVE-2025-30144 pattern impossible)
 *   4. 'kid' in inbound tokens is rejected — no external key lookup surface
 *   5. ISSUER_PUBLIC_KEY is a constant loaded once at startup — zero cache, zero lookup
 *   6. jti denylist: O(1) Set in memory, async flush to disk, never read on hot path
 *   7. Session tokens: 30-minute TTL
 *   8. Refresh tokens: opaque random string, server-side denylist, HttpOnly cookie
 *
 * Exports:
 *   init()             — load or generate Ed25519 keypair from ward/issuer.key
 *   sign(payload)      — sign a new session token (30 min TTL)
 *   verify(rawToken)   — claims-first verification, returns payload or throws
 *   revoke(jti)        — add jti to denylist + async flush
 *   issueRefresh(sub)  — generate opaque refresh token, store server-side
 *   consumeRefresh(t)  — validate refresh token, return sub, rotate token
 *   jwks()             — return public key as JWKS JSON
 *   ISSUER_PUBLIC_KEY  — Buffer, exported for external use
 */

import crypto from 'node:crypto';
import fs     from 'node:fs';
import path   from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_ISS }  from './certEngine.js';

const __dir       = path.dirname(fileURLToPath(import.meta.url));
const KEY_FILE    = path.join(__dir, 'issuer.key');
const DENYLIST_FILE = path.join(__dir, 'jti.deny');

// Session token TTL — 30 minutes
const SESSION_TTL_S  = 30 * 60;
// Refresh token TTL — 7 days
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Module state (loaded once at init) ───────────────────────────────────────

let ISSUER_PRIVATE_KEY = null;   // KeyObject
export let ISSUER_PUBLIC_KEY = null;    // Buffer (raw 32-byte ed25519 public key)
let ISSUER_PUBLIC_KEY_B64 = null;       // base64url string for JWKS

// jti denylist — O(1) Set, authoritative in memory
const jtiDenylist   = new Set();
let   denylistDirty = false;

// Refresh token store: token → { sub, exp }
const refreshStore  = new Map();

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function init() {
  if (fs.existsSync(KEY_FILE)) {
    // Load existing keypair
    const raw  = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    ISSUER_PRIVATE_KEY     = crypto.createPrivateKey({ key: Buffer.from(raw.privkey, 'base64'), format: 'der', type: 'pkcs8' });
    ISSUER_PUBLIC_KEY      = Buffer.from(raw.pubkey, 'base64');
    ISSUER_PUBLIC_KEY_B64  = raw.pubkey_b64url;
  } else {
    // Generate fresh Ed25519 keypair
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
    const pubRaw  = publicKey.export({ type: 'spki',  format: 'der' }).slice(-32); // last 32 bytes = raw key
    ISSUER_PRIVATE_KEY    = privateKey;
    ISSUER_PUBLIC_KEY     = pubRaw;
    ISSUER_PUBLIC_KEY_B64 = pubRaw.toString('base64url');
    fs.writeFileSync(KEY_FILE, JSON.stringify({
      privkey:      privDer.toString('base64'),
      pubkey:       pubRaw.toString('base64'),
      pubkey_b64url: ISSUER_PUBLIC_KEY_B64,
      created:      new Date().toISOString()
    }), { mode: 0o600 });
    console.log('[issuer] generated new Ed25519 keypair → ward/issuer.key');
  }

  // Load jti denylist
  try {
    const lines = fs.readFileSync(DENYLIST_FILE, 'utf8').split('\n').filter(Boolean);
    lines.forEach(l => jtiDenylist.add(l.trim()));
    console.log(`[issuer] loaded ${jtiDenylist.size} revoked token IDs`);
  } catch { /* file may not exist yet */ }

  // Periodic denylist flush every 60s
  setInterval(flushDenylist, 60_000).unref();

  // Periodic refresh store cleanup every 10min
  setInterval(cleanRefreshStore, 10 * 60_000).unref();

  console.log('[issuer] ready — Ed25519 session tokens, 30-min TTL');
  return { ISSUER_PUBLIC_KEY, ISSUER_PUBLIC_KEY_B64 };
}

// ─── Token signing ─────────────────────────────────────────────────────────────

/**
 * Sign a new session token.
 * Caller provides: { sub, username, role, scope }
 * issuer.js adds: iss, aud, iat, exp, jti, alg
 *
 * @param {object} claims
 * @param {string} serverInstanceId
 * @returns {string} signed JWS compact serialization
 */
export function sign(claims, serverInstanceId) {
  if (!ISSUER_PRIVATE_KEY) throw new Error('[issuer] not initialized');

  const now     = Math.floor(Date.now() / 1000);
  const payload = {
    // Standard claims — added by issuer, not caller
    iss: EXPECTED_ISS,
    aud: `magofonte:${serverInstanceId}`,
    iat: now,
    exp: now + SESSION_TTL_S,
    jti: crypto.randomUUID(),
    // Caller-provided claims
    sub:      claims.sub,
    username: claims.username,
    role:     claims.role,
    scope:    claims.scope ?? []
  };

  const header  = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const body    = b64url(JSON.stringify(payload));
  const sigBuf  = crypto.sign(null, Buffer.from(`${header}.${body}`), ISSUER_PRIVATE_KEY);
  const sig     = sigBuf.toString('base64url');

  return `${header}.${body}.${sig}`;
}

// ─── Token verification ────────────────────────────────────────────────────────
//
// SECURITY: claims validated BEFORE any key operation.
// Step order is load-bearing — do not reorder.

/**
 * Verify a session token. Returns the payload or throws.
 *
 * Throws with specific error codes (not leaked to HTTP response,
 * but available for audit logging):
 *   alg_not_allowed
 *   external_kid_not_permitted
 *   issuer_rejected
 *   audience_mismatch
 *   token_expired
 *   token_revoked
 *   signature_invalid
 *
 * @param {string} rawToken
 * @param {string} serverInstanceId
 * @returns {object} payload
 */
export function verify(rawToken, serverInstanceId) {
  if (!ISSUER_PUBLIC_KEY) throw new Error('[issuer] not initialized');

  const parts = (rawToken || '').split('.');
  if (parts.length !== 3) throw new Error('malformed_token');
  const [headerB64, bodyB64, sigB64] = parts;

  // ── Step 1: Parse header — zero crypto, zero I/O ──────────────────────────
  let header;
  try { header = JSON.parse(b64urlDecode(headerB64)); }
  catch { throw new Error('malformed_token'); }

  // ── Step 2: Algorithm whitelist — BEFORE anything else ────────────────────
  if (header.alg !== 'EdDSA') {
    throw new Error('alg_not_allowed');
  }

  // ── Step 3: Reject external kid — no key lookup surface ───────────────────
  if (header.kid !== undefined) {
    throw new Error('external_kid_not_permitted');
  }

  // ── Step 4: Parse body — still zero crypto, zero I/O ─────────────────────
  let payload;
  try { payload = JSON.parse(b64urlDecode(bodyB64)); }
  catch { throw new Error('malformed_token'); }

  // ── Step 5: Issuer — strict equality only, no prefix/regex ───────────────
  if (payload.iss !== EXPECTED_ISS) {
    throw new Error('issuer_rejected');
  }

  // ── Step 6: Audience — validate before touching any key ───────────────────
  const expectedAud = `magofonte:${serverInstanceId}`;
  if (payload.aud !== expectedAud) {
    throw new Error('audience_mismatch');
  }

  // ── Step 7: Expiry ────────────────────────────────────────────────────────
  if (!payload.exp || Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error('token_expired');
  }

  // ── Step 8: jti denylist — O(1) Set, no I/O ──────────────────────────────
  if (payload.jti && jtiDenylist.has(payload.jti)) {
    throw new Error('token_revoked');
  }

  // ── Step 9: Signature — LAST, only if all claims passed ──────────────────
  // ISSUER_PUBLIC_KEY is a constant — zero lookup, zero cache
  const valid = crypto.verify(
    null,
    Buffer.from(`${headerB64}.${bodyB64}`),
    {
      key:    ISSUER_PUBLIC_KEY,
      format: 'raw',
      type:   'public',
      dsaEncoding: 'ieee-p1363'
    },
    Buffer.from(sigB64, 'base64url')
  );

  if (!valid) throw new Error('signature_invalid');

  return payload;
}

// ─── Token revocation ─────────────────────────────────────────────────────────

export function revoke(jti) {
  if (!jti) return;
  jtiDenylist.add(jti);
  denylistDirty = true;
  // Flush is async — denylist already authoritative in memory
}

function flushDenylist() {
  if (!denylistDirty) return;
  const data = [...jtiDenylist].join('\n');
  fs.writeFile(DENYLIST_FILE, data, () => {});
  denylistDirty = false;
}

// ─── Refresh tokens ───────────────────────────────────────────────────────────

/**
 * Issue an opaque refresh token bound to a subject.
 * @param {string} sub  - user ID
 * @returns {string} opaque token
 */
export function issueRefresh(sub) {
  const token = crypto.randomBytes(48).toString('base64url');
  refreshStore.set(token, { sub, exp: Date.now() + REFRESH_TTL_MS });
  return token;
}

/**
 * Consume a refresh token — validates, rotates, returns sub.
 * Old token is invalidated immediately.
 * @param {string} token
 * @returns {string} sub
 */
export function consumeRefresh(token) {
  const entry = refreshStore.get(token);
  if (!entry) throw new Error('refresh_token_invalid');
  if (Date.now() > entry.exp) {
    refreshStore.delete(token);
    throw new Error('refresh_token_expired');
  }
  refreshStore.delete(token); // rotate — old token is now dead
  return entry.sub;
}

function cleanRefreshStore() {
  const now = Date.now();
  for (const [token, entry] of refreshStore) {
    if (now > entry.exp) refreshStore.delete(token);
  }
}

// ─── JWKS endpoint ────────────────────────────────────────────────────────────

/**
 * Return the issuer's public key as JWKS JSON.
 * Served at GET /.well-known/jwks.json — always public.
 * External validators can use this to verify session tokens without
 * sharing any secret.
 */
export function jwks() {
  return {
    keys: [{
      kty: 'OKP',
      crv: 'Ed25519',
      use: 'sig',
      alg: 'EdDSA',
      x:   ISSUER_PUBLIC_KEY_B64
      // No 'kid' exported — this system uses a single deterministic key
    }]
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function b64url(str) {
  return Buffer.from(str).toString('base64url');
}

function b64urlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}
