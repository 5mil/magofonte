# 🌃 MagoFonte — Trailing Project Log

> **Last updated:** 2026-06-23 16:00 EDT
> **Branch:** `lancia` (active dev) | **Pages:** `docs/` folder
> **Repo:** [github.com/5mil/magofonte](https://github.com/5mil/magofonte)
> **Pages URL:** [5mil.github.io/magofonte](https://5mil.github.io/magofonte)
> **Live API:** [magofonte.fly.dev](https://magofonte.fly.dev)

---

## 🗂 Module Status

| Module | Path | State | Notes |
|---|---|---|---|
| Pool (Stratum V1) | `pool/` | ✅ Live | DGB, VarDiff, PPLNS, wallet vault |
| Skein512 algo | `pool/skein.js` | ✅ Live | NIST self-test on boot |
| Scrypt algo | `pool/algos/scrypt.js` | ✅ Wired | Pure-JS Salsa20/8 · N=1024 r=1 p=1 |
| Qubit algo | `pool/algos/qubit.js` | ✅ Wired | 5-algo chain · native stubs |
| OdoCrypt algo | `pool/algos/odocrypt.js` | ✅ Wired | Seed from nTime · 8-round SPN |
| SHA256d algo | `pool/algos/sha256d.js` | ✅ Wired | Double SHA256 |
| Algo registry | `pool/algos/index.js` | ✅ Wired | resolve() + list() + resolveFromHeader() |
| Monetization | `monetization/` | ✅ Live | LP + pool collectors, sweeper |
| Sweeper → Vault | `monetization/sweeper.js` | ✅ Wired | setVault() · real signing path |
| Sources endpoint | `monetization/index.js` | ✅ Live | forge/bridge/stream/mesh shown live |
| Vault (signing) | `vault/` | ✅ Live | mock/keystore/remote · ESM |
| Forge (premium) | `forge/index.js` | ✅ Live | Feature gates · forge_access table |
| Bridge (swaps) | `bridge/index.js` | ✅ Live | DGB↔SOL · LTC↔SOL |
| Stream (API billing) | `stream/index.js` | ✅ Live | 3 tiers · usage metering |
| Mesh (compute) | `mesh/index.js` | ✅ Live | Task queue · worker rewards |
| Lancia API backend | `lancia/index.js` | ✅ Live | mock + Fly.io backends · ESM |
| Lancia UI | `docs/lancia.html` | ✅ Live | Configurable API base · Fly regions fixed |
| fly.toml | `fly.toml` | ✅ Updated | All env stubs + secrets comments |
| Sigil (admin UI) | `sigil/` | ✅ Live | Treasury panel, ledger view |
| Ward (auth/roles) | `ward/` | ✅ Live | owner/user role gates |
| GitHub Pages | `docs/` | ✅ Live | index, lancia, dashboard |

---

## 💰 Treasury

| Network | Address | Sweep Threshold | Vault Status |
|---|---|---|---|
| Solana | `Fz8zVrdkXS3kDZzjkpogB9KmR9DHaJPUPGbjrqm8824J` | 0.01 SOL | mock (dev) |
| DigiByte | `DLbr1DaJs8bAU7BJfW92rLheVZHzDmR5KJ` | 1 DGB | mock (dev) |
| Litecoin | `LcqqWQscuYtGVsRwbarnqVu7Y9tF3XXqjG` | — (future) | — |

> To go live: `fly secrets set VAULT_BACKEND=keystore VAULT_KEYSTORE_PATH=/app/secrets/keystore.json VAULT_KEYSTORE_PASS=...`
> Mount the secrets volume in fly.toml (uncomment `[mounts]` block).

---

## 🗃 Supabase Tables

| Table | RLS | Access | Status |
|---|---|---|---|
| `bench_pools` | ✅ | owner | live |
| `bench_workers` | ✅ | owner | live |
| `bench_assignments` | ✅ | owner | live |
| `bench_log` | ✅ | owner | live |
| `token_config` | ✅ | auth read / service write | live |
| `liquidity_snapshots` | ✅ | auth read / service write | live |
| `trading_snapshots` | ✅ | auth read / service write | live |
| `holder_snapshots` | ✅ | auth read / service write | live |
| `social_snapshots` | ✅ | auth read / service write | live |
| `health_scores` | ✅ | auth read / service write | live |
| `trending_events` | ✅ | auth read / service write | live |
| `decisions_log` | ✅ | service only | live |
| `content_queue` | ✅ | service only | live |
| `alerts_log` | ✅ | service only | live |
| `lp_positions` | ✅ | service only | live |
| `revenue_ledger` | ✅ | service only | live |
| `treasury_config` | ✅ | service only | live |
| `forge_access` | ✅ | service + user read own | **apply migration** |
| `stream_subscriptions` | ✅ | service + user read own | **apply migration** |

> Migration SQL: [`docs/migrations/forge_access_stream_subscriptions.sql`](https://github.com/5mil/magofonte/blob/lancia/docs/migrations/forge_access_stream_subscriptions.sql)

---

## 📋 Commit Log

| Date | Commit | What |
|---|---|---|
| 2026-06-16 | [`f8ef729`](https://github.com/5mil/magofonte/commit/f8ef72944d1609a0563f72056db33037bac27eee) | monetization — LP collector, sweeper, ledger, treasury |
| 2026-06-16 | Supabase | revenue_ledger + treasury_config, RLS on all 11 tables |
| 2026-06-16 | [`63010c3`](https://github.com/5mil/magofonte/commit/63010c303aafd6825d0f1902b2990e737e2965f0) | pool fee collector — block:found + bonus:paid events |
| 2026-06-16 | lancia env | Treasury addresses set (SOL/DGB/LTC) |
| 2026-06-16 | [`036814f`](https://github.com/5mil/magofonte/commit/036814f909ac1d9135c522e0c53e7420c527d08a) | sigil treasury panel + revenue ledger UI |
| 2026-06-16 | [`d88f010`](https://github.com/5mil/magofonte/commit/d88f01014acda91f76fcf70370420cfd6a7bcfc2) | dashboard.html — 7 panels, WS share feed |
| 2026-06-16 | [`4d84242`](https://github.com/5mil/magofonte/commit/4d84242b8c37276e813d776c2bd3ad18b2c1bbdd) | all pages moved to docs/ |
| 2026-06-23 | [`d27a9cd`](https://github.com/5mil/magofonte/commit/d27a9cdcf63ac035af3fe7f325aef68889699913) | algos (scrypt/qubit/odocrypt/sha256d), vault, forge, bridge, stream, mesh, lancia API |
| 2026-06-23 | [`c23b794`](https://github.com/5mil/magofonte/commit/c23b79412dbf26a43dd6645e59969fe5ac8f08b8) | ESM adapters, config enabled, migration SQL |
| 2026-06-23 | this commit | sweeper→vault, lancia.html API base + regions, fly.toml, algo registry, project.md |

---

## ⚠️ Open Items

| Priority | Item | Detail |
|---|---|---|
| 🔴 HIGH | Apply Supabase migration | `docs/migrations/forge_access_stream_subscriptions.sql` |
| 🔴 HIGH | Fly secrets: treasury + vault | `fly secrets set TREASURY_WALLET_ADDRESS=... VAULT_BACKEND=keystore ...` |
| 🔴 HIGH | First real block | Pool is ready — needs live DGB node + miner connection |
| 🟡 MED | Vault → keystore in prod | Mount `/app/secrets` volume in fly.toml, drop keystore.json there |
| 🟡 MED | Solana tx broadcast | `sweeper.sweep()` signs but doesn't broadcast yet — wire Helius `sendTransaction` |
| 🟡 MED | Live LP position | Add row to `lp_positions` with real Meteora/Raydium pubkey |
| 🟡 MED | ward enable | `ward: { enabled: true }` once ward/index.js ESM adapter confirmed |
| 🟢 LOW | Qubit native bindings | Stubs work for share validation; swap for native C++ bindings if needed |
| 🟢 LOW | Docker Lancia backend | `lancia/backends/docker.js` not yet built |
| 🟢 LOW | vault/backends/ledger.js | Ledger HW wallet backend stub not yet built |
| 🟢 LOW | Dashboard live data | Connect WS + API endpoints to real pool stats |

---

## 🔜 Next Queue

- [ ] `fly secrets set` — treasury + Supabase + vault vars (see fly.toml comments)
- [ ] Apply Supabase migration (forge_access + stream_subscriptions)
- [ ] Wire Helius `sendTransaction` into sweeper.js broadcast path
- [ ] Connect DGB node + first live miner → first block
- [ ] Enable `ward` module in config once ESM adapter confirmed
- [ ] Dashboard live data panel
- [ ] Lancia Docker backend

---

## 🎨 Design System

```
Font:    Cinzel / Cinzel Decorative
Bg:      #0d0b0e  (--ink)
Gold:    #c9a84c  (--gold)   #e8d08a (--gold-light)
Surface: #100e18  (--surface)  #17142a (--surface2)
Green:   #5ecf7a  running/ok
Red:     #e05050  stopped/error
Cyan:    #4ecfcf  region/info
Border:  rgba(201,168,76,0.2)
```

---

## 🔐 Private Notes Area

> Keep this section out of commits — fill in locally only.

```
─────────────────────────────────────────────────
SUPABASE
  URL              :
  anon key         :
  service_role key :
─────────────────────────────────────────────────
TREASURY ENV VARS
  TREASURY_WALLET_ADDRESS  : Fz8zVrdkXS3kDZzjkpogB9KmR9DHaJPUPGbjrqm8824J
  TREASURY_DGB_ADDRESS     : DLbr1DaJs8bAU7BJfW92rLheVZHzDmR5KJ
  TREASURY_LTC_ADDRESS     : LcqqWQscuYtGVsRwbarnqVu7Y9tF3XXqjG
  HELIUS_API_KEY           :
─────────────────────────────────────────────────
VAULT
  VAULT_BACKEND            : mock (dev) / keystore (prod)
  VAULT_KEYSTORE_PATH      : /app/secrets/keystore.json
  VAULT_KEYSTORE_PASS      :
─────────────────────────────────────────────────
LANCIA / FLY.IO
  FLY_API_TOKEN   :
  FLY_APP_NAME    : magofonte
  LANCIA_BACKEND  : fly
─────────────────────────────────────────────────
GITHUB
  User : 5mil
  Repo : magofonte
  PAT  :
─────────────────────────────────────────────────
FREE NOTES


─────────────────────────────────────────────────
```
