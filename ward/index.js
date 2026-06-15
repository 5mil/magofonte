/**
 * MagoFonte — ward module
 *
 * Authentication, session management, and role-based access control.
 *
 * Roles (hierarchy, highest first):
 *   admin   — full access, manages accounts + permissions
 *   dev     — pool/node control, coin launch, settings, no account management
 *   operator— start/stop mining, view all, no settings changes
 *   member  — default for all new accounts; view-only + own stats
 *
 * All new accounts created as 'member'. Only admin can promote/demote.
 * First account registered automatically becomes admin.
 *
 * Sessions: signed JWT-like tokens (HMAC-SHA256), stored in memory + persisted
 * to ward/sessions.json. Token in Authorization: Bearer <token> header
 * or __token cookie.
 *
 * Persists to ward/users.json.
 */

import fs     from 'node:fs';
import path   from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dir       = path.dirname(fileURLToPath(import.meta.url));
const USERS_FILE  = path.join(__dir, 'users.json');
const SECRET_FILE = path.join(__dir, '.secret');

// ─── Role definitions ───────────────────────────────────────────────────────────

export const ROLES = ['admin', 'dev', 'operator', 'member'];

// Permission → minimum role required
export const PERMISSIONS = {
  // Viewing
  'view:status':        'member',
  'view:miners':        'member',
  'view:payout':        'member',
  'view:logs':          'operator',
  'view:node':          'operator',
  'view:settings':      'operator',
  'view:accounts':      'admin',

  // Pool control
  'pool:start':         'operator',
  'pool:stop':          'operator',
  'pool:job:new':       'operator',
  'pool:settings:read': 'operator',
  'pool:settings:write':'dev',
  'pool:monetization':  'dev',

  // Node control
  'node:start':         'dev',
  'node:stop':          'dev',
  'node:register':      'dev',

  // Coin management
  'coin:launch':        'dev',
  'coin:delete':        'admin',

  // Account management
  'account:create':     'admin',
  'account:delete':     'admin',
  'account:promote':    'admin',
  'account:demote':     'admin',
  'account:grant':      'admin',
  'account:revoke':     'admin',

  // System
  'system:restart':     'admin',
  'system:config':      'admin',
};

// Default permissions per role (what member gets vs what admin gets)
export const ROLE_PERMISSIONS = {
  admin:    Object.keys(PERMISSIONS),
  dev:      Object.keys(PERMISSIONS).filter(p => PERMISSIONS[p] !== 'admin'),
  operator: Object.keys(PERMISSIONS).filter(p => ['member','operator'].includes(PERMISSIONS[p])),
  member:   Object.keys(PERMISSIONS).filter(p => PERMISSIONS[p] === 'member'),
};

// ─── Token signing ───────────────────────────────────────────────────────────────

function loadSecret() {
  try { return fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(64).toString('hex');
  fs.writeFileSync(SECRET_FILE, s);
  return s;
}

const SECRET = loadSecret();

function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token) {
  try {
    const [data, sig] = token.split('.');
    const expected    = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return JSON.parse(Buffer.from(data, 'base64url').toString());
  } catch { return null; }
}

// ─── Password hashing ───────────────────────────────────────────────────────────

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 310_000, 32, 'sha256').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const { hash: h } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
}

// ─── UserStore ─────────────────────────────────────────────────────────────────

