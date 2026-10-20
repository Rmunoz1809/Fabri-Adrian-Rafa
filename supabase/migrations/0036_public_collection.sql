-- 0036: public collection and "Me interesa". Run once in Supabase ▸ SQL Editor after 0033 and 0035
-- (safe to re-run). holo.html works before it: until it runs, the portfolio stays private and the
-- "Me interesa" buttons don't show.
--
-- The portfolio owner chooses which of their cards everyone can see on their profile (#/vendedor/<id>):
-- their collection, not only the cards they have on sale. Anyone signed in can tap "Me interesa" on any
-- of those cards or on a card on sale. The owner sees how many people want each card, never who
-- (my_card_interests() only returns counts); each person sees and removes only their own marks.

alter table public.portfolio_items add column if not exists is_public boolean not null default false;
create index if not exists portfolio_items_public_idx on public.portfolio_items (user_id, created_at desc) where is_public;

-- What everyone sees of a public card: never what was paid, the note, the scanned photo or the value
-- history. Deliberately NOT security_invoker, like public_profiles (0001): portfolio_items RLS only
-- shows a person their own cards, and this view shows everyone the public ones (and nothing else).
create or replace view public.public_collection as
  select id, user_id, category, subject, set_name, year, number, variant, catalog_id, grading_company, grade,
         condition, image_url, quantity, value_cents, created_at
  from public.portfolio_items
  where is_public;
grant select on public.public_collection to anon, authenticated;

-- ----------------------------------------------------------------- "Me interesa"
-- One mark per person and card: a public portfolio card or a listing. owner_id is filled in here
-- (whose card it is), so the owner's counts don't need to read anyone's portfolio.
create table if not exists public.card_interests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  owner_id uuid not null references public.profiles on delete cascade,
  portfolio_item_id uuid references public.portfolio_items on delete cascade,
  listing_id uuid references public.listings on delete cascade,
  created_at timestamptz not null default now(),
  constraint card_interests_one_card check (num_nonnulls(portfolio_item_id, listing_id) = 1)
);
create unique index if not exists card_interests_item_uq on public.card_interests (user_id, portfolio_item_id) where portfolio_item_id is not null;
create unique index if not exists card_interests_listing_uq on public.card_interests (user_id, listing_id) where listing_id is not null;
create index if not exists card_interests_owner_idx on public.card_interests (owner_id, created_at desc);
alter table public.card_interests enable row level security;
drop policy if exists "own interests read" on public.card_interests;
create policy "own interests read" on public.card_interests for select using (user_id = auth.uid());
drop policy if exists "own interests insert" on public.card_interests;
create policy "own interests insert" on public.card_interests for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "own interests delete" on public.card_interests;
create policy "own interests delete" on public.card_interests for delete using (user_id = auth.uid());
-- No update policy: a mark is added or removed, never changed.

-- Only cards everyone can see (a public portfolio card or a listing on sale), never your own, up to
-- 1000 marks per person. The owner and the date can't be forged.
create or replace function public.guard_card_interest() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
begin
  if new.portfolio_item_id is not null then
    select user_id into v_owner from public.portfolio_items where id = new.portfolio_item_id and is_public;
  else
    select seller_id into v_owner from public.listings where id = new.listing_id and status = 'active';
  end if;
  if v_owner is null then
    raise exception 'interest: card not available' using errcode = '22023';
  end if;
  if v_owner = new.user_id then
    raise exception 'interest: own card' using errcode = '22023';
  end if;
  if (select count(*) from public.card_interests where user_id = new.user_id) >= 1000 then
    raise exception 'interest: limit 1000' using errcode = '22023';
  end if;
  new.owner_id := v_owner;
  new.created_at := now();
  return new;
end $$;
drop trigger if exists card_interests_guard on public.card_interests;
create trigger card_interests_guard before insert on public.card_interests
  for each row execute function public.guard_card_interest();
revoke all on function public.guard_card_interest() from public, anon, authenticated;

-- The owner's counts: how many different people want any of their cards, and per card how many and
-- when the last one marked it. Never who.
create or replace function public.my_card_interests() returns jsonb
  language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'people', (select count(distinct user_id) from public.card_interests where owner_id = auth.uid()),
    'cards', coalesce((
      select jsonb_agg(jsonb_build_object('portfolio_item_id', c.portfolio_item_id, 'listing_id', c.listing_id,
                                          'people', c.n, 'last_at', c.last_at) order by c.n desc, c.last_at desc)
      from (select portfolio_item_id, listing_id, count(*) as n, max(created_at) as last_at
            from public.card_interests where owner_id = auth.uid()
            group by portfolio_item_id, listing_id) c), '[]'::jsonb))
$$;
revoke all on function public.my_card_interests() from public, anon;
grant execute on function public.my_card_interests() to authenticated;
