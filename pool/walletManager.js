'use strict';
/**
 * pool/walletManager.js — Modular Wallet Manager
 *
 * A per-coin wallet registry.  Each coin gets an isolated slot containing
 * one or many named wallets.  One wallet per coin is marked "active" —
 * that is the address that appears in coinbase outputs.
 *
 * Storage
 * -------
 * Wallets are persisted to vault/wallets.enc.json as an AES-256-GCM
 * encrypted JSON blob.  The encryption key is derived from the env var
 * WALLET_PASSPHRASE via scrypt.  If the env var is absent the vault is
 * stored as plaintext JSON (dev mode — a loud warning is emitted).
 *
 * Events
 * ------
 * The manager is an EventEmitter.  Listen for:
 *   'activeChanged'  ({ coinId, address })  — fired when setActive() is called
 *
 * Public API
 * ----------
 *   manager.generate(coinId, label?)              → walletEntry
 *   manager.import(coinId, wif, label?)           → walletEntry
 *   manager.export(coinId, label)                 → wif string
 *   manager.remove(coinId, label)                 → void
 *   manager.setActive(coinId, label)              → void  (+ emits activeChanged)
 *   manager.getActive(coinId)                     → walletEntry | null
 *   manager.list(coinId)                          → walletEntry[]
 *
 * walletEntry shape: { label, address, wif, createdAt }
 */

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const EventEmitter = require('events');
const { generateKey, fromWIF } = require('./wallet');

const VAULT_DIR  = path.resolve(__dirname, '../vault');
const VAULT_FILE = path.join(VAULT_DIR, 'wallets.enc.json');

// ─── Crypto helpers ───────────────────────────────────────────────────────────
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEY_LEN = 32;
const SALT     = Buffer.from('magofonte-wallet-salt-v1'); // static salt (passphrase is the secret)

