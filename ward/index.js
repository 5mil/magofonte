/**
 * MagoFonte — ward module (hardened)
 *
 * Authentication + role-based access control + scope-based authorization.
 *
 * Roles (ascending privilege):
 *   member   — read-only: status, miners, payout, logs
 *   operator — member + force jobs, view settings
 *   admin    — operator + manage users, assign roles, toggle monetization,
 *              start/stop nodes, launch coins, edit configs
 *   owner    — admin + change owner credentials, delete accounts,
 *              full system control, treasury, cert provisioning
 *
 * Auth modes:
 *   Password + session token  — member / operator / admin accounts
 *   Ed25519 cert + challenge  — owner account only
 *
 * Token lifecycle:
 *   Session JWT:    30-minute TTL, signed with issuer Ed25519 key
 *   Refresh token:  7-day opaque token, HttpOnly cookie, server-side denylist
 *   Owner cert:     Term-length (1–24 mo), downloadable, jti-revocable
 *
 * Routes:
 *   POST /setup              — first-run: create owner (password + cert)
 *   GET  /challenge          — get a nonce for cert-based login
 *   POST /login              — password login → session token + refresh cookie
 *   POST /login/cert         — cert challenge response → session token + refresh cookie
 *   POST /refresh            — consume refresh token → new session token
 *   POST /logout             — revoke current session token jti
 *   GET  /me                 — current user info + scope
 *   GET  /.well-known/jwks   — issuer public key (always public)
 *   GET  /users              — list users (admin+)
 *   POST /users              — create user (admin+)
 *   PATCH /users/:id/role    — assign role (admin+)
 *   DELETE /users/:id        — delete user (owner only)
 *   POST /users/:id/password — change password
 *   POST /provision          — issue a new owner cert (owner only)
 *   POST /cert/revoke        — revoke a cert by jti (owner only)
 *   GET  /audit              — recent audit log entries (admin+)
 *   GET  /audit/verify       — verify audit chain integrity (owner only)
 */

import crypto  from 'node:crypto';
import fs      from 'node:fs';
import path    from 'node:path';
import { fileURLToPath } from 'node:url';
import * as issuer   from './issuer.js';
import * as audit    from './audit.js';
import { buildCertPayload, verifyCertSignature, certHasScope, certAudienceValid, SCOPE_PROFILES } from './certEngine.js';
import { lookupScope } from './scopeMap.js';

const __dir   = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dir, 'users.json');

// Role hierarchy — higher index = more privilege
const ROLES  = ['member', 'operator', 'admin', 'owner'];
const RANK   = Object.fromEntries(ROLES.map((r, i) => [r, i]));

// Active cert challenges: nonce → { exp, ip }
const challenges = new Map();

// ─── Password hashing (scrypt) ───────────────────────────────────────────────

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await new Promise((res, rej) =>
    crypto.scrypt(password, salt, 64, (e, d) => e ? rej(e) : res(d.toString('hex'))));
  return `${salt}:${hash}`;
}

async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const attempt = await new Promise((res, rej) =>
    crypto.scrypt(password, salt, 64, (e, d) => e ? rej(e) : res(d.toString('hex'))));
  return crypto.timingSafeEqual(Buffer.from(attempt), Buffer.from(hash));
}

// ─── User DB ─────────────────────────────────────────────────────────────────

