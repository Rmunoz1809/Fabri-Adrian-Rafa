-- 0024: lots ("Lote": several cards sold together, e.g. 50 commons of 151). Run once in Supabase ▸
-- SQL Editor after 0023 (safe to re-run). holo.html works before and after it: until it runs, the
-- "Vender un lote" form says it opens soon.
--
-- A lot is one listing with a number of cards (lot_count, 2–5000) and, optionally, an overall
-- condition. It has no grade and no sealed kind. It sells like any listing (one buyer, one order).
alter table public.listings add column if not exists lot_count int check (lot_count between 2 and 5000);

alter table public.listings drop constraint if exists listings_product_type_check;
alter table public.listings add constraint listings_product_type_check check (product_type in ('card', 'sealed', 'lot'));

alter table public.listings drop constraint if exists listings_card_or_sealed;
alter table public.listings drop constraint if exists listings_product_shape;
alter table public.listings add constraint listings_product_shape check (
  case product_type
    when 'card' then (grading_company is not null or condition is not null) and sealed_kind is null and lot_count is null
    when 'sealed' then sealed_kind is not null and grading_company is null and condition is null and lot_count is null
    else lot_count is not null and grading_company is null and sealed_kind is null
  end);
