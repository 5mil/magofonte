# MagoFonte — Architecture

> *The server is the product.*

---

## Mission

MagoFonte is an **offline-first, modular, self-hosted server platform** for:

- DGB (DigiByte) mining pool operation — Stratum V1, VarDiff, PPLNS
- Wallet management — AES-256-GCM vault, WIF import/export, hot swap
- Worker dispatch — GHA, Wandbox, Piston, local, and future adapters
- Distributed node infrastructure — peer discovery, mesh networking
- Local AI integration — self-hosted inference, no cloud dependency

### The Three Non-Negotiable Properties

1. **Offline-first** — every core function works with zero internet access. If a feature breaks without internet, it requires a local fallback or it does not land on `main`.
2. **Versatile** — any module can be enabled or disabled independently via `magofonte.config.json`. No module should be a hard dependency of another. The pool runs without the wallet UI. The wallet UI runs without the pool.
3. **Operator-owned** — the operator controls all keys, data, reward destinations, and auth secrets. Nothing is held by a third party. There is no phone-home, no license check, no cloud account required.

---

## Branch Contract

MagoFonte has two active development branches. **They are not versions of the same thing. They are different products.**

```
main   ──  MagoFonte Core
           The pool server engine. Self-hosted. Offline-capable.
           Free, open, operator-controlled. No managed infrastructure.

lancia ──  Lancia
           A credentialed managed server product built on top of MagoFonte.
           Tier-based, cert-authenticated, fleet-managed.
           Requires internet for provisioning, cert login, and fleet ops.
```

### Rules — enforced by convention, documented here

| Rule | Rationale |
|------|-----------|
| `lancia` **never merges into `main`** | Lancia is a divergent product track, not a feature branch. Its auth and fleet complexity must not pollute the self-hosted core. |
| Features that **require internet to function** must not land on `main` | Violates the offline-first property. |
| Auth complexity (Ed25519, JWKS, scope maps, cert provisioning) **stays on `lancia`** | Unnecessary overhead for a self-hosted operator running a LAN mining pool. |
| Protocol and pool improvements land on **`main` first** | `lancia` cherry-picks what it needs. Pool hot path is shared logic. |
| Every new `main` module must document its **offline fallback** | Modules that degrade gracefully when offline are permitted. Modules that hard-fail are not. |
| `main` ward and `lancia` ward share the **same `authenticate()` call signature** | Allows `core/index.js` to call ward identically on both branches without a conditional. |

---

## Module Map

```
magofonte/
├── core/        Module host, HTTP server, plugin registry, router
├── pool/        Stratum V1 TCP server, VarDiff, PPLNS, upstream proxy
├── bridge/      HTTP↔Stratum adapter for Wandbox/Piston/TIO workers
├── forge/       Worker dispatch engine — GHA, Wandbox, Piston, local
├── vault/       AES-256-GCM wallet store, WIF import/export, hot swap
├── ward/        Auth — see per-branch model below
├── stream/      WebSocket telemetry server — real-time share/hashrate events
├── sigil/       Admin dashboard UI
├── mesh/        Peer discovery, node registry (planned)
├── node/        DGB full node interface (planned)
├── coins/       Coin definitions — algo, address format, version bytes
└── console/     Local CLI interface
```

### Module Capability Matrix

| Module  | Offline-capable          | Internet-enhanced              | Status  |
|---------|--------------------------|--------------------------------|---------|
| core    | ✅ Full                  | —                              | Live    |
| pool    | ✅ Full (solo/local)     | Upstream pool relay            | Live    |
| bridge  | ✅ Full                  | Worker HTTP calls              | Live    |
| forge   | ✅ Local workers         | GHA / Wandbox / Piston         | Live    |
| vault   | ✅ Full                  | —                              | Live    |
| ward    | ✅ Full (`main`)         | Ed25519/JWKS (`lancia` only)   | Live    |
| stream  | ✅ Full                  | —                              | Live    |
| sigil   | ✅ Full                  | —                              | Live    |
| mesh    | ✅ LAN peer discovery    | WAN peer discovery             | Planned |
| node    | ✅ Full                  | DGB network sync               | Planned |

---

## Auth Model

### `main` — Lightweight Offline Ward

**Goal:** protect the admin panel. Work airgapped. Zero external dependencies.

```
Storage:    app/vault/ward.json   (auto-created on first-run setup)
Password:   scrypt  N=16384, r=8, p=1, keylen=64
            salt = randomBytes(32) stored alongside hash
Tokens:     HS256 JWT — HMAC-SHA256 over header.payload
            secret = crypto.randomBytes(48) on boot, never written to disk
            Access token:  8h expiry
            Refresh token: 7d expiry, rotated on each use
Revocation: in-memory Set — cleared on restart (re-login required)
Accounts:   Single owner account — no multi-user on main
Roles:      'owner' only
```

Endpoints:

```
GET  /api/v1/ward/status    Public. Returns setup state and uptime.
POST /api/v1/ward/setup     First-run only. Locked permanently after first call.
POST /api/v1/ward/login     username + password → { token, refresh }
POST /api/v1/ward/refresh   Refresh token rotation → new { token, refresh }
POST /api/v1/ward/logout    Adds refresh token to revocation set.
```

Middleware:

```js
ward.authenticate()   // verifies JWT, attaches req.user = { username, role }
                      // returns 401 if missing / invalid / expired
```

**What `main` ward deliberately does NOT have:**
- Ed25519 keypairs or JWKS endpoints
- Cert provisioning or cert-based login
- Scope profiles or per-route scope binding
- Chained audit logs
- Multi-user roles or tier enforcement

Those features belong exclusively to `lancia`.

---

### `lancia` — Scope-Bound Ed25519 Ward

