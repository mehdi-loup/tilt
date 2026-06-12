-- Execution ledger + wallet registry (Neon Postgres).
--
-- Apply with: psql "$DATABASE_URL" -f db/schema.sql
-- (idempotent — safe to re-run)
--
-- Next.js writes executions/steps at plan time and records client-signed
-- funding tx hashes; the Python sidecar updates step/execution status as
-- async strategy jobs progress.

create table if not exists server_wallets (
  user_id    text primary key,
  wallet_id  text not null,
  address    text not null,
  chain_type text not null default 'ethereum',
  created_at timestamptz not null default now()
);

create table if not exists executions (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 text not null,
  profile_id              text not null,
  risk                    int  not null,
  amount_usd              numeric not null,
  embedded_wallet_address text not null,
  server_wallet_id        text not null,
  server_wallet_address   text not null,
  -- planned | running | succeeded | failed
  status                  text not null default 'planned',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists executions_user_idx on executions (user_id, created_at desc);

create table if not exists steps (
  execution_id  uuid not null references executions(id) on delete cascade,
  step_id       text not null,
  seq           int  not null,
  kind          text not null,           -- fund | strategy
  signer        text not null,           -- embedded | server
  label         text not null,
  chain_id      int  not null,
  amount_usd    numeric,
  amount_units  text,
  strategy_name text,
  tx            jsonb,                   -- Wayfinder-built funding tx (client-signed steps)
  -- planned | running | succeeded | failed | stub
  status        text not null default 'planned',
  tx_hashes     jsonb not null default '[]',
  job_id        text,
  note          text,
  error         text,
  result        jsonb,                   -- strategy lifecycle payload from the sidecar
  updated_at    timestamptz not null default now(),
  primary key (execution_id, step_id)
);
