-- 0032: Watchlist ("Mi watchlist", #/watchlist). Run once in Supabase ▸ SQL Editor (safe to re-run;
-- it only needs 0001's profiles and categories, so it does not depend on 0031).
-- holo.html works before and after it: until it runs, the watchlist lives in the browser
-- (localStorage) and is uploaded to the account once this table exists and the person signs in.
--
-- Each person keeps a list of the cards they want, including cards nobody has published yet: a
-- printing from the catalog (catalog_id) or, for sports cards, the text they typed ("Wembanyama
-- Prizm 2023"), raw or graded. The page checks each card against the active listings (catalog_id,
-- else name + number) and shows either the listing ("Disponibles en MarketZlab") or a listing-like
-- card with a reference price ("Todavía no están en la web"). It replaces "Busco…" (0022) on the
-- page; 0022's tables stay as they are.

create table if not exists public.watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles on delete cascade,
  category text references public.categories,                               -- null: typed by hand, unknown
  catalog_id text check (char_length(catalog_id) between 1 and 64),          -- pokemontcg.io id, e.g. sv3pt5-199
  name text not null check (char_length(name) between 2 and 120),
  set_name text check (char_length(set_name) <= 120),
  number text check (char_length(number) <= 40),
  variant text check (char_length(variant) <= 80),
  image_url text check (char_length(image_url) <= 500 and image_url ~ '^https://'),
  graded boolean not null default false,
  grading_company text check (grading_company in ('PSA', 'BGS', 'CGC', 'SGC', 'TAG')),
  grade numeric(3, 1) check (grade between 1 and 10),
  ref_price_cents int check (ref_price_cents between 1 and 100000000),       -- market reference, refreshed by the page
  ref_price_at timestamptz,
  created_at timestamptz not null default now(),
  check (graded or (grading_company is null and grade is null))
);
create index if not exists watchlist_user_idx on public.watchlist (user_id, created_at desc);
-- One row per card, raw or graded, and person: by catalog id, or by name + number when typed by hand.
create unique index if not exists watchlist_card_uidx
  on public.watchlist (user_id, coalesce(catalog_id, lower(name) || '#' || coalesce(lower(number), '')), graded);

alter table public.watchlist enable row level security;
drop policy if exists "own watchlist read" on public.watchlist;
create policy "own watchlist read" on public.watchlist for select to authenticated using (user_id = auth.uid());
drop policy if exists "own watchlist insert" on public.watchlist;
create policy "own watchlist insert" on public.watchlist for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "own watchlist update" on public.watchlist;
create policy "own watchlist update" on public.watchlist for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own watchlist delete" on public.watchlist;
create policy "own watchlist delete" on public.watchlist for delete to authenticated using (user_id = auth.uid());
revoke all on public.watchlist from anon;
grant select, insert, update, delete on public.watchlist to authenticated;

-- Up to 100 cards per account; text is trimmed. An update only refreshes the reference price: the
-- card itself (and its owner) can't be swapped.
create or replace function public.guard_watchlist() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.id := old.id; new.user_id := old.user_id; new.category := old.category; new.catalog_id := old.catalog_id;
    new.name := old.name; new.set_name := old.set_name; new.number := old.number; new.variant := old.variant;
    new.image_url := old.image_url; new.graded := old.graded; new.grading_company := old.grading_company;
    new.grade := old.grade; new.created_at := old.created_at;
    return new;
  end if;
  new.name := left(regexp_replace(trim(new.name), '\s+', ' ', 'g'), 120);
  new.set_name := nullif(left(regexp_replace(trim(coalesce(new.set_name, '')), '\s+', ' ', 'g'), 120), '');
  new.number := nullif(left(trim(coalesce(new.number, '')), 40), '');
  new.variant := nullif(left(trim(coalesce(new.variant, '')), 80), '');
  new.catalog_id := nullif(trim(coalesce(new.catalog_id, '')), '');
  new.created_at := now();
  if (select count(*) from public.watchlist where user_id = new.user_id) >= 100 then
    raise exception 'watchlist: limit 100' using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists watchlist_guard on public.watchlist;
create trigger watchlist_guard before insert or update on public.watchlist for each row execute function public.guard_watchlist();
