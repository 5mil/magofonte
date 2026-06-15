/**
 * MagoFonte — ward module
 *
 * Authentication + role-based access control.
 *
 * Roles (ascending privilege):
 *   member  — read-only: status, miners, payout, logs
 *   operator— member + force jobs, view settings
 *   admin   — operator + manage users, assign roles,
 *             toggle monetization, start/stop nodes,
 *             launch coins, edit all configs
 *   owner   — admin + change owner credentials,
 *             delete accounts, full system control
 *
 * Flow:
 *   POST /api/v1/ward/setup       — first-run: create owner account
 *   POST /api/v1/ward/login       — returns signed JWT
 *   GET  /api/v1/ward/me          — current user info
 *   GET  /api/v1/ward/users       — list users (admin+)
 *   POST /api/v1/ward/users       — create user (admin+)
 *   PATCH /api/v1/ward/users/:id/role — assign role (admin+)
 *   DELETE /api/v1/ward/users/:id — delete user (owner only)
 *
 * JWT middleware: ward.authenticate(minRole)
 * Use in core router to protect routes.
 */

import crypto from 'node:crypto';
import fs     from 'node:fs';
import path   from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir   = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dir, 'users.json');

// Role hierarchy — higher index = more privilege
const ROLES  = ['member', 'operator', 'admin', 'owner'];
const RANK   = Object.fromEntries(ROLES.map((r, i) => [r, i]));

// ─── Tiny JWT (HMAC-SHA256, no deps) ─────────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g,'+').replace(/_/g,'/'), 'base64');
}

