-- 0006: mark as sold, report listing, verification photo.
-- Run once in Supabase ▸ SQL Editor after 0005 (safe to re-run).
-- holo.html keeps working before this runs: it falls back when `kind` is missing.

-- ------------------------------------------------ verification photo
-- A photo of the card next to a handwritten "HOLO + date" note proves the seller
-- physically has it (standard practice in card-trading communities).
alter table public.listing_photos
  add column if not exists kind text not null default 'card' check (kind in ('card', 'verification'));
create unique index if not exists listing_photos_one_verification
  on public.listing_photos (listing_id) where kind = 'verification';

-- ------------------------------------------------ reports
create unique index if not exists reports_one_open_per_user
  on public.reports (listing_id, reporter_id) where not resolved;

-- ------------------------------------------------ mark as sold
-- Sellers mark their own listing as sold and (optionally) say the final price.
-- The price only feeds local estimates when it is plausible (30%–300% of the
-- asking price), so a seller can't poison the price data with fake numbers.
-- Returns true when the sale was recorded as a comparable.
create or replace function public.mark_listing_sold(p_listing_id uuid, p_price_cents int default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  l public.listings;
  recorded boolean := false;
begin
  select * into l from public.listings where id = p_listing_id for update;
  if not found or l.seller_id is distinct from auth.uid() then
    raise exception 'not your listing' using errcode = '42501';
  end if;
  if l.status not in ('active', 'reserved') then
    raise exception 'listing is not for sale' using errcode = '22023';
  end if;
  if exists (select 1 from public.protected_orders
             where listing_id = l.id and status in ('awaiting_payment', 'paid', 'verifying', 'delivered')) then
    raise exception 'listing has an open protected order' using errcode = '22023';
  end if;

  update public.listings set status = 'sold' where id = l.id;

  if p_price_cents is not null
     and p_price_cents between greatest(1, l.price_cents * 3 / 10) and l.price_cents * 3 then
    insert into public.sales (listing_id, catalog_id, grading_key, condition, price_cents, via_protected)
    values (
      l.id, l.catalog_id,
      case when l.grading_company is null then 'raw'
           else l.grading_company || rtrim(rtrim(l.grade::text, '0'), '.') end,
      l.condition, p_price_cents, false
    )
    on conflict do nothing;
    recorded := found;
  end if;
  return recorded;
end $$;
revoke all on function public.mark_listing_sold(uuid, int) from public, anon;
grant execute on function public.mark_listing_sold(uuid, int) to authenticated;
