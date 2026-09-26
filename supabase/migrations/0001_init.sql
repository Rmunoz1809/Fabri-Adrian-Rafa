-- Holo MVP schema. Run in the Supabase SQL editor or with `supabase db push`.
-- Design notes:
--   * categories is a table, so new games/sports are rows, not migrations.
--   * locations are neighborhood-level only; we never store addresses.
--   * money is integer cents (USD).
--   * protected_orders are created by staff during the concierge phase; buyers
--     and sellers can read their own, nobody but staff can write them.

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 40),
  avatar_url text,
  is_shop boolean not null default false,
  verified boolean not null default false,
  is_staff boolean not null default false,
  whatsapp text, -- private: never exposed through the public view
  created_at timestamptz not null default now()
);

-- Public projection without private columns. Deliberately NOT security_invoker:
-- profiles RLS only exposes a user's own row, and this view must show every
-- seller's public fields (and nothing else) to everyone.
create view public.public_profiles as
  select id, display_name, avatar_url, is_shop, verified, created_at from public.profiles;
grant select on public.public_profiles to anon, authenticated;

create function public.is_staff() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select is_staff from public.profiles where id = auth.uid()), false)
$$;

-- Every new auth user gets a profile row.
create function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_name text := left(coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
                             split_part(new.email, '@', 1)), 40);
begin
  if char_length(coalesce(v_name, '')) < 2 then v_name := 'Coleccionista'; end if;
  insert into public.profiles (id, display_name) values (new.id, v_name);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- -------------------------------------------------------------- categories
create table public.categories (
  slug text primary key,
  name text not null,
  kind text not null check (kind in ('tcg', 'sports')),
  sort int not null default 0
);
insert into public.categories (slug, name, kind, sort) values
  ('pokemon', 'Pokémon', 'tcg', 1),
  ('nba', 'NBA', 'sports', 2),
  ('nfl', 'NFL', 'sports', 3);

-- ------------------------------------------------------------ card catalog
create table public.cards (
  id uuid primary key default gen_random_uuid(),
  category text not null references public.categories,
  subject text not null,
  set_name text not null,
  year int,
  number text,
  variant text,
  external_id text, -- e.g. pokemontcg.io id
  image_url text,
  unique (category, external_id)
);
create index cards_search_idx on public.cards using gin ((subject || ' ' || set_name) gin_trgm_ops);

-- ---------------------------------------------------------------- listings
create table public.listings (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.profiles on delete cascade,
  card_id uuid references public.cards,
  category text not null references public.categories,
  title text not null check (char_length(title) between 5 and 80),
  description text check (char_length(description) <= 1000),
  subject text not null,
  set_name text not null,
  year int,
  number text,
  variant text,
  condition text check (condition in ('NM', 'LP', 'MP', 'HP', 'DMG')),
  grading_company text check (grading_company in ('PSA', 'BGS', 'CGC', 'SGC', 'TAG')),
  grade numeric(3, 1) check (grade between 1 and 10),
  cert_number text,
  price_cents int not null check (price_cents > 0 and price_cents <= 10000000),
  province text not null,
  district text not null,
  neighborhood text not null,
  status text not null default 'active' check (status in ('draft', 'active', 'reserved', 'sold', 'removed')),
  protected_eligible boolean not null default false,
  ai_flags jsonb not null default '[]',
  catalog_id text, -- external catalog id, e.g. pokemontcg.io "sv3pt5-199"
  estimate jsonb, -- PriceEstimate computed at publish time
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((grading_company is null) = (grade is null)),
  check (grading_company is not null or condition is not null)
);
create index listings_feed_idx on public.listings (status, created_at desc);
create index listings_cat_idx on public.listings (category, status);
create index listings_search_idx on public.listings
  using gin ((title || ' ' || subject || ' ' || set_name || ' ' || neighborhood) gin_trgm_ops);

create table public.listing_photos (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings on delete cascade,
  storage_path text not null,
  position int not null default 0
);

-- ------------------------------------------------- prices (our own history)
-- External reference snapshots live in supabase/price_snapshots.sql (keyed by
-- catalog_id, filled daily by pg_cron). Run that file after this one.

-- Completed sales in Panama: the local price data nobody else has.
create table public.sales (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references public.listings on delete set null,
  card_id uuid references public.cards,
  catalog_id text,
  grading_key text not null default 'raw', -- 'raw' or e.g. 'PSA10'
  condition text,
  price_cents int not null check (price_cents > 0),
  via_protected boolean not null default false,
  sold_at timestamptz not null default now()
);
create index sales_comp_idx on public.sales (catalog_id, grading_key, sold_at desc);

