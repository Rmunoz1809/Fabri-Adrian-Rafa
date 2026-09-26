-- 0010: security fixes between users (review of 2026-09-26). Run once in Supabase ▸ SQL Editor
-- after 0009 (safe to re-run). holo.html works before and after it.
--
-- 1. CRITICAL: public_profiles and verified_shops are views that run with the owner's rights (so they
--    skip RLS on profiles), they are auto-updatable, and Supabase's default privileges grant ALL on new
--    objects to anon and authenticated. Anyone with the public key could UPDATE or DELETE any profile
--    through them: mark themselves "Tienda verificada", rename other users, or delete a profile together
--    with all its listings. The views stay readable; every write privilege on them is revoked.
-- 2. is_admin_context() treated every request without a user id as an admin, anonymous visitors
--    included. Only the SQL editor (no JWT) and the service role count as admin now.
-- 3. Listings: sellers could reactivate a listing that staff removed, set their own listing to
--    "reserved", change the price during a Compra Protegida, revive a sold listing, pin a listing to the
--    top with a future created_at, or store a made-up estimate. Status changes now follow the flow below.
-- 4. Protected orders carried the buyer's name and WhatsApp (buyer_contact) and sellers could read it,
--    against the rule that every contact goes through the platform. Only staff (and the buyer) read orders.
-- 5. Listing photo rows must point inside the seller's own Storage folder.
-- 6. Profiles: created_at ("En Holo desde…") can no longer be backdated, the legacy free-URL avatar_url
--    column is no longer writable by users, and a sign-up without a name never shows the e-mail prefix.
-- 7. The grading-from-photo check (0009) lets the SQL editor correct a grade, like every other guard.
-- 8. price_research_log: per-user daily cap for paid web price research (Edge Function identificar-carta).

-- ------------------------------------------------------------------ 1. read-only public views
revoke insert, update, delete, truncate, references, trigger on public.public_profiles from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.verified_shops from anon, authenticated;
grant select on public.public_profiles, public.verified_shops to anon, authenticated;

-- ------------------------------------------------------------------ 2. admin context
-- The SQL editor sends no JWT (auth.role() is null); the Edge Function uses the service role.
-- Requests from the site always carry a role: 'anon' for visitors, 'authenticated' for users.
create or replace function public.is_admin_context() returns boolean
  language sql stable as $$
  select (auth.uid() is null and coalesce(auth.role(), 'service_role') = 'service_role') or public.is_staff()
$$;
revoke execute on function public.is_admin_context() from public, anon, authenticated;

-- ------------------------------------------------------------------ 3. listings
-- A stored estimate is only a hint shown to buyers, so it is cleaned instead of rejected: known keys only,
-- sane numbers, and never more than 3x the asking price (the case that fakes a "Buen precio" badge).
create or replace function public.clean_estimate(e jsonb, price_cents int) returns jsonb
  language plpgsql immutable set search_path = public as $$
declare
  lo numeric; mi numeric; hi numeric; price numeric := price_cents / 100.0;
  basis jsonb := '[]'::jsonb; item jsonb;
