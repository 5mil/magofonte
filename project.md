# 🜃 MagoFonte — Trailing Project Log

> **Last updated:** 2026-06-23
> **Branch:** `lancia` (active dev) | **Pages:** `docs/` folder
> **Repo:** [github.com/5mil/magofonte](https://github.com/5mil/magofonte)
> **Pages URL:** [5mil.github.io/magofonte](https://5mil.github.io/magofonte)

---

## 🗂 Module Status

| Module | Path | State | Notes |
|---|---|---|---|
| Pool (Stratum V1) | `pool/` | ✅ Live | DGB, VarDiff, PPLNS, wallet vault |
| Skein512 algo | `pool/skein.js` | ✅ Live | NIST self-test on boot |
| Scrypt algo | `pool/algos/scrypt.js` | ✅ Built | DGB Scrypt, pure-JS |
| Qubit algo | `pool/algos/qubit.js` | ✅ Built | 5-algo chain, native stubs |
| OdoCrypt algo | `pool/algos/odocrypt.js` | ✅ Built | Seed from nTime, 8-round SPN |
| SHA256d algo | `pool/algos/sha256d.js` | ✅ Built | Double SHA256 |
| Algo registry | `pool/algos/index.js` | ✅ Built | resolve() + list() |
| Monetization | `monetization/` | ✅ Live | LP + pool collectors, sweeper |
| Vault (signing) | `vault/` | ✅ Built | mock/keystore/remote backends |
| Forge (premium) | `forge/index.js` | ✅ Built | Feature gates, access tokens |
| Bridge (swaps) | `bridge/index.js` | ✅ Built | DGB↔SOL, LTC↔SOL routes |
| Stream (API billing) | `stream/index.js` | ✅ Built | 3 tiers, usage metering |
| Mesh (compute) | `mesh/index.js` | ✅ Built | Task queue, worker rewards |
| Lancia API backend | `lancia/api.js` | ✅ Built | mock + Fly.io backends |
| Sigil (admin UI) | `sigil/` | ✅ Live | Treasury panel, ledger view |
| Ward (auth/roles) | `ward/` | ✅ Live | owner/user role gates |
| GitHub Pages | `docs/` | ✅ Live | index, lancia, dashboard |

---

## 💰 Treasury

| Network | Address | Sweep Threshold |
|---|---|---|
| Solana | `Fz8zVrdkXS3kDZzjkpogB9KmR9DHaJPUPGbjrqm8824J` | 0.01 SOL |
| DigiByte | `DLbr1DaJs8bAU7BJfW92rLheVZHzDmR5KJ` | 1 DGB |
| Litecoin | `LcqqWQscuYtGVsRwbarnqVu7Y9tF3XXqjG` | — (future) |

---

## 🗃 Supabase Tables

| Table | RLS | Access |
|---|---|---|
| `bench_pools` | ✅ | owner |
| `bench_workers` | ✅ | owner |
| `bench_assignments` | ✅ | owner |
| `bench_log` | ✅ | owner |
| `token_config` | ✅ | auth read / service write |
| `liquidity_snapshots` | ✅ | auth read / service write |
| `trading_snapshots` | ✅ | auth read / service write |
| `holder_snapshots` | ✅ | auth read / service write |
| `social_snapshots` | ✅ | auth read / service write |
| `health_scores` | ✅ | auth read / service write |
| `trending_events` | ✅ | auth read / service write |
| `decisions_log` | ✅ | service only |
| `content_queue` | ✅ | service only |
| `alerts_log` | ✅ | service only |
| `lp_positions` | ✅ | service only |
| `revenue_ledger` | ✅ | service only |
| `treasury_config` | ✅ | service only |

---

## 📋 Commit Log

| Date | Commit | What |
|---|---|---|
| 2026-06-16 | [`f8ef729`](https://github.com/5mil/magofonte/commit/f8ef72944d1609a0563f72056db33037bac27eee) | monetization module — LP collector, sweeper, ledger, treasury |
| 2026-06-16 | Supabase | revenue_ledger + treasury_config tables, RLS, Solana treasury seeded |
| 2026-06-16 | Supabase | RLS enabled on all 11 token/DeFi tables |
| 2026-06-16 | [`63010c3`](https://github.com/5mil/magofonte/commit/63010c303aafd6825d0f1902b2990e737e2965f0) | pool fee collector — block:found + bonus:paid events |
| 2026-06-16 | lancia env | DGB treasury address set: DLbr1DaJs8bAU7BJfW92rLheVZHzDmR5KJ |
| 2026-06-16 | lancia env | LTC treasury address set: LcqqWQscuYtGVsRwbarnqVu7Y9tF3XXqjG |
| 2026-06-16 | [`036814f`](https://github.com/5mil/magofonte/commit/036814f909ac1d9135c522e0c53e7420c527d08a) | sigil treasury panel + revenue ledger UI |
| 2026-06-16 | lancia | lancia.html AIO launch studio + mysterious rune button |
| 2026-06-16 | lancia | Doré hero image applied to lancia.html |
| 2026-06-16 | [`d88f010`](https://github.com/5mil/magofonte/commit/d88f01014acda91f76fcf70370420cfd6a7bcfc2) | dashboard.html — 7 panels, WS share feed; portal link fixed |
| 2026-06-16 | [`0ea140c`](https://github.com/5mil/magofonte/commit/0ea140c17e9ce8254033bda330205fce0dc695f0) | index.html — Doré hero, wallet panel removed |
| 2026-06-16 | [`e0a13ba`](https://github.com/5mil/magofonte/commit/e0a13ba9a33feaa13aa458940c16af8f73995a87) | Lancia pill link below GitHub pill, rune button removed |
| 2026-06-16 | [`4d84242`](https://github.com/5mil/magofonte/commit/4d84242b8c37276e813d776c2bd3ad18b2c1bbdd) | all pages moved to docs/ (correct GitHub Pages source) |
| 2026-06-16 | [`c16575b`](https://github.com/5mil/magofonte/commit/c16575b7cb5aa5cc7393551357f1293b403f0f38) | image refs updated to wizards.jpg |
| 2026-06-19 | — | Review session: status audit, trailing log initiated |
| 2026-06-23 | this commit | algos (scrypt/qubit/odocrypt/sha256d), vault, forge, bridge, stream, mesh, lancia API |

---

## ⚠️ Open Items

| Priority | Item | Detail |
|---|---|---|
| 🔴 HIGH | `SUPABASE_SERVICE_KEY` | Add to live deployment env vars |
| 🔴 HIGH | First real block submission | Pool is ready — needs live DGB node + miner connection |
| 🟡 MED | Live LP position | Add row to `lp_positions` with real Meteora/Raydium pubkey |
| 🟡 MED | `wizards.jpg` render | Confirm hero image loading on GitHub Pages after redeploy |
| 🟡 MED | Lancia pill link visible | Confirm pill renders after Pages cache clears |
| 🟢 LOW | Qubit native bindings | Stub functions work for share validation; swap for native C++ bindings if needed |
| 🟢 LOW | forge_access migration | Supabase migration for `forge_access` table not yet applied |
| 🟢 LOW | stream_subscriptions migration | Supabase migration for `stream_subscriptions` table not yet applied |
| 🟢 LOW | Docker Lancia backend | `lancia/backends/docker.js` not yet built |
| 🟢 LOW | vault/backends/ledger.js | Ledger hardware wallet backend stub not yet built |

---

## 🔜 Next Queue

- [ ] Apply `forge_access` + `stream_subscriptions` Supabase migrations
- [ ] Wire `lancia/api.js` into `core/index.js` — mount routes
- [ ] Wire `forge`, `bridge`, `stream`, `mesh` into `core/index.js`
- [ ] Wire `vault` into `monetization/sweeper.js` for real signing
- [ ] Test pool with a live DGB node (first real block)
- [ ] Dashboard live data (connect WS + API endpoints to real pool)
- [ ] Lancia Docker backend
- [ ] Ledger hardware wallet vault backend

---

## 🎨 Design System

```
Font:       Cinzel / Cinzel Decorative
Bg:         #0d0b0e  (--ink)
Gold:       #c9a84c  (--gold)
Gold2:      #e8d08a  (--gold-light)
Surface:    #100e18  (--surface)
Surface2:   #17142a  (--surface2)
Green:      #5ecf7a  running/ok
Red:        #e05050  stopped/error
Cyan:       #4ecfcf  region/info
Border:     rgba(201,168,76,0.2)
```

---

## 🔐 Private Notes Area

> Keep this section out of commits — fill in locally only.

```
─────────────────────────────────────────────
SUPABASE
  URL              :
  anon key         :
  service_role key :
─────────────────────────────────────────────
TREASURY ENV VARS
  TREASURY_WALLET_ADDRESS  : Fz8zVrdkXS3kDZzjkpogB9KmR9DHaJPUPGbjrqm8824J
  TREASURY_DGB_ADDRESS     : DLbr1DaJs8bAU7BJfW92rLheVZHzDmR5KJ
  TREASURY_LTC_ADDRESS     : LcqqWQscuYtGVsRwbarnqVu7Y9tF3XXqjG
  HELIUS_API_KEY           :
─────────────────────────────────────────────
VAULT
  VAULT_BACKEND            : mock (dev) / keystore (prod)
  VAULT_KEYSTORE_PATH      :
  VAULT_KEYSTORE_PASS      :
─────────────────────────────────────────────
LANCIA / FLY.IO
  FLY_API_TOKEN   :
  FLY_APP_NAME    : magofonte
  LANCIA_BACKEND  : fly
─────────────────────────────────────────────
GITHUB
  User : 5mil
  Repo : magofonte
  PAT  :
─────────────────────────────────────────────
FREE NOTES


─────────────────────────────────────────────
```
