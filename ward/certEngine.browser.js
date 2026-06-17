/**
 * MagoFonte — ward/certEngine.browser.js
 *
 * Client-side Ed25519 credential certificate engine.
 * Runs entirely in the browser. No Node.js APIs.
 *
 * Security model:
 * ────────────────
 * The Ed25519 private key is generated with extractable:false.
 * It is stored in IndexedDB as a CryptoKey object — the browser's
 * secure key store. The raw private key bytes are never accessible
 * to JavaScript after creation, even to this module, even under XSS.
 *
 * The public key IS exported (as raw bytes, base64url encoded) and
 * sent to the server during provisioning. The server builds the cert
 * payload, returns it unsigned. The browser signs it here and
 * produces the downloadable .lancia cert file.
 *
 * After the one-time download, the cert JSON is not retained in
 * localStorage or sessionStorage. The owner keeps the file.
 * The private key in IndexedDB is the only persistent browser state.
 *
 * Login flow:
 * ─────────────
 *   1. GET  /api/v1/ward/challenge           → { nonce }
 *   2. User loads their .lancia cert file
 *   3. signChallenge(nonce)                  → base64url signature
 *   4. POST /api/v1/ward/login/cert          → { token, refresh cookie }
 *
 * IndexedDB schema:
 * ─────────────────
 *   DB:    'magofonte'
 *   Store: 'keys'
 *   Key:   'mf:privkey'   → CryptoKey (Ed25519, extractable:false)
 *
 * Exports (all async):
 *   generateKeypair()            → { pubkeyB64 }   (privkey stored, never returned)
 *   signCert(unsignedPayload)    → cert JSON string (ready to download)
 *   downloadCert(certJson)       → void             (triggers browser download)
 *   signChallenge(nonce)         → base64url sig
 *   certLogin(cert, apiBase?)    → { token, username, role, scope }
 *   hasKeypair()                 → boolean
 *   clearKeypair()               → void
 *   parseCertFile(file)          → cert object
 *   exportPublicKey()            → base64url string (for re-provisioning)
 */

// ─── Constants ────────────────────────────────────────────────────────────

const IDB_DB_NAME    = 'magofonte';
const IDB_DB_VERSION = 1;
const IDB_STORE      = 'keys';
const IDB_KEY        = 'mf:privkey';
const IDB_PUBKEY     = 'mf:pubkey';   // raw bytes stored alongside for re-export

// Ed25519 algorithm descriptor
const ALG = { name: 'Ed25519' };

// ─── IndexedDB helpers ────────────────────────────────────────────────────

function _openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, IDB_DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(new Error(`IDB open failed: ${e.target.error}`));
  });
}

function _idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(new Error(`IDB get failed: ${e.target.error}`));
  });
}

function _idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(IDB_STORE, 'readwrite');
    const req = tx.objectStore(IDB_STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(new Error(`IDB put failed: ${e.target.error}`));
  });
}

function _idbDelete(db, key) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(IDB_STORE, 'readwrite');
    const req = tx.objectStore(IDB_STORE).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(new Error(`IDB delete failed: ${e.target.error}`));
  });
}

// ─── b64url helpers ─────────────────────────────────────────────────────────

