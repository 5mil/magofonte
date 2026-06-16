-- MagoFonte — monetization module schema
-- revenue_ledger: audit trail for all revenue events
-- treasury_config: owner-controlled treasury wallet settings

-- ─────────────────────────────────────────────────────────────────────────────
-- revenue_ledger
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.revenue_ledger (
  id          BIGSERIAL PRIMARY KEY,
  source      TEXT        NOT NULL,  -- 'lp_fees' | 'pool_fees' | 'forge' | 'bridge' | 'sigil' | 'mesh'
  type        TEXT        NOT NULL,  -- 'fee_claim' | 'sweep' | 'bonus' | 'premium' | 'affiliate'
  amount      NUMERIC     NOT NULL DEFAULT 0,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  status      TEXT        NOT NULL DEFAULT 'pending', -- 'pending' | 'swept' | 'failed'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS revenue_ledger_source_idx  ON public.revenue_ledger (source);
CREATE INDEX IF NOT EXISTS revenue_ledger_status_idx  ON public.revenue_ledger (status);
CREATE INDEX IF NOT EXISTS revenue_ledger_created_idx ON public.revenue_ledger (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- treasury_config
-- owner-controlled wallet addresses per network
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.treasury_config (
  id          SERIAL PRIMARY KEY,
  network     TEXT        NOT NULL UNIQUE, -- 'solana' | 'dgb' | 'ltc'
  address     TEXT        NOT NULL,
  label       TEXT,
  active      BOOLEAN     NOT NULL DEFAULT true,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS — owner only
ALTER TABLE public.revenue_ledger  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.treasury_config ENABLE ROW LEVEL SECURITY;

-- Service role can read/write (used by the monetization module server-side)
-- No public anon access to either table
CREATE POLICY "service_full_access_revenue_ledger"
  ON public.revenue_ledger FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_full_access_treasury_config"
  ON public.treasury_config FOR ALL
  TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.revenue_ledger  IS 'Audit trail for all MagoFonte revenue events — LP fees, pool fees, premiums, affiliate rewards';
COMMENT ON TABLE public.treasury_config IS 'Owner-controlled treasury wallet addresses per network — write access restricted to service role';
