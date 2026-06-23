# lancia/

Server-side API backend for the Lancia instance fleet manager.

## Mount in your Express app

```js
const lanciaApi = require('./lancia/api');
app.use('/api/v1/lancia', lanciaApi);
```

## Backends

Set `LANCIA_BACKEND` env var:

| Value | Description |
|---|---|
| `mock` (default) | In-memory, no real machines |
| `fly` | Fly.io Machines API |
| `docker` | Local Docker (coming soon) |

## API Routes

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/lancia/instances` | List all instances |
| `POST` | `/api/v1/lancia/instances` | Launch new instance |
| `POST` | `/api/v1/lancia/instances/:id/restart` | Restart instance |
| `DELETE` | `/api/v1/lancia/instances/:id` | Destroy instance |
| `POST` | `/api/v1/lancia/instances/start-all` | Start all instances |
| `POST` | `/api/v1/lancia/instances/stop-all` | Stop all instances |

## Required env vars (Fly.io backend)

```
FLY_API_TOKEN=<your Fly.io PAT>
FLY_APP_NAME=magofonte
LANCIA_BACKEND=fly
```
