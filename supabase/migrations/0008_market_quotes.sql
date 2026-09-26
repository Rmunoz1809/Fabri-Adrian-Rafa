-- Cache of market prices found on the web by the Edge Function identificar-carta
-- (action "price"): one row per card + version + grade, reused for 24 hours so the
-- same card is not researched (and paid for) twice. Anyone can read it; only the
-- function writes, with the service role key.
create table if not exists public.market_quotes (
  quote_key  text primary key check (char_length(quote_key) <= 400),
  quote      jsonb not null,
  fetched_at timestamptz not null default now()
);
alter table public.market_quotes enable row level security;
drop policy if exists "market_quotes lectura pública" on public.market_quotes;
create policy "market_quotes lectura pública" on public.market_quotes for select using (true);
-- No insert/update/delete policies: only the service role (Edge Function) writes.
