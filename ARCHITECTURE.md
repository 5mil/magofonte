# MagoFonte — Architecture

## Design Principles

1. **Home server first.** Runs on a single machine. No cloud dependency.
2. **Core is a process supervisor.** Every module is a managed process — including the coin node itself.
3. **Coin registry drives everything.** Drop a coin definition in `coins/` and the pool self-assembles.
4. **One-button launch.** Console UI: paste codebase → press Start → mining.
5. **Modular but integrated.** Modules share a message bus. DGB node is a module. Pool is a module. They talk.

---

## Module Map

```
magofonte/
├── core/               Process supervisor + module registry + HTTP API + event bus
├── console/            Terminal UI (control plane) — start/stop/monitor everything
├── coins/              Coin definitions (DGB, XMR, etc.) — add one to enable mining
│   └── dgb.json
├── pool/               Stratum pool server — auto-configured from coin definition
├── node/               Coin node process manager — downloads, configures, runs the daemon
├── forge/              Worker dispatch (GHA, Wandbox, local CPU)
├── bridge/             HTTP↔stratum adapter for sandboxed workers
├── stream/             WebSocket telemetry — live hashrate, shares, blocks
├── vault/              Wallet + address management
├── sigil/              Web dashboard (connects to stream)
└── ward/               Auth + access control
```

---

## Process Model

```
 magofonte (Node.js master process)
 ├─ core          ← module loader, HTTP :8080, event bus
 ├─ node:dgb      ← child_process.spawn(digibyted) ─ managed by node module
 ├─ pool:dgb      ← stratum :3333, job engine, share validator
 ├─ forge         ← worker dispatch engine
 ├─ stream        ← WebSocket :8081
 └─ console       ← terminal UI (ink/blessed or raw readline)
```

The `node` module supervises the coin daemon as a child process:
- Spawns `digibyted` (or any coin daemon)
- Watches stdout/stderr for sync progress
- Exposes start/stop/restart/status via event bus
- Emits `node:ready` when RPC is available — pool waits for this before starting

---

## Coin Definition Format (`coins/*.json`)

Each coin is a single JSON file. Drop it in `coins/` and the system knows how to:
- Download and verify the daemon binary
- Generate the correct config file
- Start the node
- Configure the pool stratum + job engine

```json
{
  "id":       "dgb",
  "name":     "DigiByte",
  "ticker":   "DGB",
  "algo":     "skein",
  "algos":    ["sha256d", "scrypt", "skein", "groestl", "qubit"],
  "daemon": {
    "binary":   "digibyted",
    "configFile": "~/.digibyte/digibyte.conf",
    "rpcPort":  14022,
    "p2pPort":  12024,
    "rpcConfig": {
      "server":     1,
      "daemon":     0,
      "txindex":    1,
      "rpcallowip": "127.0.0.1"
    }
  },
  "stratum": {
    "defaultDiff": 0.01,
    "varDiff": true,
    "blockTime":   15
  },
  "explorer": "https://digiexplorer.info"
}
```

---

## Auto-Pool from Codebase (The "Paste → Mine" Flow)

The console has a **Coins** panel with a text area.
You paste any valid `coins/*.json` definition (or the path to one) and press **Start**.
The system:

1. Validates the coin definition schema
2. Writes the coin daemon config file
3. `node` module spawns the daemon, monitors sync
4. When `node:ready` fires — pool auto-configures from the coin def
5. Pool stratum server starts, job engine begins polling
6. Console shows: node sync %, connected peers, pool hashrate, shares, blocks found

One button. No manual config editing.

---

## Event Bus

All modules communicate via the core registry event bus.
No module imports another module directly.

| Event | Emitter | Consumers |
|---|---|---|
| `node:ready` | node module | pool (start job engine) |
| `node:syncing` | node module | console (show sync %) |
| `node:stopped` | node module | pool (pause job engine) |
| `pool:job` | pool | stream, console |
| `share:accepted` | pool | stream, payout, console |
| `block:found` | pool | stream, payout, console, vault |
| `miner:authorized` | pool | stream, console |
| `miner:disconnected` | pool | stream, console |

---

## Home Server Deployment

```bash
git clone https://github.com/5mil/magofonte
cd magofonte
npm install
cp .env.example .env
# edit .env — set wallet address
npm start
```

The console opens in the terminal.
Press `c` to open Coins panel, paste DGB definition, press Start.
DGB node syncs, pool comes online, workers connect to `:3333`.

---

## TODOs (ordered)

- [x] core: module loader, HTTP, event bus
- [x] pool: stratum server, job engine, share validator, VarDiff, PPLNS payout
- [ ] **node: coin daemon process manager** ← next
- [ ] **console: terminal UI control plane** ← next
- [ ] coins/dgb.json: complete DGB definition
- [ ] pool: real base58check address decode for coinbase payout script
- [ ] pool: Skein-512 header hashing (node native addon or WASM)
- [ ] forge: worker dispatch (GHA + local CPU miners)
- [ ] bridge: HTTP↔stratum for sandboxed workers
- [ ] stream: WebSocket telemetry
- [ ] vault: wallet management
- [ ] sigil: web dashboard
