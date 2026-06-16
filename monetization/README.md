# monetization module

Collects revenue from all registered sources and sweeps normalized amounts to the owner-controlled treasury wallet.

## Architecture

```
Revenue Sources
  └─ lp-collector.js   reads lp_positions → claims LP fees (Meteora/Raydium)
  └─ [pool_fees]       future: pool fee deduction from mining rewards
  └─ [forge]           future: premium feature access fees
  └─ [bridge]          future: cross-chain swap fees
  └─ [sigil]           future: affiliate / referral rewards
  └─ [mesh]            future: compute task rewards
        │
        ▼
  sweeper.js           normalizes events, auto-sweeps on threshold
        │
        ▼
  ledger.js            writes every event to Supabase revenue_ledger
        │
        ▼
  treasury.js          owner treasury wallet (Solana / DGB / LTC)
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TREASURY_WALLET_ADDRESS` | ✔ | Owner Solana treasury address |
| `TREASURY_DGB_ADDRESS` | recommended | Owner DGB treasury address (falls back to DGB_REWARD_ADDRESS) |
| `TREASURY_LTC_ADDRESS` | optional | Owner LTC treasury address |
| `SUPABASE_URL` | ✔ | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | ✔ | Service role key (bypasses RLS) |
| `SOLANA_RPC_URL` | optional | Solana RPC endpoint (defaults to public mainnet) |
| `HELIUS_API_KEY` | optional | Helius free-tier API key for better RPC reliability |

## Config (magofonte.config.json)

```json
"monetization": {
  "enabled": true,
  "collectIntervalMinutes": 30,
  "sweepIntervalHours": 6,
  "sweepThresholdSol": 0.01,
  "minClaimThreshold": 1000
}
```

## API Routes (owner-only)

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/monetization/status` | Treasury balance + pending sweeps |
| GET | `/api/v1/monetization/ledger` | Paginated revenue event log |
| POST | `/api/v1/monetization/sweep` | Trigger manual sweep |
| GET | `/api/v1/monetization/sources` | All revenue sources + their state |

## Free Resource Entries

| Source | Free Resource | Notes |
|---|---|---|
| LP fees | Solana public RPC, Helius free tier | On-chain position reads |
| Supabase DB | Free tier (500 MB) | lp_positions, revenue_ledger |
| Collection loop | Oracle A1 always-free | Runs inside MagoFonte server process |
| Scheduled sweep | Supabase cron (pg_cron) | Optional: can run DB-side sweep checks |
