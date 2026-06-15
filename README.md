# MagoFonte

> *Italian: Mago (Wizard) · Fonte (Source)*

Offline-first, modular platform for local AI, wallet management, and distributed node operation. Built for those who own their intelligence stack.

## Modules

| Module | Status | Role |
|--------|--------|------|
| `core` | ✅ | Module host, HTTP server, plugin registry |
| `pool` | ✅ | Stratum server + upstream proxy + pool API |
| `bridge` | 🔜 | HTTP↔stratum adapter for Tier-1 workers |
| `forge` | 🔜 | Worker dispatch engine |
| `stream` | 🔜 | WebSocket real-time telemetry |
| `vault` | 🔜 | Wallet + credential storage |
| `mesh` | 🔜 | Peer discovery, node registry |
| `ward` | 🔜 | Auth, RLS, access control |
| `sigil` | 🔜 | UI dashboard |

## Quick Start

```bash
cp .env.example .env
# edit .env — set STRATUM_USER to your wallet address
npm start
```

## API

```
GET  /health                    — module status + uptime
GET  /api/v1/pool/status        — miners, upstreams, total hashrate
GET  /api/v1/pool/miners        — connected miner sessions
GET  /api/v1/pool/upstreams     — upstream pool list
POST /api/v1/pool/upstreams     — add upstream { id, name, url }
DEL  /api/v1/pool/upstreams/:id — remove upstream
```

## Deploy (Fly.io)

```bash
fly launch --name magofonte --no-deploy
fly secrets set STRATUM_USER=your.wallet.address
fly deploy
```

Stratum port `3333` is exposed as raw TCP — point miners at `magofonte.fly.dev:3333`.

## Architecture

```
Miner (GHA/Wandbox/local)
  │  stratum+tcp:3333
  ▼
[ pool module ] ←→ upstream pool (Mining-Dutch etc.)
  │  hook: share, job, miner:authorized
  ▼
[ stream module ] → WebSocket → sigil dashboard
```

License: Apache 2.0