function _bufToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let   bin   = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _b64urlToBuf(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function _strToBuf(str) {
  return new TextEncoder().encode(str).buffer;
}

// ─── Keypair generation ───────────────────────────────────────────────────────

/**
 * Generate a new Ed25519 keypair.
 *
 * The private key is stored in IndexedDB with extractable:false.
 * It cannot be read back by any JavaScript, including this function.
 * The public key is exported as raw bytes and returned as base64url.
 *
 * If a keypair already exists in IndexedDB, this REPLACES it.
 * The old private key is permanently lost. Only call this during
 * initial provisioning or explicit key rotation.
 *
 * @returns {Promise<{ pubkeyB64: string }>}
 */
export async function generateKeypair() {
  const keypair = await crypto.subtle.generateKey(
    ALG,
    false,      // extractable:false — private key bytes never accessible to JS
    ['sign', 'verify']
  );

  // Export public key as raw bytes (32 bytes for Ed25519)
  const pubkeyRaw  = await crypto.subtle.exportKey('raw', keypair.publicKey);
  const pubkeyB64  = _bufToB64url(pubkeyRaw);

  // Store both keys in IndexedDB
  // Private key stored as CryptoKey object (extractable:false enforced by browser)
  // Public key stored as raw ArrayBuffer for re-export without SubtleCrypto
  const db = await _openDB();
  await _idbPut(db, IDB_KEY,    keypair.privateKey);
  await _idbPut(db, IDB_PUBKEY, pubkeyRaw);
  db.close();

  console.log('[certEngine] keypair generated and stored in IndexedDB (private key: extractable:false)');
  return { pubkeyB64 };
}

/**
 * Check whether a private key exists in IndexedDB.
 * Use this to determine UI state (show "generate keys" vs "provision cert").
 *
 * @returns {Promise<boolean>}
 */
export async function hasKeypair() {
  try {
    const db  = await _openDB();
    const key = await _idbGet(db, IDB_KEY);
    db.close();
    return key instanceof CryptoKey;
  } catch {
    return false;
  }
}

/**
 * Delete the private key from IndexedDB.
 * Call this when revoking a cert or rotating keys.
 * This action is irreversible — the private key cannot be recovered.
 *
 * @returns {Promise<void>}
 */
export async function clearKeypair() {
  const db = await _openDB();
  await _idbDelete(db, IDB_KEY);
  await _idbDelete(db, IDB_PUBKEY);
  db.close();
  console.log('[certEngine] keypair cleared from IndexedDB');
}

/**
 * Export the stored public key as base64url.
 * Safe to call at any time — only the public key is returned.
 * Returns null if no keypair exists.
 *
 * @returns {Promise<string|null>}
 */
export async function exportPublicKey() {
  try {
    const db     = await _openDB();
    const rawBuf = await _idbGet(db, IDB_PUBKEY);
    db.close();
    if (!rawBuf) return null;
    return _bufToB64url(rawBuf);
  } catch {
    return null;
  }
}

// ─── Cert signing ────────────────────────────────────────────────────────────

/**
 * Sign an unsigned cert payload returned by POST /api/v1/ward/provision.
 *
 * The server builds the payload (iss, aud, exp, scope, etc.) and returns it
 * without a signature. This function:
 *   1. Canonicalises the payload (JSON.stringify, deterministic)
 *   2. Signs it with the IndexedDB private key
 *   3. Attaches the signature as 'signature' field
 *   4. Returns the complete cert as a JSON string
 *
 * The returned string is what goes into the downloadable .lancia file.
 * It is NOT stored anywhere by this function.
 *
 * @param {object} unsignedPayload   - cert payload from /ward/provision (no 'signature' field)
 * @returns {Promise<string>}         - complete cert JSON string
 */
export async function signCert(unsignedPayload) {
  if (unsignedPayload.signature) {
    throw new Error('payload already has a signature field — pass the unsigned payload');
  }

  const db      = await _openDB();
  const privKey = await _idbGet(db, IDB_KEY);
  db.close();

  if (!privKey || !(privKey instanceof CryptoKey)) {
    throw new Error('no private key in IndexedDB — call generateKeypair() first');
  }

  // Canonical JSON — keys sorted for determinism
  const canonical  = JSON.stringify(unsignedPayload, Object.keys(unsignedPayload).sort());
  const dataBuf    = _strToBuf(canonical);
  const sigBuf     = await crypto.subtle.sign(ALG, privKey, dataBuf);
  const sigB64     = _bufToB64url(sigBuf);

  const signedCert = { ...unsignedPayload, signature: sigB64 };
  return JSON.stringify(signedCert, null, 2);
}

/**
 * Trigger a browser download of the cert JSON as a .lancia file.
 *
 * This is the ONLY time the cert data should be persisted by the user.
 * After this call, the cert is not retained anywhere in the browser.
 * If the user loses the file, they must re-provision (same keypair, new cert).
 *
 * @param {string} certJson   - complete cert JSON string from signCert()
 * @param {string} [filename] - defaults to 'magofonte-owner.lancia'
 */
export function downloadCert(certJson, filename = 'magofonte-owner.lancia') {
  const blob = new Blob([certJson], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  // Attach briefly, click, remove immediately
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke object URL after a tick — don't leave a dangling reference
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

// ─── Challenge signing ────────────────────────────────────────────────────────

/**
 * Sign a nonce for cert-based login.
 *
 * The nonce is the raw string returned by GET /api/v1/ward/challenge.
 * It is signed with the IndexedDB private key.
 * The resulting base64url signature is sent to POST /api/v1/ward/login/cert
 * alongside the cert object.
 *
 * @param {string} nonce   - base64url nonce from /ward/challenge
 * @returns {Promise<string>}  base64url signature
 */
export async function signChallenge(nonce) {
  const db      = await _openDB();
  const privKey = await _idbGet(db, IDB_KEY);
  db.close();

  if (!privKey || !(privKey instanceof CryptoKey)) {
    throw new Error('no private key in IndexedDB — this browser has not been provisioned');
  }

  const dataBuf = _strToBuf(nonce);
  const sigBuf  = await crypto.subtle.sign(ALG, privKey, dataBuf);
  return _bufToB64url(sigBuf);
}

// ─── Cert file parsing ────────────────────────────────────────────────────────

/**
 * Parse and validate a .lancia cert file selected by the user.
 *
 * Reads the File object (from an <input type="file"> event),
 * parses the JSON, and validates required fields.
 * Does NOT verify the signature — that happens server-side.
 * Does NOT store the cert — caller holds the reference.
 *
 * @param {File} file   - File object from input[type=file].files[0]
 * @returns {Promise<object>}  parsed cert object
 */
export function parseCertFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => {
      try {
        const cert = JSON.parse(e.target.result);
        _validateCertShape(cert);
        resolve(cert);
      } catch (err) {
        reject(new Error(`invalid cert file: ${err.message}`));
      }
    };
    reader.onerror = () => reject(new Error('could not read file'));
    reader.readAsText(file);
  });
}

