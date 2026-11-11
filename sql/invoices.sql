begin;
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  issuer_id text not null check (issuer_id ~ '^[a-z0-9_-]{1,40}$'),
  order_id uuid not null,
  currency text not null check (currency = 'PEN'),
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 6),
  total_cents bigint not null check (total_cents between 0 and 30000000000),
  status text not null default 'issued' check (status = 'issued'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint invoices_issuer_order_unique unique (issuer_id, order_id)
);
alter table public.invoices enable row level security;
revoke all on table public.invoices from PUBLIC, anon, authenticated, service_role;
grant select, insert on table public.invoices to service_role;
-- Sin políticas para anon/authenticated: esta tabla no es una API pública.
commit;