begin
  if e is null or jsonb_typeof(e) <> 'object' then return null; end if;
  if jsonb_typeof(e->'low') <> 'number' or jsonb_typeof(e->'mid') <> 'number' or jsonb_typeof(e->'high') <> 'number' then return null; end if;
  lo := (e->>'low')::numeric; mi := (e->>'mid')::numeric; hi := (e->>'high')::numeric;
  if not (lo > 0 and lo <= mi and mi <= hi and hi <= 1000000) then return null; end if;
  if price > 0 and mi > price * 3 then return null; end if;
  if jsonb_typeof(e->'basis') = 'array' then
    for item in select value from jsonb_array_elements(e->'basis') limit 5 loop
      if jsonb_typeof(item) = 'string' then basis := basis || to_jsonb(left(item #>> '{}', 200)); end if;
    end loop;
  end if;
  return jsonb_build_object(
    'low', lo, 'mid', mi, 'high', hi, 'currency', 'USD',
    'confidence', case when e->>'confidence' in ('alta', 'media', 'baja') then e->>'confidence' else 'baja' end,
    'basis', basis,
    'source', left(coalesce(e->>'source', ''), 20),
    'updatedAt', left(coalesce(e->>'updatedAt', ''), 40));
end $$;

-- Seller status flow (staff, the SQL editor and the service role can do anything):
--   draft  → active | removed          publish, or drop a draft
--   active → sold | removed            mark sold (not while a Compra Protegida is open), or withdraw
--   sold   → removed                   hide a sold card; nothing else of a sold listing changes
--   reserved, removed                  frozen: a paid Compra Protegida, or taken down by staff
create or replace function public.guard_listing_flags() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  next_status text;
begin
  if not public.is_admin_context() then
    if tg_op = 'INSERT' then
      new.protected_eligible := false;
      new.created_at := now();
      new.estimate := public.clean_estimate(new.estimate, new.price_cents);
    else
      if new.protected_eligible is distinct from old.protected_eligible
         or new.seller_id is distinct from old.seller_id then
        raise exception 'only staff can change protected_eligible/seller_id' using errcode = '42501';
      end if;
      if old.status in ('reserved', 'removed') then
        raise exception 'listing_locked: this listing is % and only staff can change it', old.status using errcode = '42501';
      end if;
      if new.status is distinct from old.status and not (
           (old.status = 'draft' and new.status in ('active', 'removed'))
        or (old.status = 'active' and new.status in ('sold', 'removed'))
        or (old.status = 'sold' and new.status = 'removed')) then
        raise exception 'listing_status: % → % is not allowed', old.status, new.status using errcode = '42501';
      end if;
      if new.status = 'sold' and old.status <> 'sold' and exists (
           select 1 from public.protected_orders
           where listing_id = old.id and status in ('awaiting_payment', 'paid', 'verifying', 'delivered')) then
        raise exception 'listing has an open protected order' using errcode = '22023';
      end if;
      if old.status = 'sold' then
        next_status := new.status;
        new := old; -- a sold listing keeps its data; only its visibility changes
        new.status := next_status;
      end if;
      new.created_at := old.created_at;
      if new.estimate is distinct from old.estimate or new.price_cents is distinct from old.price_cents then
        new.estimate := public.clean_estimate(new.estimate, new.price_cents);
      end if;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

-- ------------------------------------------------------------------ 4. protected orders
drop policy if exists "parties read orders" on public.protected_orders;
drop policy if exists "staff and buyer read orders" on public.protected_orders;
create policy "staff and buyer read orders" on public.protected_orders for select
  using (public.is_staff() or buyer_id = auth.uid());

-- ------------------------------------------------------------------ 5. listing photos
drop policy if exists "sellers add photos" on public.listing_photos;
create policy "sellers add photos" on public.listing_photos for insert with check (
  exists (select 1 from public.listings l where l.id = listing_id and l.seller_id = auth.uid())
  and storage_path like auth.uid()::text || '/%'
  and storage_path not like '%..%'
);

-- ------------------------------------------------------------------ 6. profiles
create or replace function public.guard_profile_flags() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin_context() then return new; end if;
  if tg_op = 'INSERT' then
    new.is_staff := false;
    new.verified := false;
    new.is_shop := false;
    new.created_at := now();
    new.avatar_url := null;
  else
    if new.is_staff is distinct from old.is_staff
       or new.verified is distinct from old.verified
       or new.is_shop is distinct from old.is_shop then
      raise exception 'only staff can change is_staff/verified/is_shop' using errcode = '42501';
    end if;
    new.created_at := old.created_at; -- "En Holo desde…" is public and must not be backdated
    new.avatar_url := old.avatar_url; -- legacy free URL; profile photos go through avatar_path
  end if;
  return new;
end $$;

-- A sign-up without a display name never shows part of the e-mail address.
create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_name text := left(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), 40);
begin
  if char_length(coalesce(v_name, '')) < 2 then v_name := 'Coleccionista'; end if;
  insert into public.profiles (id, display_name) values (new.id, v_name);
  return new;
end $$;

-- ------------------------------------------------------------------ 7. grading from photo
create or replace function public.enforce_grading_from_photo() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  d public.grading_detections;
begin
  if new.grading_company is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.grading_company is not distinct from old.grading_company
     and new.grade is not distinct from old.grade
     and new.cert_number is not distinct from old.cert_number then
    return new;
  end if;
  -- Staff, the SQL editor and internal processes can correct a grade.
  if public.is_admin_context() then
    return new;
  end if;
  select * into d from public.grading_detections
   where user_id = new.seller_id
     and grading_company = new.grading_company
     and grade = new.grade
     and detected_at > now() - interval '24 hours'
   order by detected_at desc
   limit 1;
  if not found then
    raise exception 'grading_from_photo: la graduación tiene que verse en la foto del slab'
      using errcode = 'P0001';
  end if;
  new.cert_number := d.cert_number;
  return new;
end;
$$;
revoke all on function public.enforce_grading_from_photo() from public, anon, authenticated;

-- ------------------------------------------------------------------ 8. price research log
-- One row per paid web price research, written by the Edge Function with the service role.
-- No policies: nobody else can read or write it.
create table if not exists public.price_research_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists price_research_log_user_idx on public.price_research_log (user_id, created_at desc);
alter table public.price_research_log enable row level security;
revoke all on public.price_research_log from anon, authenticated;
