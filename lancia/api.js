'use strict';
/**
 * lancia/api.js
 * Express route handler for /api/v1/lancia/instances
 * Manages Lancia instance fleet — create, list, restart, destroy.
 *
 * Backends supported (selected via LANCIA_BACKEND env var):
 *   fly     — Fly.io Machines API
 *   docker  — local Docker via dockerode
 *   mock    — in-memory mock for dev/test
 *
 * Mount with: app.use('/api/v1/lancia', require('./lancia/api'))
 */

const express = require('express');
const router  = express.Router();

const backend = (() => {
  const b = process.env.LANCIA_BACKEND || 'mock';
  try { return require(`./backends/${b}`); }
  catch { console.warn(`[lancia/api] Backend "${b}" not found, falling back to mock`); return require('./backends/mock'); }
})();

// ─── GET /instances ───────────────────────────────────────────────────────────
router.get('/instances', async (req, res) => {
  try {
    const instances = await backend.list();
    res.json({ instances, total: instances.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /instances ──────────────────────────────────────────────────────────
router.post('/instances', async (req, res) => {
  const { name, region, image, size, stratumPort, apiPort, env, rewardAddress } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const instance = await backend.create({ name, region, image, size, stratumPort, apiPort, env, rewardAddress });
    res.status(201).json(instance);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /instances/:id/restart ─────────────────────────────────────────────
router.post('/instances/:id/restart', async (req, res) => {
  try {
    const result = await backend.restart(req.params.id);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /instances/:id ────────────────────────────────────────────────────
router.delete('/instances/:id', async (req, res) => {
  try {
    await backend.destroy(req.params.id);
    res.json({ destroyed: true, id: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /instances/start-all ───────────────────────────────────────────────
router.post('/instances/start-all', async (req, res) => {
  try {
    const instances = await backend.list();
    const results = await Promise.allSettled(instances.map(i => backend.restart(i.id)));
    res.json({ started: results.filter(r => r.status === 'fulfilled').length, total: instances.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /instances/stop-all ────────────────────────────────────────────────
router.post('/instances/stop-all', async (req, res) => {
  try {
    const instances = await backend.list();
    const results = await Promise.allSettled(instances.map(i => backend.destroy(i.id)));
    res.json({ stopped: results.filter(r => r.status === 'fulfilled').length, total: instances.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
