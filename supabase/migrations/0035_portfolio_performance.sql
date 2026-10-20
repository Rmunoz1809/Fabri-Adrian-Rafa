-- 0035: each portfolio card followed like a stock. Run once in Supabase ▸ SQL Editor after 0033 (safe to re-run).
-- holo.html works before and after it: until it runs, the entry value is worked out again from the price
-- history each time and the daily values are not kept.
--
-- added_value_cents: what the card was worth the day it went into the portfolio (its "entry price").
--   Set when it is saved; cards saved before this migration get it from the price history of that day,
--   the first time the page sees them. Written once: later updates can't change it.
-- value_log: the value the page saw each day, [["2026-10-20", 2649], …], one entry per day and up to
--   a year. With the price sources' own history it draws the line since the card was added, also for
--   cards whose sources only give today's price.

alter table public.portfolio_items add column if not exists added_value_cents int
  check (added_value_cents between 0 and 100000000);
alter table public.portfolio_items add column if not exists value_log jsonb not null default '[]'::jsonb;
alter table public.portfolio_items drop constraint if exists portfolio_value_log_shape;
alter table public.portfolio_items add constraint portfolio_value_log_shape check (
  case when jsonb_typeof(value_log) = 'array'
    then jsonb_array_length(value_log) <= 400 and octet_length(value_log::text) <= 20000
    else false end);

-- Same guard as 0033, plus: the entry value is written once.
create or replace function public.guard_portfolio_item() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    if (select count(*) from public.portfolio_items where user_id = new.user_id) >= 500 then
      raise exception 'portfolio: limit 500' using errcode = '22023';
    end if;
  else
    new.user_id := old.user_id;
    new.created_at := old.created_at;
    new.added_value_cents := coalesce(old.added_value_cents, new.added_value_cents);
  end if;
  new.subject := left(trim(regexp_replace(new.subject, '\s+', ' ', 'g')), 120);
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.guard_portfolio_item() from public, anon, authenticated;
