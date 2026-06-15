# ✨ Lancia — One-Click Deploy Guide

The `lancia` branch is a production-ready, API-key-protected build of MagoFonte designed to deploy to any free-tier container host in under five minutes.

---

## What changes vs `main`

| Feature | `main` | `lancia` |
|---|---|---|
| API key auth | ✗ open | ✔ `Authorization: Bearer <key>` |
| Dockerfile | single-stage | multi-stage, non-root user |
| Health check | none | `GET /health` (always public) |
| Free-tier config | — | Render `render.yaml`, Fly `fly.toml` |
| Env-driven config | partial | full (`PORT`, `API_KEY`, `DGB_*`) |

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `API_KEY` | ✔ | Protects all `/api/*` routes. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DGB_REWARD_ADDRESS` | ✔ | Your DGB address — mined rewards go here |
| `DGB_RPC_HOST` | ✔ | IP/hostname of your DGB full node |
| `DGB_RPC_USER` | ✔ | RPC username from `digibyte.conf` |
| `DGB_RPC_PASS` | ✔ | RPC password from `digibyte.conf` |
| `WALLET_PASSPHRASE` | recommended | Encrypts `vault/wallets.enc.json` with AES-256-GCM at rest |
| `PORT` | auto | Set automatically by Render/Railway/Fly. Default `8080` |

---

## Using the API Key

`/health` and `GET /` are always public. Every other `/api/*` request needs the key.

```bash
# Header (recommended)
curl -H "Authorization: Bearer YOUR_KEY" https://your-app.onrender.com/api/v1/pool/status

# Query param (convenient for quick browser testing)
curl "https://your-app.onrender.com/api/v1/pool/status?apiKey=YOUR_KEY"
```

---

## Deploy on Render (free tier)

1. Fork or push this repo to your GitHub account
2. In [Render](https://render.com) → **New › Blueprint**
3. Connect your repo and select the **`lancia`** branch — Render reads `render.yaml` automatically
4. Fill in the secret env vars when prompted (anything marked `sync: false`)
5. Click **Apply** — Render builds the Docker image and deploys
6. Visit `https://your-app.onrender.com/health` to confirm it's live

> **Note:** Render free tier spins down after 15 min of inactivity. Point an uptime pinger (e.g. UptimeRobot) at `/health` to keep it warm.

---

## Deploy on Railway

1. [Railway](https://railway.app) → **New Project › Deploy from GitHub repo**
2. Select your repo — set **branch** to `lancia`
3. Railway auto-detects the `Dockerfile`
4. In **Variables**, add all required env vars from the table above
5. Railway assigns a public URL automatically — done

Railway's Hobby tier gives $5/month credit — enough for a lightweight pool admin server.

---

## Deploy on Fly.io (free tier)

```bash
# 1. Install flyctl
curl -L https://fly.io/install.sh | sh

# 2. Authenticate
fly auth login

# 3. Clone lancia branch
git clone --branch lancia https://github.com/5mil/magofonte.git
cd magofonte

# 4. Create the app (no deploy yet)
fly launch --no-deploy

# 5. Set secrets (never stored in fly.toml)
fly secrets set \
  API_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" )" \
  DGB_REWARD_ADDRESS="YOUR_DGB_ADDRESS" \
  DGB_RPC_HOST="YOUR_NODE_IP" \
  DGB_RPC_USER="dgbrpc" \
  DGB_RPC_PASS="YOUR_RPC_PASS" \
  WALLET_PASSPHRASE="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" )"

# 6. Deploy
fly deploy

# 7. Confirm
fly open /health
```

Fly's free tier includes 3 shared-CPU VMs. `fly.toml` is pre-configured for `shared-cpu-1x` / 256 MB.

---

## Stratum Port (miners)

The Stratum TCP port `3333` is exposed in all configs but **most free HTTP tiers only route HTTP/HTTPS**.

| Platform | Stratum TCP | Notes |
|---|---|---|
| Render free | ✗ | HTTP only |
| Railway free | ✗ | HTTP only |
| Fly.io free | ✔ | Raw TCP services supported |
| VPS (any) | ✔ | Full control |

---

## Local Docker run

```bash
docker build -t magofonte-lancia .

docker run -d \
  -p 8080:8080 \
  -p 3333:3333 \
  -e API_KEY="your-secret-key" \
  -e DGB_REWARD_ADDRESS="your-dgb-address" \
  -e DGB_RPC_HOST="192.168.1.100" \
  -e DGB_RPC_USER="dgbrpc" \
  -e DGB_RPC_PASS="your-rpc-pass" \
  -e WALLET_PASSPHRASE="your-vault-pass" \
  -v magofonte-vault:/app/vault \
  magofonte-lancia
```

Mount `-v magofonte-vault:/app/vault` so wallet data survives container restarts.

---

*Lancia — Italian for launch. This branch is the spell made deployable.*
