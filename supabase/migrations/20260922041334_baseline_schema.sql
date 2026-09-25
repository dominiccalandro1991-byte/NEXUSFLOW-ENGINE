-- NexusFlow paper-trading ledger. IDs are text (preview user ids are not UUID).
-- Financial quantities are integer lots / ticks. Application code enforces
-- Σ debit = Σ credit per transaction_id.

create table if not exists nf_assets (
  id text primary key,
  name text not null,
  decimals integer not null,
  kind text not null check (kind in ('fiat', 'crypto')),
  created_at timestamptz not null default now()
);

create table if not exists nf_instruments (
  id text primary key,
  base_asset text not null references nf_assets(id),
  quote_asset text not null references nf_assets(id),
  tick_size integer not null check (tick_size > 0),
  lot_size integer not null check (lot_size > 0),
  min_notional integer not null default 1,
  status text not null default 'active'
);

create table if not exists nf_accounts (
  user_id text primary key,
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now()
);

create table if not exists nf_balances (
  user_id text not null references nf_accounts(user_id),
  asset_id text not null references nf_assets(id),
  available bigint not null default 0 check (available >= 0),
  locked bigint not null default 0 check (locked >= 0),
  primary key (user_id, asset_id)
);

create table if not exists nf_orders (
  order_id text primary key,
  user_id text not null references nf_accounts(user_id),
  instrument_id text not null references nf_instruments(id),
  side text not null check (side in ('buy', 'sell')),
  order_type text not null check (order_type in ('limit', 'market')),
  price_ticks bigint,
  quantity bigint not null check (quantity > 0),
  remaining bigint not null check (remaining >= 0),
  status text not null,
  sequence_no bigint not null,
  client_order_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists nf_orders_user_idx on nf_orders (user_id, created_at desc);
create index if not exists nf_orders_instrument_status_idx on nf_orders (instrument_id, status);

create table if not exists nf_trades (
  trade_id text primary key,
  instrument_id text not null,
  maker_order_id text not null,
  taker_order_id text not null,
  maker_user_id text not null,
  taker_user_id text not null,
  price_ticks bigint not null,
  quantity bigint not null,
  sequence_no bigint not null,
  created_at timestamptz not null default now()
);
create index if not exists nf_trades_instrument_idx on nf_trades (instrument_id, created_at desc);
create index if not exists nf_trades_user_idx on nf_trades (taker_user_id, created_at desc);

create table if not exists nf_ledger (
  entry_id text primary key,
  transaction_id text not null,
  user_id text not null,
  asset_id text not null,
  debit bigint not null default 0 check (debit >= 0),
  credit bigint not null default 0 check (credit >= 0),
  event_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists nf_ledger_tx_idx on nf_ledger (transaction_id);
create index if not exists nf_ledger_user_idx on nf_ledger (user_id, created_at desc);

create table if not exists nf_order_events (
  event_id text primary key,
  order_id text not null,
  sequence_no bigint not null,
  previous_state text,
  new_state text not null,
  actor text not null,
  event_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists nf_audit (
  audit_id text primary key,
  domain text not null,
  user_id text,
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists nf_audit_domain_idx on nf_audit (domain, created_at desc);

create table if not exists nf_api_usage (
  id text primary key,
  user_id text not null,
  route text not null,
  created_at timestamptz not null default now()
);

insert into nf_assets (id, name, decimals, kind) values
  ('USD', 'US Dollar', 2, 'fiat'),
  ('BTC', 'Bitcoin', 8, 'crypto'),
  ('ETH', 'Ether', 8, 'crypto'),
  ('SOL', 'Solana', 8, 'crypto')
on conflict (id) do nothing;

insert into nf_instruments (id, base_asset, quote_asset, tick_size, lot_size, min_notional) values
  ('BTC-USD', 'BTC', 'USD', 1, 1, 1),
  ('ETH-USD', 'ETH', 'USD', 1, 1, 1),
  ('SOL-USD', 'SOL', 'USD', 1, 1, 1)
on conflict (id) do nothing;

insert into nf_accounts (user_id, status) values ('liquidity-bot', 'active')
on conflict (user_id) do nothing;

insert into nf_balances (user_id, asset_id, available, locked) values
  ('liquidity-bot', 'USD', 100000000, 0),
  ('liquidity-bot', 'BTC', 100000000, 0),
  ('liquidity-bot', 'ETH', 100000000, 0),
  ('liquidity-bot', 'SOL', 100000000, 0)
on conflict (user_id, asset_id) do nothing;

-- Production RLS (Supabase). Application authorization remains mandatory.
-- Service role is server-only and bypasses RLS.
alter table nf_accounts enable row level security;
alter table nf_balances enable row level security;
alter table nf_orders enable row level security;
alter table nf_trades enable row level security;
alter table nf_ledger enable row level security;
alter table nf_order_events enable row level security;
alter table nf_audit enable row level security;
