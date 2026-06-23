'use strict';
/**
 * mesh/index.js
 * Distributed compute task reward module.
 * Coordinates off-chain compute tasks distributed across Lancia instances.
 * Workers complete tasks and earn compute rewards logged to revenue_ledger.
 *
 * Task types:
 *   - hash_benchmark  — performance profiling
 *   - algo_validation — validate a hash result from a remote worker
 *   - data_index      — index/process external data
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const REWARD_PER_TASK_SOL = 0.001; // 0.001 SOL per completed task

class Mesh {
  constructor(config = {}) {
    this.supabase    = null;
    this._tasks      = new Map(); // taskId → task
    this._workers    = new Map(); // workerId → { lastSeen, completed }
  }

  async init() {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      this.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    }
    console.log('[mesh] Initialized — distributed compute mesh active');
  }

  createTask(type, payload) {
    const id = crypto.randomBytes(16).toString('hex');
    const task = { id, type, payload, status: 'pending', created_at: new Date().toISOString() };
    this._tasks.set(id, task);
    return task;
  }

  async claimTask(workerId) {
    for (const [id, task] of this._tasks) {
      if (task.status === 'pending') {
        task.status = 'claimed';
        task.claimed_by = workerId;
        task.claimed_at = new Date().toISOString();
        this._workers.set(workerId, { lastSeen: Date.now(), completed: 0 });
        return task;
      }
    }
    return null;
  }

  async completeTask(taskId, workerId, result) {
    const task = this._tasks.get(taskId);
    if (!task) throw new Error(`[mesh] Unknown task: ${taskId}`);
    if (task.claimed_by !== workerId) throw new Error('[mesh] Task claimed by different worker');
    task.status = 'done';
    task.result = result;
    task.completed_at = new Date().toISOString();
    const worker = this._workers.get(workerId) || { completed: 0 };
    worker.completed = (worker.completed || 0) + 1;
    worker.lastSeen = Date.now();
    this._workers.set(workerId, worker);
    if (this.supabase) {
      await this.supabase.from('revenue_ledger').insert({
        source: 'mesh', type: 'compute_reward', amount: REWARD_PER_TASK_SOL,
        network: 'solana',
        metadata: JSON.stringify({ taskId, workerId, type: task.type }),
        created_at: new Date().toISOString()
      });
    }
    return { reward: REWARD_PER_TASK_SOL, task };
  }

  stats() {
    const tasks = Array.from(this._tasks.values());
    return {
      pending:   tasks.filter(t => t.status === 'pending').length,
      claimed:   tasks.filter(t => t.status === 'claimed').length,
      done:      tasks.filter(t => t.status === 'done').length,
      workers:   this._workers.size,
    };
  }

  registerRoutes(app, ward) {
    app.get('/mesh/stats', ward.require('owner'), (req, res) => res.json(this.stats()));
    app.post('/mesh/task/claim', async (req, res) => {
      const task = await this.claimTask(req.body.workerId);
      res.json(task || { status: 'no_tasks' });
    });
    app.post('/mesh/task/complete', async (req, res) => {
      try {
        res.json(await this.completeTask(req.body.taskId, req.body.workerId, req.body.result));
      } catch (e) { res.status(400).json({ error: e.message }); }
    });
  }
}

module.exports = new Mesh();