class UserStore {
  constructor() {
    this.users = this._load();
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; }
  }

  save() {
    fs.writeFileSync(USERS_FILE, JSON.stringify(this.users, null, 2));
  }

  count() { return Object.keys(this.users).length; }

  create(username, password, role) {
    if (this.users[username]) throw new Error(`user already exists: ${username}`);
    const { hash, salt } = hashPassword(password);
    this.users[username] = {
      username,
      role,
      hash, salt,
      // Extra permissions granted/revoked explicitly by admin beyond role defaults
      grantedPermissions:  [],
      revokedPermissions:  [],
      createdAt: Date.now(),
      lastLogin: null,
      active:    true
    };
    this.save();
    return this.publicView(username);
  }

  get(username) { return this.users[username] ?? null; }

  list() { return Object.values(this.users).map(u => this.publicView(u.username)); }

  publicView(username) {
    const u = this.users[username];
    if (!u) return null;
    return {
      username:    u.username,
      role:        u.role,
      permissions: this.effectivePermissions(username),
      active:      u.active,
      createdAt:   u.createdAt,
      lastLogin:   u.lastLogin
    };
  }

  effectivePermissions(username) {
    const u = this.users[username];
    if (!u) return [];
    const base    = new Set(ROLE_PERMISSIONS[u.role] || []);
    for (const p of (u.grantedPermissions || [])) base.add(p);
    for (const p of (u.revokedPermissions || [])) base.delete(p);
    return [...base];
  }

  hasPermission(username, permission) {
    return this.effectivePermissions(username).includes(permission);
  }

  setRole(username, role) {
    if (!ROLES.includes(role)) throw new Error(`invalid role: ${role}`);
    if (!this.users[username]) throw new Error(`user not found: ${username}`);
    this.users[username].role = role;
    this.save();
  }

  grantPermission(username, permission) {
    const u = this.users[username];
    if (!u) throw new Error(`user not found: ${username}`);
    if (!PERMISSIONS[permission]) throw new Error(`unknown permission: ${permission}`);
    if (!u.grantedPermissions.includes(permission)) u.grantedPermissions.push(permission);
    u.revokedPermissions = u.revokedPermissions.filter(p => p !== permission);
    this.save();
  }

  revokePermission(username, permission) {
    const u = this.users[username];
    if (!u) throw new Error(`user not found: ${username}`);
    if (!u.revokedPermissions.includes(permission)) u.revokedPermissions.push(permission);
    u.grantedPermissions = u.grantedPermissions.filter(p => p !== permission);
    this.save();
  }

  delete(username) {
    if (!this.users[username]) throw new Error(`user not found: ${username}`);
    delete this.users[username];
    this.save();
  }

  setPassword(username, password) {
    if (!this.users[username]) throw new Error(`user not found: ${username}`);
    const { hash, salt } = hashPassword(password);
    this.users[username].hash = hash;
    this.users[username].salt = salt;
    this.save();
  }

  recordLogin(username) {
    if (this.users[username]) {
      this.users[username].lastLogin = Date.now();
      this.save();
    }
  }
}

// ─── Ward module ────────────────────────────────────────────────────────────────