**Goal:** credential and authorize managed Lancia instances. Tier-locked. Cert-based.

```
Storage:    app/vault/audit.jsonl   (chained audit log, tamper-evident)
Password:   scrypt (setup only)
Tokens:     ES256-equivalent JWT with scope[] + role + tier claims
            Signed by Ed25519 issuer keypair (generated on first setup)
Cert login: Ed25519 private key in browser IndexedDB (extractable:false)
            Challenge-response: GET /challenge → nonce → sign → POST /login/cert
Accounts:   Owner cert (provisioned client-side via certEngine.browser.js)
Roles:      owner, admin, member
Tiers:      hearth, forge, foundry, citadel
```

Files on `lancia`:

```
ward/certEngine.js          Server cert engine — sign, verify, provision
ward/certEngine.browser.js  Client cert engine — SubtleCrypto, IndexedDB
ward/issuer.js              JWKS-capable Ed25519 token issuer
ward/scopeMap.js            Route → scope → minRole canonical table
ward/audit.js               Chained audit log
ward/index.js               Full auth module
```

Middleware (same call signature as `main`):

```js
ward.authenticate(minRole, scope)  // minRole + scope resolved from scopeMap
                                   // if not supplied via route meta
```

---

## Pool Architecture

```
Workers
  GHA runner  │  Wandbox  │  Piston  │  local process
              │
              ▼
        [ forge ]        Worker dispatch engine
                         Selects worker type, sends job payload
                         Adapters: gha, wandbox, piston, local
              │
              ▼
        [ bridge ]       HTTP↔Stratum adapter
                         Workers POST a job result over HTTP
                         Bridge translates to Stratum share submission
                         Solves HTTP/TCP split for restricted workers
              │
              ▼
        [ pool ]         Stratum V1 TCP server  :3333
                         ┌─────────────────────────────┐
                         │  MinerSession (per worker)  │
                         │  subscribe / auth / notify  │
                         │  submit / vardiff           │
                         │  share accounting (PPLNS)   │
                         └──────────────┬──────────────┘
                                        │
                                        ▼
                         [ UpstreamConn ]   TCP relay
                         Connects to external pool (Mining-Dutch etc.)
                         Auto-reconnect every 10s on drop
                         Failover priority list
                         Fans jobs to all connected miners
```

### Pool Capabilities

| Capability       | Implementation                                     |
|------------------|----------------------------------------------------|
| Protocol         | Stratum V1                                         |
| Difficulty       | VarDiff — real-time, per-miner                     |
| Payout           | PPLNS                                              |
| Primary algo     | Skein512 double-hash — pure JS, NIST boot test     |
| Hash primitive   | Threefish-512, 72 rounds, 8 MIX pairs, UBI chain   |
| Address format   | Base58Check, P2PKH + P2SH, multi-coin version bytes|
| Wallet vault     | AES-256-GCM, per-coin registry                     |
| Key management   | WIF import/export, secp256k1 keygen                |
| Hot swap         | Active wallet change without pool restart          |
| Target coin      | DigiByte (DGB)                                     |
| Planned algos    | Scrypt, Qubit, OdoCrypt, SHA256d                   |

---

## Data Storage

MagoFonte core uses **no external database**. All persistence is local file-based.
No Supabase, no Postgres, no Redis required on `main`.

| Data              | Format           | Location                     |
|-------------------|------------------|------------------------------|
| Config            | JSON             | `magofonte.config.json`      |
| Wallet vault      | AES-256-GCM      | `app/vault/<coin>.vault`     |
| Ward session      | JSON             | `app/vault/ward.json`        |
| Pool ledger       | JSON             | `app/vault/ledger.json`      |
| Lancia audit log  | JSONL (chained)  | `app/vault/audit.jsonl`      |

All vault files are created automatically on first use. The `app/vault/` directory
is gitignored. No sensitive data ever enters version control.

---

## Deployment

### `main` — Self-Hosted

```bash
git clone https://github.com/5mil/magofonte.git
cd magofonte
npm install
cp .env.example .env        # edit: DGB RPC creds, ports
node core/index.js
# First run: POST /api/v1/ward/setup to create the owner account
```

Requirements: Node.js 20+. Optional: local DGB full node for solo mining.
All modules operate without internet. Pool upstream proxy activates when online.

### `lancia` — Provisioned Instance

Lancia instances are provisioned via `lancia.html` (Launch Studio).
See `docs/LANCIA_GUIDE.md` for the full provisioning flow.
Target providers: Hetzner, Vultr, DigitalOcean, Oracle Cloud.

---

## Design Principles

These are rules, not suggestions. New code that violates them needs a documented exception.

1. **Offline first.** If it breaks without internet, it needs a local fallback or it does not land on `main`.

2. **No mandatory cloud.** No module may require a third-party service to start, authenticate, or process shares. External services are opt-in enhancements.

3. **Module isolation.** Modules communicate via the registry event bus (`registry.emit` / `registry.on`), not via direct imports of each other. `pool` does not import `vault`. `forge` does not import `pool`. This makes each module independently testable and replaceable.

4. **Operator sovereignty.** Private keys, reward addresses, passwords, and auth secrets never leave the operator's machine. No telemetry, no license server, no cloud auth required.

5. **Hot path discipline.** Share validation and block assembly are the latency-critical paths. Auth checks, audit logging, UI updates, and monetization accounting must never block or slow the mining hot path. If it touches a share, it must be synchronous and dependency-free.

6. **Lancia stays separate.** Complexity that exists to serve the managed Lancia product — certs, JWKS, scope maps, tier enforcement, fleet APIs — must not appear on `main`. The self-hosted operator should never be burdened with infrastructure they did not ask for.
