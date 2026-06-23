-- =============================================================================
-- MagoFonte — Supabase migration
-- forge_access + stream_subscriptions
-- Apply via: Supabase dashboard → SQL editor, or supabase db push
-- =============================================================================

-- forge_access: tracks premium feature grants per user
create table if not exists forge_access (
  id           uuid        primary key default gen_random_uuid(),
  user_id      text        not null,
  feature_id   text        not null,
  granted_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  txid         text,
  price_sol    numeric(18,9),
  constraint forge_access_unique unique (user_id, feature_id)
);

alter table forge_access enable row level security;

create policy "forge_service_all" on forge_access
  for all using (auth.role() = 'service_role');

create policy "forge_user_read_own" on forge_access
  for select using (auth.uid()::text = user_id);

create index if not exists forge_access_user_idx    on forge_access (user_id);
create index if not exists forge_access_expires_idx on forge_access (expires_at);
create index if not exists forge_access_feature_idx on forge_access (feature_id);

-- stream_subscriptions: API billing tier per user
create table if not exists stream_subscriptions (
  id            uuid        primary key default gen_random_uuid(),
  user_id       text        not null unique,
  tier          text        not null check (tier in ('free','basic','pro')),
  txid          text,
  subscribed_at timestamptz not null default now(),
  expires_at    timestamptz not null
);

alter table stream_subscriptions enable row level security;

create policy "stream_service_all" on stream_subscriptions
  for all using (auth.role() = 'service_role');

create policy "stream_user_read_own" on stream_subscriptions
  for select using (auth.uid()::text = user_id);

create index if not exists stream_subs_user_idx    on stream_subscriptions (user_id);
create index if not exists stream_subs_expires_idx on stream_subscriptions (expires_at);
