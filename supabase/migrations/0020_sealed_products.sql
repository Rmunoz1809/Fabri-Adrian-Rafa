-- 0020: sealed product (booster boxes, ETBs, packs, tins, hobby/blaster boxes). Run once in Supabase ▸
-- SQL Editor after 0019 (safe to re-run). holo.html works before and after it: until it runs, the
-- "Producto sellado" form says it opens soon and every listing reads as a card.
--
-- A listing is now a card (as before) or a sealed product. A sealed product has no condition and no
-- grade, only its kind; it must be factory sealed (Términos: reselled or opened product is forbidden).
alter table public.listings
  add column if not exists product_type text not null default 'card' check (product_type in ('card', 'sealed')),
  add column if not exists sealed_kind text check (sealed_kind in (
    'booster_box', 'etb', 'booster_bundle', 'booster_pack', 'tin', 'collection', 'hobby_box', 'blaster', 'other'));

-- 0001 required a condition or a grade on every listing; that rule now applies to cards only.
alter table public.listings drop constraint if exists listings_check1;
alter table public.listings drop constraint if exists listings_card_or_sealed;
alter table public.listings add constraint listings_card_or_sealed check (
  case product_type
    when 'card' then (grading_company is not null or condition is not null) and sealed_kind is null
    else sealed_kind is not null and grading_company is null and condition is null
  end);

create index if not exists listings_type_idx on public.listings (product_type, status);
