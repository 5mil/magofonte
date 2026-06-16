/**
 * Revenue Ledger
 *
 * Writes all revenue events (collections, sweeps, failures) to
 * Supabase revenue_ledger table. This is the audit trail for
 * every dollar that flows through the monetization module.
 *
 * Table: revenue_ledger
 *   id, source, type, amount, metadata (jsonb), status, created_at
 */

import { createClient } from '@supabase/supabase-js';

export class Ledger {
  constructor(config) {
    this.config   = config;
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }

  async record({ source, type, amount, metadata = {}, status = 'pending' }) {
    const { error } = await this.supabase
      .from('revenue_ledger')
      .insert({
        source,
        type,
        amount:     amount?.toString() || '0',
        metadata,
        status,
        created_at: new Date().toISOString(),
      });

    if (error) {
      console.error('[ledger] failed to record event:', error.message);
    }
  }

  async list(limit = 50, offset = 0, typeFilter = null) {
    let query = this.supabase
      .from('revenue_ledger')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (typeFilter) query = query.eq('type', typeFilter);

    const { data, error } = await query;
    if (error) {
      console.error('[ledger] failed to list events:', error.message);
      return [];
    }
    return data;
  }

  async totals() {
    const { data, error } = await this.supabase
      .from('revenue_ledger')
      .select('source, type, amount');

    if (error || !data) return {};

    const totals = {};
    for (const row of data) {
      if (!totals[row.source]) totals[row.source] = { total: 0n, swept: 0n, pending: 0n };
      const amt = BigInt(row.amount || 0);
      totals[row.source].total += amt;
      if (row.type === 'sweep') totals[row.source].swept   += amt;
      else                      totals[row.source].pending += amt;
    }
    return totals;
  }
}