const Ward = {
  name: 'ward',

  async init(config, registry) {
    this.config   = config;
    this.registry = registry;
    this.store    = new UserStore();
    this.sessions = new Map(); // token → { username, expiresAt }

    // Auto-create first admin account if no users exist
    if (this.store.count() === 0) {
      const adminPass = config.adminPassword || process.env.ADMIN_PASSWORD || _randomPass();
      this.store.create('admin', adminPass, 'admin');
      console.log('\n' + '='.repeat(60));
      console.log('[ward] ⚠  FIRST RUN: admin account created');
      console.log(`[ward]    username: admin`);
      console.log(`[ward]    password: ${adminPass}`);
      console.log('[ward]    Change this immediately via the web panel.');
      console.log('='.repeat(60) + '\n');
    }

    return this;
  },

  // ── Auth ────────────────────────────────────────────────────────────

  login(username, password) {
    const user = this.store.get(username);
    if (!user || !user.active) return null;
    if (!verifyPassword(password, user.hash, user.salt)) return null;
    this.store.recordLogin(username);
    const payload = { username, role: user.role, iat: Date.now(), exp: Date.now() + 86_400_000 };
    const token   = signToken(payload);
    this.sessions.set(token, { username, expiresAt: payload.exp });
    return { token, user: this.store.publicView(username) };
  },

  logout(token) {
    this.sessions.delete(token);
  },

  // Verify token, return user public view or null
  authenticate(token) {
    if (!token) return null;
    const payload = verifyToken(token);
    if (!payload || payload.exp < Date.now()) { this.sessions.delete(token); return null; }
    const user = this.store.get(payload.username);
    if (!user || !user.active) return null;
    return this.store.publicView(payload.username);
  },

  // Extract token from request (Bearer header or cookie)
  extractToken(req) {
    const auth = req.headers['authorization'];
    if (auth?.startsWith('Bearer ')) return auth.slice(7);
    const cookie = req.headers['cookie'] || '';
    const m = cookie.match(/(?:^|;\s*)__token=([^;]+)/);
    return m ? m[1] : null;
  },

  // Middleware-style: authenticate + check permission
  // Returns user or sends 401/403 and returns null
  guard(req, res, permission) {
    const token = this.extractToken(req);
    const user  = this.authenticate(token);
    if (!user) { _json(res, { error: 'unauthorized' }, 401); return null; }
    if (permission && !user.permissions.includes(permission)) {
      _json(res, { error: 'forbidden', required: permission }, 403);
      return null;
    }
    return user;
  },

  // ── REST routes (/api/v1/ward/*) ──────────────────────────────────────────
  get routes() {
    return [
      // Login — public
      ['POST', '/login', async (req, res) => {
        const body = await _body(req);
        const { username, password } = JSON.parse(body);
        const result = this.login(username, password);
        if (!result) { _json(res, { error: 'invalid credentials' }, 401); return; }
        // Set cookie + return token
        res.setHeader('Set-Cookie', `__token=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
        _json(res, { ok: true, token: result.token, user: result.user });
      }],

      // Logout
      ['POST', '/logout', (req, res) => {
        const token = this.extractToken(req);
        if (token) this.logout(token);
        res.setHeader('Set-Cookie', '__token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        _json(res, { ok: true });
      }],

      // Who am I
      ['GET', '/me', (req, res) => {
        const user = this.guard(req, res);
        if (!user) return;
        _json(res, user);
      }],

      // List all users (admin only)
      ['GET', '/users', (req, res) => {
        const user = this.guard(req, res, 'view:accounts');
        if (!user) return;
        _json(res, this.store.list());
      }],

      // Create user (admin only)
      ['POST', '/users', async (req, res) => {
        const actor = this.guard(req, res, 'account:create');
        if (!actor) return;
        const body = await _body(req);
        try {
          const { username, password, role = 'member' } = JSON.parse(body);
          if (!username || !password) throw new Error('username and password required');
          // Only admin can create non-member accounts directly
          const assignedRole = actor.role === 'admin' ? role : 'member';
          const newUser = this.store.create(username, password, assignedRole);
          this.registry.emit('ward:user:created', { username, role: assignedRole, by: actor.username });
          _json(res, newUser, 201);
        } catch(e) { _json(res, { error: e.message }, 400); }
      }],

      // Get user
      ['GET', '/users/:username', (req, res) => {
        const actor = this.guard(req, res, 'view:accounts');
        if (!actor) return;
        const u = this.store.publicView(req.params.username);
        u ? _json(res, u) : _json(res, { error: 'not found' }, 404);
      }],

      // Delete user
      ['DELETE', '/users/:username', (req, res) => {
        const actor = this.guard(req, res, 'account:delete');
        if (!actor) return;
        if (req.params.username === actor.username) { _json(res, { error: 'cannot delete own account' }, 400); return; }
        try { this.store.delete(req.params.username); _json(res, { ok: true }); }
        catch(e) { _json(res, { error: e.message }, 404); }
      }],

      // Set role
      ['PATCH', '/users/:username/role', async (req, res) => {
        const actor = this.guard(req, res, 'account:promote');
        if (!actor) return;
        const body = await _body(req);
        try {
          const { role } = JSON.parse(body);
          this.store.setRole(req.params.username, role);
          this.registry.emit('ward:user:roleChanged', { username: req.params.username, role, by: actor.username });
          _json(res, this.store.publicView(req.params.username));
        } catch(e) { _json(res, { error: e.message }, 400); }
      }],

      // Grant permission
      ['POST', '/users/:username/grant', async (req, res) => {
        const actor = this.guard(req, res, 'account:grant');
        if (!actor) return;
        const body = await _body(req);
        try {
          const { permission } = JSON.parse(body);
          this.store.grantPermission(req.params.username, permission);
          _json(res, this.store.publicView(req.params.username));
        } catch(e) { _json(res, { error: e.message }, 400); }
      }],

      // Revoke permission
      ['POST', '/users/:username/revoke', async (req, res) => {
        const actor = this.guard(req, res, 'account:revoke');
        if (!actor) return;
        const body = await _body(req);
        try {
          const { permission } = JSON.parse(body);
          this.store.revokePermission(req.params.username, permission);
          _json(res, this.store.publicView(req.params.username));
        } catch(e) { _json(res, { error: e.message }, 400); }
      }],

      // Change own password
      ['POST', '/password', async (req, res) => {
        const actor = this.guard(req, res);
        if (!actor) return;
        const body = await _body(req);
        try {
          const { currentPassword, newPassword } = JSON.parse(body);
          const u = this.store.get(actor.username);
          if (!verifyPassword(currentPassword, u.hash, u.salt)) { _json(res, { error: 'wrong current password' }, 403); return; }
          if (newPassword.length < 8) { _json(res, { error: 'password must be at least 8 characters' }, 400); return; }
          this.store.setPassword(actor.username, newPassword);
          _json(res, { ok: true });
        } catch(e) { _json(res, { error: e.message }, 400); }
      }],

      // List all permissions (schema)
      ['GET', '/permissions', (req, res) => {
        const actor = this.guard(req, res, 'view:accounts');
        if (!actor) return;
        _json(res, { permissions: PERMISSIONS, roles: ROLE_PERMISSIONS });
      }]
    ];
  }
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function _json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function _body(req) {
  return new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b)); });
}
function _randomPass() {
  return crypto.randomBytes(8).toString('base64url');
}

export default Ward;