function _validateCertShape(cert) {
  const required = ['cert_id', 'iss', 'sub', 'aud', 'iat', 'exp', 'jti', 'role', 'scope', 'env', 'owner_pubkey', 'signature'];
  for (const field of required) {
    if (cert[field] === undefined) {
      throw new Error(`missing required field: ${field}`);
    }
  }
  if (cert.iss !== 'magofonte:lancia') {
    throw new Error(`unexpected issuer: ${cert.iss}`);
  }
  if (!Array.isArray(cert.scope) || cert.scope.length === 0) {
    throw new Error('cert.scope must be a non-empty array');
  }
  if (!Array.isArray(cert.aud) || cert.aud.length === 0) {
    throw new Error('cert.aud must be a non-empty array');
  }
  const now = Math.floor(Date.now() / 1000);
  if (cert.exp < now) {
    throw new Error(`cert is expired (exp: ${new Date(cert.exp * 1000).toISOString()})`);
  }
}

// ─── Full cert login flow ─────────────────────────────────────────────────────

/**
 * Complete cert-based login in a single call.
 *
 * Flow:
 *   1. GET  /api/v1/ward/challenge  → nonce
 *   2. signChallenge(nonce)         → sig
 *   3. POST /api/v1/ward/login/cert { nonce, sig, cert }
 *   4. Returns { token, username, role, scope }
 *
 * The session token is returned to the caller.
 * The refresh token is set as HttpOnly cookie by the server automatically.
 * The token should be stored in a JS variable (memory only) — NOT in
 * localStorage or sessionStorage.
 *
 * @param {object} cert       - parsed cert object (from parseCertFile)
 * @param {string} [apiBase]  - defaults to window.location.origin
 * @returns {Promise<{ token: string, username: string, role: string, scope: string[] }>}
 */
