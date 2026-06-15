# pool module

Full internal stratum pool for DigiByte (DGB) party mining.
No upstream relay — talks directly to a DGB full node via JSON-RPC.

## Architecture

```
DigiByte full node (RPC :14022)
        │
        ▼
   JobEngine          ← polls getblocktemplate every 500ms
        │ mining.notify
        ▼
  MinerSessions[]     ← one per connected worker (TCP :3333)
        │ mining.submit
        ▼
  ShareValidator      ← validates hash, submits block if found
        │ share event
        ▼
  PayoutTracker       ← PPLNS window, earnings per user
```

## Sub-systems

| Class | File | Role |
|---|---|---|
| `NodeRPC` | pool/index.js | JSON-RPC wrapper for DGB node |
| `JobEngine` | pool/index.js | getblocktemplate → stratum job |
| `ShareValidator` | pool/index.js | Hash check + submitblock |
| `VarDiff` | pool/index.js | Per-miner difficulty adjustment |
| `PayoutTracker` | pool/index.js | PPLNS share accounting |
| `MinerSession` | pool/index.js | Per-worker stratum session |

## REST API

```
GET  /api/v1/pool/status     — full status (miners, hashrate, blocks found)
GET  /api/v1/pool/miners     — connected worker list
GET  /api/v1/pool/payout     — PPLNS stats + earnings
GET  /api/v1/pool/job        — current job (height, target, bits)
GET  /api/v1/pool/node       — DGB node network + mining info
POST /api/v1/pool/job/new    — force new job broadcast
```

## Config

Set in `magofonte.config.json`:

```json
"pool": {
  "coin": "DGB",
  "mode": "party",
  "algo": "skein",
  "blockRewardAddress": "YOUR_DGB_ADDRESS_HERE",
  "node": {
    "host": "127.0.0.1",
    "port": 14022,
    "rpcuser": "dgbrpc",
    "rpcpass": "CHANGE_ME"
  }
}
```

## DGB Node Setup

```bash
docker run -d \
  --network host \
  --restart always \
  --name dgb \
  -v /data/dgb:/root/.digibyte \
  ruimarinho/digibyte
```

`~/.digibyte/digibyte.conf`:
```
rpcuser=dgbrpc
rpcpassword=CHANGE_ME
rpcallowip=127.0.0.1
server=1
daemon=1
txindex=1
```

## What's TODO before first block

- [ ] Replace `_addressToScript()` stub with real base58check → P2PKH script
- [ ] Implement actual Skein/Groestl header hashing (node addon or WASM)
- [ ] Persist payout earnings to Supabase via vault module
- [ ] Wire to stream module for live WebSocket telemetry