function loadDB() {
  try   { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { users: {} }; }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ─── Ward module ─────────────────────────────────────────────────────────────

const Ward = {
  name: 'ward',
  db:   null,
  instanceId: null,

  async init(config, registry) {
    this.config     = config;
    this.registry   = registry;
    this.instanceId = process.env.SERVER_INSTANCE_ID || config.instanceId || 'default';
    this.db         = loadDB();

    // Init sub-modules
    await issuer.init();
    audit.init();

    if (!fs.existsSync(DB_FILE)) saveDB(this.db);
    console.log(`[ward] ready — ${Object.keys(this.db.users).length} user(s), instance: ${this.instanceId}`);
    return this;
  },

  // ── Middleware factory ────────────────────────────────────────────────────
  //
  // authenticate(minRole, requiredScope) → Express-style middleware
  //
  // Both role rank AND scope are checked independently.
  // Either check failing → 403.
  // Error codes are logged to audit but HTTP response is always generic.
  //
  authenticate(minRole = 'member', requiredScope = null) {
    const self = this;
    return (req, res, next) => {
      const auth  = req.headers['authorization'] || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) {
        return _401(res, 'not_authenticated');
      }
      try {
        const payload = issuer.verify(token, self.instanceId);

        // Role check
        if (RANK[payload.role] === undefined || RANK[payload.role] < RANK[minRole]) {
          audit.record('authz.failed', payload.username || 'unknown', {
            reason: 'insufficient_role', required: minRole, actual: payload.role
          });
          return _403(res, 'insufficient_role');
        }

        // Scope check — independent of role
        if (requiredScope && !(payload.scope || []).includes(requiredScope)) {
          audit.record('authz.failed', payload.username || 'unknown', {
            reason: 'scope_not_permitted', required: requiredScope
          });
          return _403(res, 'scope_not_permitted');
        }

        req.user = payload;
        next();
      } catch (err) {
        // All verify() errors return 401 to the outside world
        // Internal error code is available for audit but not leaked
        const code = err.message;
        if (code !== 'token_expired') {
          // Don't flood audit log with normal expirations
          audit.record('authn.failed', 'unknown', { code });
        }
        return _401(res, 'authentication_failed');
      }
    };
  },

  hasUser()    { return Object.keys(this.db.users).length > 0; },
  isOwnerSet() { return Object.values(this.db.users).some(u => u.role === 'owner'); },

  get routes() {
    const self = this;

    // Helper: read Bearer token directly (for routes that need manual auth)
    const getToken = req => (req.headers['authorization'] || '').slice(7);
    const verifyReq = req => issuer.verify(getToken(req), self.instanceId);

    return [

      // ── First-run setup ────────────────────────────────────────────────────
      ['POST', '/setup', async (req, res) => {
        if (self.isOwnerSet()) return _403(res, 'owner_already_exists');
        const { username, password, pubkey } = await _body(req);
        if (!username || !password) return _400(res, 'username and password required');
        if (password.length < 12)   return _400(res, 'password must be ≥12 chars');
        const id  = crypto.randomUUID();
        const pwd = await hashPassword(password);
        self.db.users[id] = {
          id, username, password: pwd, role: 'owner',
          createdAt: Date.now(),
          pubkey: pubkey || null  // optional: owner may register Ed25519 pubkey for cert auth
        };
        saveDB(self.db);
        audit.record('owner.setup', 'system', { username, hasPubkey: !!pubkey });
        const token   = issuer.sign({ sub: id, username, role: 'owner', scope: SCOPE_PROFILES['citadel'] }, self.instanceId);
        const refresh = issuer.issueRefresh(id);
        _setCookie(res, refresh);
        _json(res, { ok: true, token, username, role: 'owner' }, 201);
      }],

      // ── Challenge for cert-based login ────────────────────────────────────
      ['GET', '/challenge', (req, res) => {
        const nonce = crypto.randomBytes(32).toString('base64url');
        const exp   = Date.now() + 60_000; // 60 second window
        challenges.set(nonce, { exp, ip: req.socket.remoteAddress });
        // Clean up after expiry
        setTimeout(() => challenges.delete(nonce), 65_000);
        _json(res, { nonce, expires_in: 60 });
      }],

      // ── Cert-based login ──────────────────────────────────────────────────
      ['POST', '/login/cert', async (req, res) => {
        const { nonce, sig, cert } = await _body(req);
        if (!nonce || !sig || !cert) return _400(res, 'nonce, sig, and cert required');

        const challenge = challenges.get(nonce);
        if (!challenge || Date.now() > challenge.exp) {
          audit.record('login.failed', cert.sub || 'unknown', { reason: 'nonce_expired_or_invalid' });
          return _401(res, 'nonce_invalid');
        }
        challenges.delete(nonce);

        // Validate cert structure claims before touching any key
        if (cert.iss !== 'magofonte:lancia') {
          audit.record('login.failed', cert.sub || 'unknown', { reason: 'issuer_rejected' });
          return _401(res, 'authentication_failed');
        }
        if (!certAudienceValid(cert, self.instanceId)) {
          audit.record('login.failed', cert.sub || 'unknown', { reason: 'audience_mismatch' });
          return _401(res, 'authentication_failed');
        }
        if (!cert.exp || Math.floor(Date.now() / 1000) > cert.exp) {
          audit.record('login.failed', cert.sub || 'unknown', { reason: 'cert_expired' });
          return _401(res, 'authentication_failed');
        }

        // Verify nonce signature against cert's owner_pubkey
        const pubkeyBuf = Buffer.from(cert.owner_pubkey, 'base64url');
        const sigBuf    = Buffer.from(sig, 'base64url');
        const nonceBuf  = Buffer.from(nonce);
        let sigValid = false;
        try {
          sigValid = crypto.verify(null, nonceBuf, {
            key: pubkeyBuf, format: 'raw', type: 'public', dsaEncoding: 'ieee-p1363'
          }, sigBuf);
        } catch { sigValid = false; }

        if (!sigValid) {
          audit.record('login.failed', cert.sub || 'unknown', { reason: 'sig_invalid' });
          return _401(res, 'authentication_failed');
        }

        // Verify cert signature (the cert itself was signed by the same privkey at provisioning)
        if (!verifyCertSignature(cert)) {
          audit.record('login.failed', cert.sub || 'unknown', { reason: 'cert_sig_invalid' });
          return _401(res, 'authentication_failed');
        }

        // Find matching user
        const user = Object.values(self.db.users).find(u => u.username === cert.sub && u.role === 'owner');
        if (!user) {
          audit.record('login.failed', cert.sub, { reason: 'owner_not_found' });
          return _401(res, 'authentication_failed');
        }

        audit.record('login.cert', user.username, { cert_id: cert.cert_id, ip: req.socket.remoteAddress });
        const token   = issuer.sign({ sub: user.id, username: user.username, role: user.role, scope: cert.scope }, self.instanceId);
        const refresh = issuer.issueRefresh(user.id);
        _setCookie(res, refresh);
        _json(res, { token, username: user.username, role: user.role, scope: cert.scope });
      }],

      // ── Password login ────────────────────────────────────────────────────
      ['POST', '/login', async (req, res) => {
        const { username, password } = await _body(req);
        const user = Object.values(self.db.users).find(u => u.username === username);
        if (!user) {
          audit.record('login.failed', username, { reason: 'user_not_found' });
          return _401(res, 'invalid_credentials');
        }
        const ok = await verifyPassword(password, user.password);
        if (!ok) {
          audit.record('login.failed', username, { reason: 'wrong_password' });
          return _401(res, 'invalid_credentials');
        }
        // Scope for non-owner accounts is derived from role
        const scope = roleScopeForNonOwner(user.role);
        audit.record('login.password', user.username, { ip: req.socket.remoteAddress });
        const token   = issuer.sign({ sub: user.id, username: user.username, role: user.role, scope }, self.instanceId);
        const refresh = issuer.issueRefresh(user.id);
        _setCookie(res, refresh);
        self.registry.emit('ward:login', { username: user.username, role: user.role });
        _json(res, { token, username: user.username, role: user.role, scope });
      }],

      // ── Refresh ───────────────────────────────────────────────────────────
      ['POST', '/refresh', async (req, res) => {
        const cookie = _getCookie(req, 'mf_refresh');
        if (!cookie) return _401(res, 'no_refresh_token');
        try {
          const sub  = issuer.consumeRefresh(cookie);
          const user = self.db.users[sub];
          if (!user) return _401(res, 'user_not_found');
          const scope  = user.role === 'owner'
            ? SCOPE_PROFILES['citadel']
            : roleScopeForNonOwner(user.role);
          audit.record('token.refresh', user.username, {});
          const token   = issuer.sign({ sub: user.id, username: user.username, role: user.role, scope }, self.instanceId);
          const refresh = issuer.issueRefresh(user.id);
          _setCookie(res, refresh);
          _json(res, { token, username: user.username, role: user.role });
        } catch (err) {
          return _401(res, err.message);
        }
      }],

      // ── Logout ────────────────────────────────────────────────────────────
      ['POST', '/logout', (req, res) => {
        try {
          const payload = verifyReq(req);
          issuer.revoke(payload.jti);
          audit.record('token.revoked', payload.username, { jti: payload.jti });
        } catch { /* already invalid — that's fine */ }
        res.setHeader('Set-Cookie', 'mf_refresh=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/');
        _json(res, { ok: true });
      }],

      // ── Me ────────────────────────────────────────────────────────────────
      ['GET', '/me', (req, res) => {
        try {
          const p = verifyReq(req);
          _json(res, { id: p.sub, username: p.username, role: p.role, scope: p.scope || [] });
        } catch { _401(res, 'not_authenticated'); }
      }],

      // ── JWKS — always public ──────────────────────────────────────────────
      ['GET', '/.well-known/jwks', (req, res) => {
        _json(res, issuer.jwks());
      }],

      // ── Provision new owner cert ──────────────────────────────────────────
      ['POST', '/provision', async (req, res) => {
        try {
          const p = verifyReq(req);
          if (p.role !== 'owner') return _403(res, 'owner_only');
          const { pubkey, instanceId, tier, termMonths, scopeOverride } = await _body(req);
          if (!pubkey) return _400(res, 'pubkey required');
          const payload = buildCertPayload({
            username:     p.username,
            instanceId:   instanceId || self.instanceId,
            tier:         tier       || 'forge',
            termMonths:   termMonths || 12,
            ownerPubkeyB64: pubkey,
            scopeOverride
          });
          audit.record('cert.provisioned', p.username, {
            cert_id: payload.cert_id, tier, termMonths, instanceId: payload.env.instance_id
          });
          // Return unsigned payload — browser signs it with the private key
          _json(res, { ok: true, certPayload: payload }, 201);
        } catch (err) {
          _400(res, err.message);
        }
      }],

      // ── Revoke cert jti ───────────────────────────────────────────────────
      ['POST', '/cert/revoke', async (req, res) => {
        try {
          const p = verifyReq(req);
          if (p.role !== 'owner') return _403(res, 'owner_only');
          const { jti } = await _body(req);
          if (!jti) return _400(res, 'jti required');
          issuer.revoke(jti);
          audit.record('cert.revoked', p.username, { jti });
          _json(res, { ok: true, jti });
        } catch (err) { _401(res, err.message); }
      }],

      // ── List users (admin+) ───────────────────────────────────────────────
      ['GET', '/users', (req, res) => {
        try {
          const p = verifyReq(req);
          if (RANK[p.role] < RANK['admin']) return _403(res, 'admin_required');
          _json(res, Object.values(self.db.users).map(u => ({
            id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, hasPubkey: !!u.pubkey
          })));
        } catch { _401(res, 'not_authenticated'); }
      }],

      // ── Create user (admin+) ──────────────────────────────────────────────
      ['POST', '/users', async (req, res) => {
        try {
          const p = verifyReq(req);
          if (RANK[p.role] < RANK['admin']) return _403(res, 'admin_required');
          const { username, password, role = 'member' } = await _body(req);
          if (!username || !password) return _400(res, 'username and password required');
          if (!ROLES.includes(role))  return _400(res, `invalid role — must be: ${ROLES.join('|')}`);
          if (role === 'owner' && p.role !== 'owner') return _403(res, 'only owner can create owner accounts');
          if (Object.values(self.db.users).find(u => u.username === username)) return _400(res, 'username taken');
          const id  = crypto.randomUUID();
          const pwd = await hashPassword(password);
          self.db.users[id] = { id, username, password: pwd, role, createdAt: Date.now(), pubkey: null };
          saveDB(self.db);
          audit.record('user.created', p.username, { newUser: username, role });
          _json(res, { id, username, role }, 201);
        } catch(e) { _401(res, e.message); }
      }],

      // ── Assign role (admin+) ──────────────────────────────────────────────
      ['PATCH', '/users/:id/role', async (req, res) => {
        try {
          const p = verifyReq(req);
          if (RANK[p.role] < RANK['admin']) return _403(res, 'admin_required');
          const { role } = await _body(req);
          if (!ROLES.includes(role)) return _400(res, 'invalid role');
          if (role === 'owner' && p.role !== 'owner') return _403(res, 'only owner can assign owner role');
          const target = self.db.users[req.params.id];
          if (!target) return _404(res);
          i