export async function certLogin(cert, apiBase = window.location.origin) {
  // Step 1: Get challenge nonce
  const challengeRes = await fetch(`${apiBase}/api/v1/ward/challenge`, {
    method: 'GET',
    credentials: 'include'   // include for refresh cookie on later calls
  });
  if (!challengeRes.ok) {
    throw new Error(`challenge request failed: ${challengeRes.status}`);
  }
  const { nonce } = await challengeRes.json();
  if (!nonce) throw new Error('server returned empty nonce');

  // Step 2: Sign nonce with IndexedDB private key
  const sig = await signChallenge(nonce);

  // Step 3: Submit cert + signed nonce
  const loginRes = await fetch(`${apiBase}/api/v1/ward/login/cert`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',   // server will Set-Cookie: mf_refresh
    body: JSON.stringify({ nonce, sig, cert })
  });

  if (!loginRes.ok) {
    let msg = `login failed: ${loginRes.status}`;
    try {
      const body = await loginRes.json();
      if (body.error) msg = body.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  const result = await loginRes.json();
  if (!result.token) throw new Error('server did not return a token');

  return {
    token:    result.token,
    username: result.username,
    role:     result.role,
    scope:    result.scope || []
  };
}

// ─── Full provisioning flow helper ────────────────────────────────────────────

/**
 * Provision a new owner cert in a single call.
 *
 * Steps:
 *   1. generateKeypair()              → { pubkeyB64 }   (stored in IndexedDB)
 *   2. POST /api/v1/ward/provision    → { certPayload } (unsigned, built by server)
 *   3. signCert(certPayload)          → cert JSON string
 *   4. downloadCert(certJson)         → triggers download
 *   5. Returns cert object (in-memory only — not stored anywhere)
 *
 * The caller MUST store the bearer token in memory before calling this.
 * Provisioning requires an authenticated owner session.
 *
 * @param {string} bearerToken          - current owner session token
 * @param {object} opts                 - { tier, termMonths, instanceId, scopeOverride? }
 * @param {string} [apiBase]
 * @returns {Promise<object>}            cert object (for display confirmation)
 */
export async function provisionCert(bearerToken, opts = {}, apiBase = window.location.origin) {
  // Step 1: Generate keypair, get public key
  const { pubkeyB64 } = await generateKeypair();

  // Step 2: Request cert payload from server
  const res = await fetch(`${apiBase}/api/v1/ward/provision`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${bearerToken}`
    },
    credentials: 'include',
    body: JSON.stringify({
      pubkey:       pubkeyB64,
      tier:         opts.tier        || 'forge',
      termMonths:   opts.termMonths  || 12,
      instanceId:   opts.instanceId  || undefined,
      scopeOverride: opts.scopeOverride || undefined
    })
  });

  if (!res.ok) {
    let msg = `provision failed: ${res.status}`;
    try {
      const body = await res.json();
      if (body.error) msg = body.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  const { certPayload } = await res.json();
  if (!certPayload) throw new Error('server returned no certPayload');

  // Step 3: Sign cert with private key
  const certJson = await signCert(certPayload);
  const cert     = JSON.parse(certJson);

  // Step 4: One-time download
  const filename = `magofonte-${cert.env?.instance_id || 'owner'}-${cert.cert_id}.lancia`;
  downloadCert(certJson, filename);

  console.log(`[certEngine] cert provisioned: ${cert.cert_id}, tier: ${cert.env?.tier}, exp: ${new Date(cert.exp * 1000).toISOString()}`);

  // Return for display confirmation — not stored anywhere by this function
  return cert;
}
