# ⚗ MagoFonte

> *From the Italian: **Mago** (Wizard) · **Fonte** (Source)*
>
> *"He is gone who seemed so great..."*
> *— Tennyson, Idylls of the King*

---

MagoFonte is a **home server mining platform** — modular, self-hosted, and built from first principles. No cloud. No middlemen. You run the coin node. You run the pool. You keep the coins.

It began as a single stratum relay. Then a party-mine pool. Then a coin node supervisor. Then a full control plane with a terminal UI, a web dashboard, authentication, and a monetization registry. Each session a new layer materialised — not planned, but *summoned*.

This is that thing.

---

## ✦ What It Does

```
┌─────────────────────────────────────────────────────────┐
│                    MagoFonte                            │
│                                                         │
│  ┌──────────┐    ┌──────────┐    ┌──────────────────┐  │
│  │  node    │───▶│  pool    │───▶│  sigil (web UI)  │  │
│  │  module  │    │  module  │    │  + ward (auth)   │  │
│  │          │    │          │    └──────────────────┘  │
│  │ spawns   │    │ stratum  │                           │
│  │ digibyted│    │ :3333    │    ┌──────────────────┐  │
│  │ monitors │    │ PPLNS    │    │  console (TUI)   │  │
│  │ syncs    │    │ VarDiff  │    │  m)onetize panel │  │
│  └──────────┘    │ JobEngine│    └──────────────────┘  │
│       │          └──────────┘                           │
│       │ node:ready fires                                │
│       └───────────▶ pool auto-configures                │
│                     stratum opens                       │
│                     workers connect                     │
└─────────────────────────────────────────────────────────┘
```

You paste a coin definition JSON. Press Start. The node syncs, the pool comes online, workers connect at `:3333`, and shares start arriving. When your cluster finds a block, the coins go directly to your address.

---

## ⚙ Module Map

| Module | Status | Role |
|--------|--------|------|
| `core` | ✅ | Process supervisor, HTTP :8080, event bus |
| `node` | ✅ | Coin daemon manager — spawns, monitors, signals |
| `pool` | ✅ | Full stratum pool — JobEngine, VarDiff, PPLNS payout |
| `console` | ✅ | Terminal control plane — TUI with monetization panel |
| `ward` | ✅ | JWT auth, role system (owner / admin / operator / member) |
| `sigil` | ✅ | HTML web dashboard — login, full panel, live polling |
| `coins` | ✅ | Coin definitions — DGB included, drop in more |
| `bridge` | 🔜 | HTTP↔stratum adapter for sandboxed workers |
| `forge` | 🔜 | Worker dispatch (GHA, Wandbox, local CPU) |
| `stream` | 🔜 | WebSocket real-time telemetry |
| `vault` | 🔜 | Wallet + credential storage |
| `mesh` | 🔜 | Peer discovery across home network |

---

## 🔐 Authentication & Roles

First run: navigate to the dashboard, enter a username and password — you become **owner**. All subsequent accounts start as **member**.

| Role | Capabilities |
|------|-------------|
| `member` | View status, miners, payout, logs |
| `operator` | Member + force new jobs, view pool settings |
| `admin` | Operator + manage pool, toggle monetization, launch coins, manage users |
| `owner` | Admin + assign any role, delete accounts, full system control |

---

## ⚡ Monetization Registry

Each running node unlocks revenue streams based on what the coin supports:

| Type | Coins | What It Earns |
|------|-------|---------------|
| ⛏ PoW Mining | Any PoW | Block rewards via your stratum pool |
| ⚡ Lightning Routing | BTC, LTC, DGB | Payment forwarding fees |
| 🔌 Public RPC Endpoint | Any node | Per-call API fees from dApps |
| 🥩 PoS Staking | PoS chains | Validator rewards + commission |
| 💧 Channel Leasing | BTC, LTC | Sell inbound liquidity (Amboss / Pool) |
| 🖥 Masternode | Dash, PIVX | Block reward share |
| ⛓ Merge Mining | DGB (Scrypt) | Mine Litecoin simultaneously |
| 🔍 Mempool Services | Any node | Explorer / API monetization |

Toggle any type from the web dashboard or press `m` in the terminal console.

---

## 🪙 Current Target: DigiByte (DGB)

First cluster mine is DigiByte on the **Skein** algorithm — chosen because:

- ASIC-resistant, multi-algo chain (5 algorithms)
- 15-second block time means rapid feedback
- Low difficulty on Skein right now — good luck odds for a small cluster
- Stratum is standard, node is stock Bitcoin-derived

```
Stratum: :3333 (Skein)
Payout:  PPLNS, window = 100 shares
Mode:    party mine — all workers, one pool, coins to owner address
```

---

## 🚀 Quick Start (home server)

```bash
git clone https://github.com/5mil/magofonte
cd magofonte
npm install
cp .env.example .env
npm start
```

Open `http://localhost:8080` — first login creates the owner account.

Then press `c` in the terminal (or go to **Launch Coin** in the dashboard):
- Paste `coins/dgb.json`
- Enter RPC credentials
- Press Launch
- Watch the node sync, pool come online, workers connect

---

## 🗂 Repository Structure

```
magofonte/
├── core/           Process supervisor + HTTP API + event bus
├── node/           Coin daemon manager (spawn, monitor, RPC)
├── pool/
│   ├── index.js    Stratum server, JobEngine, ShareValidator, PPLNS
│   └── settings.js Settings manager + monetization registry
├── console/        Terminal UI (TUI) — keyboard-driven control plane
├── ward/           Auth — JWT, scrypt passwords, role system
├── sigil/          Web dashboard (HTML/CSS/JS, zero dependencies)
├── coins/
│   └── dgb.json    DigiByte coin definition
├── bridge/         (coming) HTTP↔stratum for sandboxed workers
├── forge/          (coming) Worker dispatch engine
├── stream/         (coming) WebSocket telemetry
└── vault/          (coming) Wallet management
```

---

## 📡 REST API

```
# Pool
GET  /api/v1/pool/status
GET  /api/v1/pool/miners
GET  /api/v1/pool/payout
GET  /api/v1/pool/job
POST /api/v1/pool/job/new
GET  /api/v1/pool/settings/pools
PATCH /api/v1/pool/settings/pools/:id
POST /api/v1/pool/settings/pools/:id/monetization/:type

# Node
GET  /api/v1/node/status
POST /api/v1/node/start    { coin, rpcuser, rpcpass }
POST /api/v1/node/stop     { coin }
POST /api/v1/node/register { coinJson, rpcuser, rpcpass }
GET  /api/v1/node/logs/:coin

# Auth
POST /api/v1/ward/setup    { username, password }  ← first run only
POST /api/v1/ward/login    { username, password }
GET  /api/v1/ward/me
GET  /api/v1/ward/users              (admin+)
POST /api/v1/ward/users              (admin+)
PATCH /api/v1/ward/users/:id/role   (admin+)
DELETE /api/v1/ward/users/:id       (owner)
```

---

## 🔮 The Road Ahead

```
now   ──▶  base58check → real coinbase payout address
      ──▶  Skein-512 header hash (native addon / WASM)
      ──▶  first real DGB block submitted

next  ──▶  forge: dispatch GHA + local CPU workers
      ──▶  bridge: HTTP↔stratum for sandboxed miners
      ──▶  stream: WebSocket live telemetry → sigil
      ──▶  vault: wallet address management
      ──▶  multi-coin: drop in XMR, LTC, RVN definitions
      ──▶  mesh: peer discovery across LAN nodes
```

---

*"The old order changeth, yielding place to new..."*

License: Apache 2.0