-- ----------------------------------------------------- protected orders
create table public.protected_orders (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings,
  buyer_id uuid references public.profiles,
  seller_id uuid not null references public.profiles,
  price_cents int not null,
  fee_cents int not null,
  itbms_cents int not null,
  status text not null default 'awaiting_payment' check (status in (
    'awaiting_payment', 'paid', 'verifying', 'delivered', 'released', 'refunded', 'cancelled'
  )),
  payment_ref text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- --------------------------------------------------- reviews & reports
create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.protected_orders,
  reviewer_id uuid not null references public.profiles,
  reviewee_id uuid not null references public.profiles,
  rating int not null check (rating between 1 and 5),
  comment text check (char_length(comment) <= 500),
  created_at timestamptz not null default now()
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references public.listings on delete cascade,
  reporter_id uuid references public.profiles,
  reason text not null check (reason in ('replica', 'estafa', 'precio', 'contenido', 'otro')),
  details text,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

-- --------------------------------------------------------------- RLS
alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.cards enable row level security;
alter table public.listings enable row level security;
alter table public.listing_photos enable row level security;
alter table public.sales enable row level security;
alter table public.protected_orders enable row level security;
alter table public.reviews enable row level security;
alter table public.reports enable row level security;

-- profiles: owners read/update their own full row; staff read all.
-- Everyone else goes through public_profiles (which has no private columns).
create policy "own profile" on public.profiles for select using (id = auth.uid() or public.is_staff());
create policy "insert own profile" on public.profiles for insert with check (id = auth.uid());
create policy "update own profile" on public.profiles for update using (id = auth.uid())
  with check (id = auth.uid());

create policy "categories readable" on public.categories for select using (true);
create policy "cards readable" on public.cards for select using (true);
create policy "sales readable" on public.sales for select using (true);

create policy "active listings readable" on public.listings for select
  using (status in ('active', 'reserved', 'sold') or seller_id = auth.uid() or public.is_staff());
create policy "sellers create listings" on public.listings for insert
  with check (seller_id = auth.uid() and status in ('draft', 'active'));
create policy "sellers edit own listings" on public.listings for update
  using (seller_id = auth.uid() or public.is_staff())
  with check (seller_id = auth.uid() or public.is_staff());
create policy "sellers delete own listings" on public.listings for delete
  using (seller_id = auth.uid() or public.is_staff());

create policy "photos readable" on public.listing_photos for select using (
  exists (select 1 from public.listings l where l.id = listing_id
          and (l.status in ('active', 'reserved', 'sold') or l.seller_id = auth.uid() or public.is_staff()))
);
create policy "sellers add photos" on public.listing_photos for insert with check (
  exists (select 1 from public.listings l where l.id = listing_id and l.seller_id = auth.uid())
);
create policy "sellers delete photos" on public.listing_photos for delete using (
  exists (select 1 from public.listings l where l.id = listing_id and l.seller_id = auth.uid())
);

create policy "parties read orders" on public.protected_orders for select
  using (buyer_id = auth.uid() or seller_id = auth.uid() or public.is_staff());
create policy "staff manage orders" on public.protected_orders for all
  using (public.is_staff()) with check (public.is_staff());

create policy "reviews readable" on public.reviews for select using (true);
create policy "buyers review released orders" on public.reviews for insert with check (
  reviewer_id = auth.uid() and exists (
    select 1 from public.protected_orders o
    where o.id = order_id and o.status = 'released'
      and auth.uid() in (o.buyer_id, o.seller_id)
      and reviewee_id in (o.buyer_id, o.seller_id) and reviewee_id <> auth.uid()
  )
);

create policy "anyone signed in can report" on public.reports for insert
  with check (reporter_id = auth.uid());
create policy "staff read reports" on public.reports for select using (public.is_staff());
create policy "staff resolve reports" on public.reports for update using (public.is_staff());

-- Staff-only writes on reference data.
create policy "staff write cards" on public.cards for all using (public.is_staff()) with check (public.is_staff());
create policy "staff write sales" on public.sales for all using (public.is_staff()) with check (public.is_staff());

-- Column-level REVOKE is a no-op while Supabase's table-level UPDATE grant
-- exists, so privileged columns are guarded with triggers instead.
create function public.guard_profile_flags() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if public.is_staff() then return new; end if;
  if tg_op = 'INSERT' then
    new.is_staff := false;
    new.verified := false;
  elsif new.is_staff is distinct from old.is_staff or new.verified is distinct from old.verified then
    raise exception 'only staff can change is_staff/verified';
  end if;
  return new;
end $$;
create trigger profiles_guard before insert or update on public.profiles
  for each row execute function public.guard_profile_flags();

create function public.guard_listing_flags() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then
    if tg_op = 'INSERT' then
      new.protected_eligible := false;
    elsif new.protected_eligible is distinct from old.protected_eligible
       or new.seller_id is distinct from old.seller_id then
      raise exception 'only staff can change protected_eligible/seller_id';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger listings_guard before insert or update on public.listings
  for each row execute function public.guard_listing_flags();

-- --------------------------------------------------------------- storage
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('listing-photos', 'listing-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Uploads go under "<user id>/..." so users can only write to their own folder.
create policy "users upload own photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'listing-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "users delete own photos" on storage.objects for delete to authenticated
  using (bucket_id = 'listing-photos' and (storage.foldername(name))[1] = auth.uid()::text);
