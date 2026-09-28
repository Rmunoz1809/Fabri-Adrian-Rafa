-- 0013: offers ("Hacer oferta"), public reviews and completed sales. Run once in Supabase ▸ SQL Editor
-- after 0012 (safe to re-run). holo.html works before and after it.
--
-- Offers: a signed-in buyer offers between 60% of the asking price and just under it. The seller
-- accepts, rejects or counters; the buyer accepts or declines a counter, or withdraws. Every change
-- goes through the two functions below, so the rules can't be skipped from the browser.
-- Reviews: only after a Compra Protegida is released (the 0001 policy). The reviewed person can flag
-- a review; staff hide it if it breaks the rules. Shown from the first review.
-- Completed sales: released Compras Protegidas only (a seller can't mark their own sales).

-- ------------------------------------------------------------------ offers
create table if not exists public.offers (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings on delete cascade,
  buyer_id uuid not null references public.profiles on delete cascade,
  seller_id uuid not null references public.profiles on delete cascade,
  amount_cents int not null check (amount_cents > 0),
  counter_cents int check (counter_cents > 0),
  status text not null default 'pending' check (status in ('pending', 'countered', 'accepted', 'rejected', 'withdrawn')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists offers_one_open on public.offers (listing_id, buyer_id) where status in ('pending', 'countered');
create index if not exists offers_seller_idx on public.offers (seller_id, status, updated_at desc);
create index if not exists offers_buyer_idx on public.offers (buyer_id, updated_at desc);
alter table public.offers enable row level security;
drop policy if exists "parties read offers" on public.offers;
create policy "parties read offers" on public.offers for select
  using (buyer_id = auth.uid() or seller_id = auth.uid() or public.is_staff());
-- No insert/update policies: only make_offer() and respond_offer() write.

create or replace function public.make_offer(p_listing uuid, p_amount int) returns public.offers
  language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  l public.listings;
  o public.offers;
begin
  if uid is null then raise exception 'login required' using errcode = '42501'; end if;
  select * into l from public.listings where id = p_listing;
  if not found or l.status <> 'active' then raise exception 'offer: listing not available' using errcode = '22023'; end if;
  if l.seller_id = uid then raise exception 'offer: own listing' using errcode = '22023'; end if;
  if p_amount is null or p_amount < ceil(l.price_cents * 0.6) or p_amount >= l.price_cents then
    raise exception 'offer: out of range' using errcode = '22023';
  end if;
  if (select count(*) from public.offers where buyer_id = uid and status in ('pending', 'countered')) >= 20 then
    raise exception 'offer: too many open offers' using errcode = '22023';
  end if;
  -- A new offer on the same card replaces the open one.
  update public.offers set amount_cents = p_amount, counter_cents = null, status = 'pending', updated_at = now()
   where listing_id = p_listing and buyer_id = uid and status in ('pending', 'countered')
   returning * into o;
  if not found then
    insert into public.offers (listing_id, buyer_id, seller_id, amount_cents)
    values (p_listing, uid, l.seller_id, p_amount) returning * into o;
  end if;
  return o;
end $$;

-- Seller: accept | reject | counter (p_amount between the offer and the asking price).
-- Buyer: withdraw | accept_counter | decline_counter.
create or replace function public.respond_offer(p_offer uuid, p_action text, p_amount int default null) returns public.offers
  language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  o public.offers;
  l public.listings;
begin
  select * into o from public.offers where id = p_offer for update;
  if not found or uid is null or uid not in (o.buyer_id, o.seller_id) then
    raise exception 'offer: not yours' using errcode = '42501';
  end if;
  select * into l from public.listings where id = o.listing_id;
  if uid = o.seller_id and o.status = 'pending' and p_action in ('accept', 'reject', 'counter') then
    if p_action = 'accept' then
      if l.status <> 'active' then raise exception 'offer: listing not available' using errcode = '22023'; end if;
      o.status := 'accepted';
    elsif p_action = 'reject' then
      o.status := 'rejected';
    else
      if p_amount is null or p_amount <= o.amount_cents or p_amount >= l.price_cents then
        raise exception 'offer: counter out of range' using errcode = '22023';
      end if;
      o.status := 'countered'; o.counter_cents := p_amount;
    end if;
  elsif uid = o.buyer_id and p_action = 'withdraw' and o.status in ('pending', 'countered') then
    o.status := 'withdrawn';
  elsif uid = o.buyer_id and o.status = 'countered' and p_action in ('accept_counter', 'decline_counter') then
    if p_action = 'accept_counter' then
      if l.status <> 'active' then raise exception 'offer: listing not available' using errcode = '22023'; end if;
      o.status := 'accepted'; o.amount_cents := o.counter_cents;
    else
      o.status := 'rejected';
    end if;
  else
    raise exception 'offer: action % not allowed now', p_action using errcode = '22023';
  end if;
  update public.offers set status = o.status, amount_cents = o.amount_cents, counter_cents = o.counter_cents, updated_at = now()
   where id = o.id returning * into o;
  return o;
end $$;
revoke all on function public.make_offer(uuid, int) from public, anon;
revoke all on function public.respond_offer(uuid, text, int) from public, anon;
grant execute on function public.make_offer(uuid, int) to authenticated;
grant execute on function public.respond_offer(uuid, text, int) to authenticated;

-- ------------------------------------------------------------------ reviews
alter table public.reviews add column if not exists flagged boolean not null default false;
alter table public.reviews add column if not exists hidden boolean not null default false;
drop policy if exists "reviews readable" on public.reviews;
create policy "reviews readable" on public.reviews for select
  using (not hidden or reviewer_id = auth.uid() or public.is_staff());
drop policy if exists "staff moderate reviews" on public.reviews;
create policy "staff moderate reviews" on public.reviews for update
  using (public.is_staff()) with check (public.is_staff());
-- The 0001 insert policy stays, but a reviewer can't pre-hide or pre-flag their own review.
create or replace function public.guard_review() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin_context() then
    new.flagged := false; new.hidden := false; new.created_at := now();
  end if;
  return new;
end $$;
drop trigger if exists reviews_guard on public.reviews;
create trigger reviews_guard before insert on public.reviews for each row execute function public.guard_review();

create or replace function public.flag_review(p_review uuid) returns void
  language plpgsql security definer set search_path = public as $$
begin
  update public.reviews set flagged = true where id = p_review and reviewee_id = auth.uid();
  if not found then raise exception 'review: not yours' using errcode = '42501'; end if;
end $$;
revoke all on function public.flag_review(uuid) from public, anon;
grant execute on function public.flag_review(uuid) to authenticated;

-- ------------------------------------------------------------------ public seller stats
create or replace view public.seller_stats as
  select p.id as seller_id,
         (select count(*) from public.protected_orders o where o.seller_id = p.id and o.status = 'released')::int as completed_sales,
         (select count(*) from public.reviews r where r.reviewee_id = p.id and not r.hidden)::int as review_count,
         (select round(avg(r.rating), 1) from public.reviews r where r.reviewee_id = p.id and not r.hidden) as avg_rating
  from public.profiles p;
revoke all on public.seller_stats from anon, authenticated;
grant select on public.seller_stats to anon, authenticated;
