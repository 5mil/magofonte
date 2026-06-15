'use strict';
/**
 * pool/walletRoutes.js — Wallet REST Routes
 *
 * Returns an array of [method, path, handler] tuples that plug directly
 * into pool/index.js's `routes` getter — no Express, no external router.
 *
 * Mount prefix (applied by the core HTTP dispatcher): /api/wallet
 *
 * Endpoints
 * ---------
 *  GET    /api/wallet/:coin                        — list all wallets (no WIF)
 *  POST   /api/wallet/:coin/generate               — generate a new keypair
 *  POST   /api/wallet/:coin/import                 — import an existing WIF
 *  GET    /api/wallet/:coin/:label/export          — export WIF for a wallet
 *  POST   /api/wallet/:coin/:label/setActive       — promote wallet to active
 *  DELETE /api/wallet/:coin/:label                 — remove a wallet
 *
 * Usage
 * -----
 *   import walletRoutes from './walletRoutes.js';
 *   import walletManager from './walletManager.js';
 *   // inside Pool.routes getter:
 *   ...walletRoutes(walletManager)
 */

import walletManager from './walletManager.js';

// ─── tiny helpers (mirror pool/index.js style) ────────────────────────────────
function _json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function _400(res, msg) { res.writeHead(400); res.end(JSON.stringify({ error: msg })); }
function _404(res)      { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); }
function _body(req) {
  return new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b)); });
}

/**
 * Build the wallet route tuples.
 * @param {object} manager  — walletManager singleton (or any compatible object)
 * @returns {Array}         — [[method, path, handler], ...]
 */
export function walletRoutes(manager) {
  return [

    // ── List wallets for a coin ─────────────────────────────────────────────
    ['GET', '/wallet/:coin', (req, res) => {
      try {
        const { coin } = req.params;
        const wallets  = manager.list(coin);
        const active   = manager.getActive(coin);
        _json(res, { coin, wallets, active });
      } catch (e) {
        _400(res, e.message);
      }
    }],

    // ── Generate a new keypair ──────────────────────────────────────────────
    ['POST', '/wallet/:coin/generate', async (req, res) => {
      const body = await _body(req);
      try {
        const { label }  = body ? JSON.parse(body) : {};
        const { coin }   = req.params;
        const entry      = manager.generate(coin, label);
        _json(res, entry, 201);
      } catch (e) {
        _400(res, e.message);
      }
    }],

    // ── Import a WIF private key ────────────────────────────────────────────
    ['POST', '/wallet/:coin/import', async (req, res) => {
      const body = await _body(req);
      try {
        const { wif, label } = JSON.parse(body);
        if (!wif) return _400(res, 'wif is required');
        const { coin } = req.params;
        const entry    = manager.import(coin, wif, label);
        _json(res, entry, 201);
      } catch (e) {
        _400(res, e.message);
      }
    }],

    // ── Export WIF for a named wallet ───────────────────────────────────────
    ['GET', '/wallet/:coin/:label/export', (req, res) => {
      try {
        const { coin, label } = req.params;
        const wif = manager.export(coin, decodeURIComponent(label));
        _json(res, { coin, label, wif });
      } catch (e) {
        e.message.includes('not found') ? _404(res) : _400(res, e.message);
      }
    }],

    // ── Set a wallet as active (hot-swaps reward address) ───────────────────
    ['POST', '/wallet/:coin/:label/setActive', (req, res) => {
      try {
        const { coin, label } = req.params;
        manager.setActive(coin, decodeURIComponent(label));
        const active = manager.getActive(coin);
        _json(res, { ok: true, coin, active });
      } catch (e) {
        e.message.includes('not found') ? _404(res) : _400(res, e.message);
      }
    }],

    // ── Delete a wallet ─────────────────────────────────────────────────────
    ['DELETE', '/wallet/:coin/:label', (req, res) => {
      try {
        const { coin, label } = req.params;
        manager.remove(coin, decodeURIComponent(label));
        _json(res, { ok: true });
      } catch (e) {
        e.message.includes('not found') ? _404(res) : _400(res, e.message);
      }
    }],

  ];
}

export default walletRoutes;
