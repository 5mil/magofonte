# vault/

External signing layer for MagoFonte treasury transactions.

## Design

Private keys **never** live in this repository or in environment variables on any server.
All signing is delegated to one of three backends, selected via `VAULT_BACKEND` env var:

| Backend | Env var | Use case |
|---|---|---|
| `mock` | — | Development / testing only |
| `keystore` | `VAULT_KEYSTORE_PATH` + `VAULT_KEYSTORE_PASS` | Self-hosted, AES-256-GCM encrypted file |
| `remote` | `VAULT_REMOTE_URL` + `VAULT_REMOTE_TOKEN` | Remote signing service (Fireblocks-compatible) |

## Keystore file format

Create `keystore.json` (store it outside the repo, never commit it):

```json
{
  "version": 1,
  "networks": {
    "solana": { "iv": "<hex>", "tag": "<hex>", "data": "<hex>" },
    "dgb":    { "iv": "<hex>", "tag": "<hex>", "data": "<hex>" },
    "ltc":    { "iv": "<hex>", "tag": "<hex>", "data": "<hex>" }
  }
}
```

Each `data` field is the AES-256-GCM ciphertext of the raw private key string, encrypted with `VAULT_KEYSTORE_PASS` via scrypt KDF.

## Usage

```js
const vault = require('./vault');
await vault.init();
const { txid } = await vault.signTransaction('dgb', rawTxData);
```
