/**
 * MagoFonte — ward/index.js  (main branch)
 *
 * Lightweight offline-safe authentication module.
 *
 * Design constraints
 * ──────────────────────────────────────────────
 * This is the `main` branch ward. It must:
 *   - Work fully airgapped, no internet required
 *   - Have zero external npm dependencies
 *   - Be simple enough that a self-hosted operator can audit it
 *   - Protect the admin panel with a real password (not a raw API key)
 *
 * What this ward deliberately does NOT include:
 *   - Ed25519 keypairs or JWKS
 *   - Cert provisioning or cert-based login
 *   - Scope maps or per-route scope binding
 *   - Chained audit logs
 *   - Multi-user roles or tier enforcement
 *
 * Those features belong to the `lancia` branch ward.
 *
 * Auth model
 * ──────────────────────────────────────────────
 *   Storage:    app/vault/ward.json  (auto-created on first-run setup)
 *   Password:   scrypt  N=16384, r=8, p=1, keylen=64
 *               salt = randomBytes(32), stored with hash
 *   Tokens:     HS256 JWT — HMAC-SHA256 over header.payload
 *               secret = crypto.randomBytes(48) on boot, never written to disk
 *               Forcing re-login after restart is intentional: long-lived
 *               on-disk secrets are a larger attack surface.
 *               Access token:  8h
 *               Refresh token: 7d, rotated on each use
 *   Revocation: in-memory Set — cleared on restart
 *   Account:    Single owner — no multi-user on main
 *   Role:       'owner' only
 *
 * authenticate() call signature is intentionally compatible with the
 * lancia ward's authenticate(minRole, scope) — extra args are ignored
 * here, so core/index.js can call ward.authenticate() identically on
 * both branches.
 */

import crypto        from 'node:crypto';
import fs            from 'node:fs';
import path          from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// ─── Config ──────────────────────────────────────────────────────────────────

const VAULT_DIR  = process.env.VAULT_DIR || path.resolve('app/vault');
const WARD_FILE  = path.join(VAULT_DIR, 'ward.json');

const SCRYPT_N   = 16384;
const SCRYPT_R   = 8;
const SCRYPT_P   = 1;
const SCRYPT_LEN = 64;

const ACCESS_TTL  = 8  * 60 * 60;       // 8 hours
const REFRESH_TTL = 7  * 24 * 60 * 60;  // 7 days

// Boot-time HMAC secret — never persisted.
// All active sessions become invalid on server restart.
const HMAC_SECRET = crypto.randomBytes(48);

// In-memory refresh token revocation list.
// Cleared on restart — all refresh tokens are implicitly invalidated
// when HMAC_SECRET rotates anyway.
const revokedRefresh = new Set();

// ─── Persistence ─────────────────────────────────────────────────────────────