function signJWT(payload, secret) {
  const header  = b64url(JSON.stringify({ alg:'HS256', typ:'JWT' }));
  const body    = b64url(JSON.stringify(payload));
  const sig     = b64url(crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

function verifyJWT(token, secret) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [header, body, sig] = parts;
  const expected = b64url(crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest());
  if (sig !== expected) throw new Error('invalid signature');
  const payload = JSON.parse(b64urlDecode(body).toString());
  if (payload.exp && Date.now() / 1000 > payload.exp) throw new Error('token expired');
  return payload;
}

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

// ─── User DB (JSON file, good enough for home server) ────────────────────────

function loadDB() {
  try   { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { users: {}, jwtSecret: crypto.randomBytes(48).toString('hex') }; }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ─── Ward module ─────────────────────────────────────────────────────────────

const Ward = {
  name: 'ward',

  async init(config, registry) {
    this.config   = config;
    this.registry = registry;
    this.db       = loadDB();
    // Persist new secret if first run
    if (!fs.existsSync(DB_FILE)) saveDB(this.db);
    console.log(`[ward] auth ready — ${Object.keys(this.db.users).length} user(s) registered`);
    return this;
  },

  // ── Middleware factory ── authenticate(minRole) → (req,res,next) => void
  authenticate(minRole = 'member') {
    return (req, res, next) => {
      const auth  = req.headers['authorization'] || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) { res.writeHead(401); return res.end(JSON.stringify({ error: 'not authenticated' })); }
      try {
        const payload = verifyJWT(token, this.db.jwtSecret);
        if (RANK[payload.role] < RANK[minRole]) {
          res.writeHead(403);
          return res.end(JSON.stringify({ error: `requires role: ${minRole}` }));
        }
        req.user = payload;
        next();
      } catch (err) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: err.message }));
      }
    };
  },

  hasUser()    { return Object.keys(this.db.users).length > 0; },
  isOwnerSet() { return Object.values(this.db.users).some(u => u.role === 'owner'); },

  get routes() {
    const self = this;
    return [

      // ── First-run setup: create owner ──────────────────────────────────────
      ['POST', '/setup', async (req, res) => {
        if (self.isOwnerSet()) return _403(res, 'owner already exists');
        const { username, password } = await _body(req);
        if (!username || !password) return _400(res, 'username + password required');
        if (password.length < 12)  return _400(res, 'password must be ≥12 chars');
        const id  = crypto.randomUUID();
        const pwd = await hashPassword(password);
        self.db.users[id] = { id, username, password: pwd, role: 'owner', createdAt: Date.now() };
        saveDB(self.db);
        console.log(`[ward] owner account created: ${username}`);
        _json(res, { ok: true, username, role: 'owner' }, 201);
      }],

      // ── Login ──────────────────────────────────────────────────────────────
      ['POST', '/login', async (req, res) => {
        const { username, password } = await _body(req);
        const user = Object.values(self.db.users).find(u => u.username === username);
        if (!user) return _401(res, 'invalid credentials');
        const ok = await verifyPassword(password, user.password);
        if (!ok)  return _401(res, 'invalid credentials');
        const token = signJWT(
          { sub: user.id, username: user.username, role: user.role,
            exp: Math.floor(Date.now()/1000) + 60 * 60 * 24 * 7 },  // 7 day
          self.db.jwtSecret
        );
        self.registry.emit('ward:login', { username: user.username, role: user.role });
        _json(res, { token, username: user.username, role: user.role });
      }],

      // ── Me ─────────────────────────────────────────────────────────────────
      ['GET', '/me', (req, res) => {
        const auth  = (req.headers['authorization']||'').slice(7);
        try {
          const p = verifyJWT(auth, self.db.jwtSecret);
          _json(res, { id: p.sub, username: p.username, role: p.role });
        } catch { _401(res, 'not authenticated'); }
      }],

      // ── List users (admin+) ────────────────────────────────────────────────
      ['GET', '/users', (req, res) => {
        const auth  = (req.headers['authorization']||'').slice(7);
        try {
          const p = verifyJWT(auth, self.db.jwtSecret);
          if (RANK[p.role] < RANK['admin']) return _403(res, 'requires admin');
          _json(res, Object.values(self.db.users).map(u => ({
            id: u.id, username: u.username, role: u.role, createdAt: u.createdAt
          })));
        } catch { _401(res, 'not authenticated'); }
      }],

      // ── Create user (admin+) ───────────────────────────────────────────────
      ['POST', '/users', async (req, res) => {
        const auth = (req.headers['authorization']||'').slice(7);
        try {
          const p = verifyJWT(auth, self.db.jwtSecret);
          if (RANK[p.role] < RANK['admin']) return _403(res, 'requires admin');
          const { username, password, role = 'member' } = await _body(req);
          if (!username || !password) return _400(res, 'username + password required');
          if (!ROLES.includes(role))  return _400(res, `invalid role — must be: ${ROLES.join('|')}`);
          if (role === 'owner' && p.role !== 'owner') return _403(res, 'only owner can create owner accounts');
          if (Object.values(self.db.users).find(u => u.username === username))
            return _400(res, 'username taken');
          const id  = crypto.randomUUID();
          const pwd = await hashPassword(password);
          self.db.users[id] = { id, username, password: pwd, role, createdAt: Date.now() };
          saveDB(self.db);
          _json(res, { id, username, role }, 201);
        } catch(e) { _401(res, e.message); }
      }],

      // ── Assign role (admin+) ───────────────────────────────────────────────
      ['PATCH', '/users/:id/role', async (req, res) => {
        const auth = (req.headers['authorization']||'').slice(7);
        try {
          const p    = verifyJWT(auth, self.db.jwtSecret);
          if (RANK[p.role] < RANK['admin']) return _403(res, 'requires admin');
          const { role } = await _body(req);
          if (!ROLES.includes(role)) return _400(res, 'invalid role');
          if (role === 'owner' && p.role !== 'owner') return _403(res, 'only owner can assign owner role');
          const target = self.db.users[req.params.id];
          if (!target) return _404(res);
          // Prevent self-demotion of sole owner
          if (target.role === 'owner' && role !== 'owner') {
            const ownerCount = Object.values(self.db.users).filter(u => u.role==='owner').length;
            if (ownerCount <= 1) return _400(res, 'cannot demote sole owner');
          }
          target.role = role;
          saveDB(self.db);
          _json(res, { id: target.id, username: target.username, role });
        } catch(e) { _401(res, e.message); }
      }],

      // ── Delete user (owner only) ───────────────────────────────────────────
      ['DELETE', '/users/:id', async (req, res) => {
        const auth = (req.headers['authorization']||'').slice(7);
        try {
          const p = verifyJWT(auth, self.db.jwtSecret);
          if (p.role !== 'owner') return _403(res, 'owner only');
          const target = self.db.users[req.params.id];
          if (!target) return _404(res);
          if (target.id === p.sub) return _400(res, 'cannot delete own account');
          delete self.db.users[req.params.id];
          saveDB(self.db);
          _json(res, { ok: true });
        } catch(e) { _401(res, e.message); }
      }],

      // ── Change password ────────────────────────────────────────────────────
      ['POST', '/users/:id/password', async (req, res) => {
        const auth = (req.headers['authorization']||'').slice(7);
        try {
          const p = verifyJWT(auth, self.db.jwtSecret);
          // Users can change own password; admins can change member/operator passwords
          const target = self.db.users[req.params.id];
          if (!target) return _404(res);
          const isSelf  = p.sub === target.id;
          const canEdit = isSelf || (RANK[p.role] >= RANK['admin'] && RANK[target.role] < RANK[p.role]);
          if (!canEdit) return _403(res, 'insufficient privileges');
          const { password } = await _body(req);
          if (!password || password.length < 12) return _400(res, 'password must be ≥12 chars');
          target.password = await hashPassword(password);
          saveDB(self.db);
          _json(res, { ok: true });
        } catch(e) { _401(res, e.message); }
      }]
    ];
  }
};

function _json(res, d, s=200) { res.writeHead(s,{'Content-Type':'application/json'}); res.end(JSON.stringify(d)); }
function _400(res,m) { res.writeHead(400); res.end(JSON.stringify({error:m})); }
function _401(res,m) { res.writeHead(401); res.end(JSON.stringify({error:m})); }
function _403(res,m) { res.writeHead(403); res.end(JSON.stringify({error:m})); }
function _404(res)   { res.writeHead(404); res.end(JSON.stringify({error:'not found'})); }
async function _body(req) {
  let b=''; for await (const c of req) b+=c;
  try { return JSON.parse(b); } catch { return {}; }
}

export default Ward;
