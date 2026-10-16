-- 0033: "Mi portafolio". Run once in Supabase ▸ SQL Editor (safe to re-run; only needs 0001's profiles).
-- holo.html works before and after it: until it runs, the portfolio is kept in the person's browser.
--
-- A signed-in person keeps the cards they own without publishing them: from "¿Cuánto vale tu carta?"
-- they tap "Guardar en mi portafolio". The page shows what each one is worth today (same price
-- sources as the listing page) and what it sells for on MarketZlab. Private: only the owner reads it.
-- Each card keeps the photo that was scanned (private bucket "portfolio-photos", "<user id>/..."), so
-- it works as a sale draft: "Vender" opens #/vender with that photo already loaded.

create table if not exists public.portfolio_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  category text not null default 'pokemon' check (category in ('pokemon', 'nba', 'nfl')),
  subject text not null check (char_length(subject) between 1 and 120),
  set_name text check (char_length(set_name) <= 120),
  year text check (char_length(year) <= 10),
  number text check (char_length(number) <= 40),
  variant text check (char_length(variant) <= 80),
  catalog_id text check (char_length(catalog_id) <= 64),
  grading_company text check (grading_company in ('PSA', 'BGS', 'CGC', 'SGC', 'TAG')),
  grade numeric(3, 1) check (grade between 1 and 10),
  condition text check (condition in ('NM', 'LP', 'MP', 'HP', 'DMG')),
  image_url text check (image_url ~ '^https://' and char_length(image_url) <= 500),
  photo_path text check (char_length(photo_path) <= 200),
  quantity int not null default 1 check (quantity between 1 and 999),
  paid_cents int check (paid_cents between 0 and 100000000),
  value_cents int check (value_cents between 0 and 100000000), -- last value the page saw
  value_at timestamptz,
  note text check (char_length(note) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- The photo path must sit in the owner's folder (same rule as profile photos, 0004).
alter table public.portfolio_items drop constraint if exists portfolio_photo_own_folder;
alter table public.portfolio_items add constraint portfolio_photo_own_folder
  check (photo_path is null or (photo_path like user_id::text || '/%' and photo_path not like '%..%'));
create index if not exists portfolio_items_user_idx on public.portfolio_items (user_id, created_at desc);
alter table public.portfolio_items enable row level security;
drop policy if exists "own portfolio read" on public.portfolio_items;
create policy "own portfolio read" on public.portfolio_items for select using (user_id = auth.uid());
drop policy if exists "own portfolio insert" on public.portfolio_items;
create policy "own portfolio insert" on public.portfolio_items for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "own portfolio update" on public.portfolio_items;
create policy "own portfolio update" on public.portfolio_items for update using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own portfolio delete" on public.portfolio_items;
create policy "own portfolio delete" on public.portfolio_items for delete using (user_id = auth.uid());

-- Up to 500 cards per account; the owner and dates can't be forged.
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
  end if;
  new.subject := left(trim(regexp_replace(new.subject, '\s+', ' ', 'g')), 120);
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists portfolio_items_guard on public.portfolio_items;
create trigger portfolio_items_guard before insert or update on public.portfolio_items
  for each row execute function public.guard_portfolio_item();
revoke all on function public.guard_portfolio_item() from public, anon, authenticated;

-- ----------------------------------------------------------------- storage (private)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('portfolio-photos', 'portfolio-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
drop policy if exists "users upload own portfolio photos" on storage.objects;
create policy "users upload own portfolio photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'portfolio-photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "users read own portfolio photos" on storage.objects;
create policy "users read own portfolio photos" on storage.objects for select to authenticated
  using (bucket_id = 'portfolio-photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "users delete own portfolio photos" on storage.objects;
create policy "users delete own portfolio photos" on storage.objects for delete to authenticated
  using (bucket_id = 'portfolio-photos' and (storage.foldername(name))[1] = auth.uid()::text);
