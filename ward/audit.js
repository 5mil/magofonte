/**
 * MagoFonte — ward/audit.js
 *
 * Append-only chained audit log.
 *
 * Every security-relevant event is written as a newline-delimited JSON entry.
 * Each entry includes a SHA-256 hash of (prev_hash + event_data), forming
 * a hash chain. Any deletion or modification of a log entry breaks the chain,
 * detectable via GET /ward/audit/verify.
 *
 * Events recorded:
 *   owner.setup          — first owner account created
 *   login.password       — successful password login
 *   login.cert           — successful cert-based login
 *   login.failed         — failed login attempt
 *   token.revoked        — jti added to denylist
 *   token.refresh        — refresh token consumed, new token issued
 *   role.assign          — role change
 *   user.created         — new user account
 *   user.deleted         — account deleted
 *   password.changed     — password updated
 *   cert.provisioned     — new credential cert issued
 *   cert.revoked         — cert jti revoked
 *   node.start           — coin daemon started
 *   node.stop            — coin daemon stopped
 *   pool.reward.changed  — block reward address updated
 *   wallet.export        — private key exported (owner only)
 *   treasury.sweep       — treasury sweep initiated
 *   audit.verify         — integrity check run
 */

import crypto from 'node:crypto';
import fs     from 'node:fs';
import path   from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir    = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(__dir, 'audit.log');

// ─── State ────────────────────────────────────────────────────────────────────

let seq      = 0;
let prevHash = '0'.repeat(64);  // genesis hash
let writeQueue = [];
let flushTimer = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

export function init() {
  if (fs.existsSync(LOG_FILE)) {
    // Read last line to restore seq and prevHash
    try {
      const content = fs.readFileSync(LOG_FILE, 'utf8');
      const lines   = content.split('\n').filter(Boolean);
      if (lines.length > 0) {
        const last = JSON.parse(lines[lines.length - 1]);
        seq      = last.seq;
        prevHash = last.hash;
      }
      console.log(`[audit] log loaded — ${lines.length} entries, seq=${seq}`);
    } catch (err) {
      console.warn(`[audit] could not read existing log: ${err.message}`);
    }
  } else {
    console.log('[audit] new audit log initialized');
  }
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Record a security event.
 *
 * @param {string} event     - event name (see list above)
 * @param {string} actor     - username or 'system'
 * @param {object} [details] - additional fields (no passwords, no keys)
 */
export function record(event, actor, details = {}) {
  seq++;
  const ts   = new Date().toISOString();
  const data = { seq, ts, event, actor, ...details };

  // Chain hash: SHA-256 of (prevHash + canonical JSON of this entry)
  const hashInput = prevHash + JSON.stringify(data);
  const hash      = crypto.createHash('sha256').update(hashInput).digest('hex');

  const entry = { ...data, prev_hash: prevHash, hash };
  prevHash    = hash;

  writeQueue.push(JSON.stringify(entry));
  scheduleFlush();

  return entry;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 500);
}

function flush() {
  flushTimer = null;
  if (writeQueue.length === 0) return;
  const lines = writeQueue.splice(0).join('\n') + '\n';
  fs.appendFile(LOG_FILE, lines, err => {
    if (err) console.error('[audit] flush error:', err.message);
  });
}

// Force flush (called on clean shutdown)
export function flushSync() {
  if (writeQueue.length === 0) return;
  const lines = writeQueue.splice(0).join('\n') + '\n';
  fs.appendFileSync(LOG_FILE, lines);
}

// ─── Verify chain integrity ────────────────────────────────────────────────────

/**
 * Walk the entire log and verify the hash chain.
 * Returns { ok, entries, firstBroken } where firstBroken is null if ok.
 */
export function verifyChain() {
  let entries = [];
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    entries       = content.split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (err) {
    return { ok: false, entries: 0, error: err.message };
  }

  let runningHash = '0'.repeat(64);
  for (const entry of entries) {
    const { hash, prev_hash, ...data } = entry;
    if (prev_hash !== runningHash) {
      return { ok: false, entries: entries.length, firstBroken: entry.seq, reason: 'prev_hash_mismatch' };
    }
    const expected = crypto.createHash('sha256')
      .update(runningHash + JSON.stringify(data))
      .digest('hex');
    if (hash !== expected) {
      return { ok: false, entries: entries.length, firstBroken: entry.seq, reason: 'hash_mismatch' };
    }
    runningHash = hash;
  }

  return { ok: true, entries: entries.length, firstBroken: null };
}

/**
 * Return recent log entries (tail), newest first.
 * Strips hash fields from output — hashes are for integrity, not display.
 */
export function tail(n = 50) {
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    return content.split('\n').filter(Boolean)
      .slice(-n)
      .reverse()
      .map(l => {
        const { hash, prev_hash, ...rest } = JSON.parse(l);
        return rest;
      });
  } catch { return []; }
}