function deriveKey(passphrase) {
  return crypto.scryptSync(passphrase, SALT, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

function encrypt(plaintext, key) {
  const iv         = crypto.randomBytes(12);
  const cipher     = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag        = cipher.getAuthTag();
  return JSON.stringify({
    iv:   iv.toString('hex'),
    tag:  tag.toString('hex'),
    data: ciphertext.toString('hex'),
  });
}

function decrypt(encJson, key) {
  const { iv, tag, data } = JSON.parse(encJson);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return decipher.update(Buffer.from(data, 'hex')) + decipher.final('utf8');
}

// ─── WalletManager ────────────────────────────────────────────────────────────
class WalletManager extends EventEmitter {
  constructor() {
    super();
    this._passphrase = process.env.WALLET_PASSPHRASE || null;
    if (!this._passphrase) {
      console.warn('[WalletManager] WALLET_PASSPHRASE not set — vault stored as PLAINTEXT (dev mode only)');
    }
    // registry shape: { [coinId]: { wallets: walletEntry[], active: label|null } }
    this._registry = {};
    this._load();
  }

  // ─── Persistence ────────────────────────────────────────────────────────────
  _load() {
    if (!fs.existsSync(VAULT_FILE)) return;
    try {
      const raw = fs.readFileSync(VAULT_FILE, 'utf8');
      const json = this._passphrase
        ? decrypt(raw, deriveKey(this._passphrase))
        : raw;
      this._registry = JSON.parse(json);
    } catch (err) {
      console.error('[WalletManager] Failed to load vault:', err.message);
    }
  }

  _save() {
    if (!fs.existsSync(VAULT_DIR)) fs.mkdirSync(VAULT_DIR, { recursive: true });
    const json = JSON.stringify(this._registry, null, 2);
    const out  = this._passphrase ? encrypt(json, deriveKey(this._passphrase)) : json;
    fs.writeFileSync(VAULT_FILE, out, 'utf8');
  }

  // ─── Coin slot helpers ───────────────────────────────────────────────────────
  _slot(coinId) {
    if (!this._registry[coinId]) {
      this._registry[coinId] = { wallets: [], active: null };
    }
    return this._registry[coinId];
  }

  _find(coinId, label) {
    return this._slot(coinId).wallets.find(w => w.label === label) || null;
  }

  _uniqueLabel(coinId, base) {
    const slot = this._slot(coinId);
    if (!slot.wallets.find(w => w.label === base)) return base;
    let i = 2;
    while (slot.wallets.find(w => w.label === `${base}-${i}`)) i++;
    return `${base}-${i}`;
  }

  _loadCoin(coinId) {
    // Lazy-load coin definition from coins/<coinId>.json
    const coinFile = path.resolve(__dirname, `../coins/${coinId}.json`);
    if (!fs.existsSync(coinFile)) throw new Error(`No coin definition found for: ${coinId}`);
    return JSON.parse(fs.readFileSync(coinFile, 'utf8'));
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Generate a new keypair and store it.
   */
  generate(coinId, label) {
    const coin   = this._loadCoin(coinId);
    const { wif, address } = generateKey(coin);
    const slot   = this._slot(coinId);
    const lbl    = this._uniqueLabel(coinId, label || `wallet-${slot.wallets.length + 1}`);
    const entry  = { label: lbl, address, wif, createdAt: new Date().toISOString() };
    slot.wallets.push(entry);
    if (!slot.active) slot.active = lbl;
    this._save();
    return this._safeEntry(entry);
  }

  /**
   * Import an existing WIF private key.
   */
  import(coinId, wif, label) {
    const coin  = this._loadCoin(coinId);
    const { address } = fromWIF(wif, coin); // validates WIF + derives address
    const slot  = this._slot(coinId);
    const lbl   = this._uniqueLabel(coinId, label || `imported-${slot.wallets.length + 1}`);
    const entry = { label: lbl, address, wif, createdAt: new Date().toISOString() };
    slot.wallets.push(entry);
    if (!slot.active) slot.active = lbl;
    this._save();
    return this._safeEntry(entry);
  }

  /**
   * Export the WIF for a named wallet.
   */
  export(coinId, label) {
    const entry = this._find(coinId, label);
    if (!entry) throw new Error(`Wallet not found: ${coinId}/${label}`);
    return entry.wif;
  }

  /**
   * Remove a wallet.  Cannot remove the active wallet unless it is the only one.
   */
  remove(coinId, label) {
    const slot = this._slot(coinId);
    const idx  = slot.wallets.findIndex(w => w.label === label);
    if (idx < 0) throw new Error(`Wallet not found: ${coinId}/${label}`);
    if (slot.active === label && slot.wallets.length > 1) {
      throw new Error('Cannot remove the active wallet — set another wallet active first');
    }
    slot.wallets.splice(idx, 1);
    if (slot.active === label) slot.active = slot.wallets[0]?.label || null;
    this._save();
  }

  /**
   * Set the active wallet for a coin.  Emits 'activeChanged'.
   */
  setActive(coinId, label) {
    const entry = this._find(coinId, label);
    if (!entry) throw new Error(`Wallet not found: ${coinId}/${label}`);
    this._slot(coinId).active = label;
    this._save();
    this.emit('activeChanged', { coinId, address: entry.address });
  }

  /**
   * Get the currently active wallet entry (without WIF).
   */
  getActive(coinId) {
    const slot = this._slot(coinId);
    if (!slot.active) return null;
    const entry = this._find(coinId, slot.active);
    return entry ? this._safeEntry(entry) : null;
  }

  /**
   * List all wallets for a coin (without WIF).
   */
  list(coinId) {
    const slot = this._slot(coinId);
    return slot.wallets.map(e => ({
      ...this._safeEntry(e),
      isActive: e.label === slot.active,
    }));
  }

  // Strip WIF from public-facing responses
  _safeEntry({ label, address, createdAt }) {
    return { label, address, createdAt };
  }
}

// Singleton
const manager = new WalletManager();
module.exports = manager;