function _readWard() {
  try {
    return JSON.parse(fs.readFileSync(WARD_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function _writeWard(data) {
  fs.mkdirSync(VAULT_DIR, { recursive: true });
  fs.writeFileSync(WARD_FILE, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
}

// ─── scrypt helpers ───────────────────────────────────────────────────────────

async function _hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = await scrypt(password, salt, SCRYPT_LEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  });
  return `${salt}:${hash.toString('hex')}`;
}

async function _verifyPassword(password, stored) {
  const [salt, storedHex] = stored.split(':');
  const derived   = await scrypt(password, salt, SCRYPT_LEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  });
  const storedBuf = Buffer.from(storedHex, 'hex');
  // Constant-time comparison — prevents timing oracle
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

// ─── Minimal HS256 JWT (no external library) ─────────────────────────────────
//
// Format: b64url(header) . b64url(payload) . b64url(sig)
// Signature: HMAC-SHA256(header.payload, HMAC_SECRET)

function _b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _b64urlDecode(str) {
  return Buffer.from(
    str.replace(/-/g, '+').replace(/_/g, '/'),
    'base64'
  );
}

function _signJWT(payload) {
  const h   = _b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p   = _b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', HMAC_SECRET)
                    .update(`${h}.${p}`)
                    .digest();
  return `${h}.${p}.${_b64url(sig)}`;
}

function _verifyJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, sigGiven] = parts;

    const sigExpected = _b64url(
      crypto.createHmac('sha256', HMAC_SECRET)
            .update(`${h}.${p}`)
            .digest()
    );

    // Constant-time signature comparison
    const a = Buffer.from(sigExpected);
    const b = Buffer.from(sigGiven);
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(_b64urlDecode(p).toString('utf8'));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function _makeTokens(username, role) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access: _signJWT({
      sub: username, role, type: 'access',
      iat: now, exp: now + ACCESS_TTL,
    }),
    refresh: _signJWT({
      sub: username, role, type: 'refresh',
      iat: now, exp: now + REFRESH_TTL,
    }),
  };
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function _readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data',  chunk => { raw += chunk; });
    req.on('end',   () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function _json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ─── Module ───────────────────────────────────────────────────────────────────

const ward = {
  name: 'ward',

  async init(cfg = {}, registry) {
    const stored  = _readWard();
    const isSetup = !!(stored?.passwordHash);
    if (!isSetup) {
      console.warn('[ward] ⚠  no owner account — call POST /api/v1/ward/setup to initialise');
    } else {
      console.log('[ward] offline auth ready — scrypt/HS256');
    }
    return this;
  },

  // ── authenticate() middleware ─────────────────────────────────────────────
  //
  // Compatible call signature with lancia ward:
  //   ward.authenticate()               — used by core/index.js on main
  //   ward.authenticate(minRole, scope) — used by core/index.js on lancia
  // Extra args are silently ignored here.

  authenticate(_minRole = 'owner', _scope = null) {
    return (req, res, next) => {
      const auth  = req.headers['authorization'] || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;

      if (!token) {
        return _json(res, 401, { error: 'authentication_required' });
      }
      const payload = _verifyJWT(token);
      if (!payload) {
        return _json(res, 401, { error: 'invalid_or_expired_token' });
      }
      if (payload.type !== 'access') {
        return _json(res, 401, { error: 'wrong_token_type' });
      }
      req.user = { username: payload.sub, role: payload.role };
      next();
    };
  },

  // ── Routes ───────────────────────────────────────────────────────────────
  //
  // 3-tuple: [method, path, handler]
  // 4-tuple: [method, path, handler, meta]  — meta.public = true skips auth
  // core/index.js mounts these under /api/v1/ward

  get routes() {
    return [
      ['GET',  '/status',  this._status.bind(this),  { public: true }],
      ['POST', '/setup',   this._setup.bind(this),   { public: true }],
      ['POST', '/login',   this._login.bind(this),   { public: true }],
      ['POST', '/refresh', this._refresh.bind(this), { public: true }],
      ['POST', '/logout',  this._logout.bind(this)],
    ];
  },

  // GET /ward/status — always public
  _status(req, res) {
    const stored = _readWard();
    _json(res, 200, {
      branch:  'main',
      auth:    'scrypt-HS256',
      setup:   !!(stored?.passwordHash),
      offline: true,
      uptime:  process.uptime(),
    });
  },

  // POST /ward/setup — first-run only, permanently locked after first call
  async _setup(req, res) {
    const stored = _readWard();
    if (stored?.passwordHash) {
      return _json(res, 409, { error: 'already_configured' });
    }
    const { username, password } = await _readBody(req);
    if (!username || typeof username !== 'string' || username.trim().length < 2) {
      return _json(res, 400, { error: 'invalid_username', min_length: 2 });
    }
    if (!password || typeof password !== 'string' || password.length < 12) {
      return _json(res, 400, { error: 'password_too_short', min_length: 12 });
    }
    const passwordHash = await _hashPassword(password);
    _writeWard({
      username:     username.trim(),
      passwordHash,
      createdAt:    new Date().toISOString(),
    });
    console.log(`[ward] owner account created: ${username.trim()}`);
    const tokens = _makeTokens(username.trim(), 'owner');
    _json(res, 201, {
      message:  'owner account created',
      username: username.trim(),
      token:    tokens.access,
      refresh:  tokens.refresh,
      expires:  ACCESS_TTL,
    });
  },

  // POST /ward/login
  async _login(req, res) {
    const stored = _readWard();
    if (!stored?.passwordHash) {
      return _json(res, 503, {
        error: 'not_configured',
        hint:  'POST /api/v1/ward/setup to create the owner account',
      });
    }
    const { username, password } = await _readBody(req);
    if (!username || !password) {
      return _json(res, 400, { error: 'missing_credentials' });
    }

    // Always run scrypt even on wrong username — prevents timing-based
    // username enumeration.
    const usernameMatch = username === stored.username;
    const passwordOk    = await _verifyPassword(
      password,
      usernameMatch ? stored.passwordHash : stored.passwordHash
    );

    if (!usernameMatch || !passwordOk) {
      return _json(res, 401, { error: 'invalid_credentials' });
    }

    const tokens = _makeTokens(stored.username, 'owner');
    _json(res, 200, {
      token:    tokens.access,
      refresh:  tokens.refresh,
      username: stored.username,
      role:     'owner',
      expires:  ACCESS_TTL,
    });
  },

  // POST /ward/refresh — rotates refresh token
  async _refresh(req, res) {
    const { refresh } = await _readBody(req);
    if (!refresh) {
      return _json(res, 400, { error: 'missing_refresh_token' });
    }
    if (revokedRefresh.has(refresh)) {
      return _json(res, 401, { error: 'token_revoked' });
    }
    const payload = _verifyJWT(refresh);
    if (!payload || payload.type !== 'refresh') {
      return _json(res, 401, { error: 'invalid_or_expired_refresh_token' });
    }
    // Revoke the used refresh token before issuing a new pair
    revokedRefresh.add(refresh);
    const tokens = _makeTokens(payload.sub, payload.role);
    _json(res, 200, {
      token:   tokens.access,
      refresh: tokens.refresh,
      expires: ACCESS_TTL,
    });
  },

  // POST /ward/logout — requires auth (no { public: true } meta)
  async _logout(req, res) {
    const { refresh } = await _readBody(req);
    if (refresh) revokedRefresh.add(refresh);
    _json(res, 200, { message: 'logged out' });
  },
};

export default ward;
