/**
 * mesh/index.js — ESM core module
 * Distributed compute task queue. Writes to revenue_ledger.
 */
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const REWARD_PER_TASK = 0.001;

class Mesh {
  constructor() { this.supabase = null; this._tasks = new Map(); this._workers = new Map(); }
  get name() { return 'mesh'; }

  async init(config = {}) {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      this.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    }
    console.log('[mesh] compute mesh active');
    return this;
  }

  createTask(type, payload) {
    const id   = crypto.randomBytes(16).toString('hex');
    const task = { id, type, payload, status: 'pending', created_at: new Date().toISOString() };
    this._tasks.set(id, task);
    return task;
  }

  async claimTask(workerId) {
    for (const [, task] of this._tasks) {
      if (task.status === 'pending') {
        task.status = 'claimed'; task.claimed_by = workerId; task.claimed_at = new Date().toISOString();
        this._workers.set(workerId, { lastSeen: Date.now(), completed: 0 });
        return task;
      }
    }
    return null;
  }

  async completeTask(taskId, workerId, result) {
    const task = this._tasks.get(taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    if (task.claimed_by !== workerId) throw new Error('wrong worker');
    task.status = 'done'; task.result = result; task.completed_at = new Date().toISOString();
    const w = this._workers.get(workerId) || { completed: 0 };
    w.completed = (w.completed || 0) + 1; w.lastSeen = Date.now();
    this._workers.set(workerId, w);
    if (this.supabase) {
      await this.supabase.from('revenue_ledger').insert({
        source: 'mesh', type: 'compute_reward', amount: REWARD_PER_TASK,
        network: 'solana', metadata: JSON.stringify({ taskId, workerId, type: task.type }),
        created_at: new Date().toISOString()
      });
    }
    return { reward: REWARD_PER_TASK, task };
  }

  stats() {
    const t = Array.from(this._tasks.values());
    return { pending: t.filter(x => x.status==='pending').length, claimed: t.filter(x => x.status==='claimed').length, done: t.filter(x => x.status==='done').length, workers: this._workers.size };
  }

  get routes() {
    const self = this;
    function json(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
    return [
      ['GET',  '/stats',          (req, res) => json(res, 200, self.stats()), { minRole: 'owner' }],
      ['POST', '/task/claim',     async (req, res) => {
        let body = ''; req.on('data', d => body += d);
        req.on('end', async () => {
          const { workerId } = JSON.parse(body);
          const task = await self.claimTask(workerId);
          json(res, 200, task || { status: 'no_tasks' });
        });
      }, { public: true }],
      ['POST', '/task/complete',  async (req, res) => {
        let body = ''; req.on('data', d => body += d);
        req.on('end', async () => {
          try { const b = JSON.parse(body); json(res, 200, await self.completeTask(b.taskId, b.workerId, b.result)); }
          catch (e) { json(res, 400, { error: e.message }); }
        });
      }, { public: true }],
    ];
  }
}

export default new Mesh();
