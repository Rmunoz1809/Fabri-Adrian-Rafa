-- 0016: commission on both sides. Run once in Supabase ▸ SQL Editor after 0015 (safe to re-run).
-- holo.html works before and after it.
--
-- Rule: the buyer pays the price plus 3% (plus 7% ITBMS on it); the seller receives the price minus
-- 3% (plus 7% ITBMS on it). No minimum, no cap. Replaces 0015's seller-only commission.
-- fee_cents / itbms_cents are the buyer's commission again (their meaning before 0015), and the new
-- seller_fee_cents / seller_itbms_cents hold the seller's. Orders from before 0015 had no seller fee.

alter table public.protected_orders
  add column if not exists seller_fee_cents int not null default 0 check (seller_fee_cents >= 0),
  add column if not exists seller_itbms_cents int not null default 0 check (seller_itbms_cents >= 0);

-- Orders opened while 0015 was live charged the seller through fee_cents: move those amounts to
-- the seller columns so every row reads the same way. fee_payer stays only for history.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'protected_orders' and column_name = 'fee_payer') then
    update public.protected_orders
       set seller_fee_cents = fee_cents, seller_itbms_cents = itbms_cents, fee_cents = 0, itbms_cents = 0,
           fee_payer = 'buyer'
     where fee_payer = 'seller';
    alter table public.protected_orders alter column fee_payer set default 'buyer';
  end if;
end $$;

-- Same numbers as quoteProtected() in holo.html and src/lib/fees.ts (half-up rounding, cents).
create or replace function public.protected_quote(p_price int) returns jsonb
  language sql immutable set search_path = public as $$
  with f as (select floor(p_price * 300 / 10000.0 + 0.5)::int as fee),
       t as (select fee, floor(fee * 700 / 10000.0 + 0.5)::int as itbms from f)
  select jsonb_build_object('price', p_price,
                            'fee', fee, 'itbms', itbms, 'total', p_price + fee + itbms,
                            'seller_fee', fee, 'seller_itbms', itbms, 'payout', p_price - fee - itbms)
  from t
$$;

create or replace function public.order_buyer_total(o public.protected_orders) returns int
  language sql immutable set search_path = public as $$
  select o.price_cents + o.fee_cents + o.itbms_cents
$$;
create or replace function public.order_seller_payout(o public.protected_orders) returns int
  language sql immutable set search_path = public as $$
  select o.price_cents - o.seller_fee_cents - o.seller_itbms_cents
$$;
revoke all on function public.order_buyer_total(public.protected_orders) from public, anon;
revoke all on function public.order_seller_payout(public.protected_orders) from public, anon;
grant execute on function public.order_buyer_total(public.protected_orders) to authenticated;
grant execute on function public.order_seller_payout(public.protected_orders) to authenticated;

-- Mi cuenta: buyers see what they pay, sellers what they will receive.
create or replace function public.my_orders() returns table (
  id uuid, role text, listing_id uuid, title text, stage text, amount_cents int,
  created_at timestamptz, paid_at timestamptz, delivered_at timestamptz, claim_deadline timestamptz,
  buyer_confirmed_at timestamptz, claimed_at timestamptz, claim_reason text, claim_outcome text,
  released_at timestamptz, hold_until timestamptz
) language sql stable security definer set search_path = public as $$
  select o.id,
         case when o.buyer_id = auth.uid() then 'buyer' else 'seller' end,
         o.listing_id, l.title, public.order_stage(o),
         case when o.buyer_id = auth.uid() then public.order_buyer_total(o) else public.order_seller_payout(o) end,
         o.created_at, o.paid_at, o.delivered_at, o.delivered_at + interval '3 days',
         o.buyer_confirmed_at, o.claimed_at,
         case when o.buyer_id = auth.uid() then o.claim_reason end, o.claim_outcome,
         o.released_at, o.hold_until
  from public.protected_orders o
  left join public.listings l on l.id = o.listing_id
  where auth.uid() is not null
    and (o.buyer_id = auth.uid() or o.seller_id = auth.uid())
    and not (o.status = 'awaiting_payment' and (o.seller_id = auth.uid() or o.source = 'checkout' and o.hold_until < now()))
    and not (o.status = 'cancelled' and o.paid_at is null)
  order by o.created_at desc
  limit 100
$$;

-- Staff panel: 0014's columns plus the seller's commission (new output columns need drop + create).
drop function if exists public.staff_orders();
create function public.staff_orders() returns table (
  id uuid, listing_id uuid, title text, seller_id uuid, seller_name text, buyer_id uuid, buyer_contact text,
  price_cents int, fee_cents int, itbms_cents int, status text, stage text, source text,
  payment_ref text, payout_ref text, notes text, created_at timestamptz, updated_at timestamptz,
  paid_at timestamptz, delivered_at timestamptz, ready_at timestamptz, buyer_confirmed_at timestamptz,
  claimed_at timestamptz, claim_reason text, claim_photos text[], claim_outcome text, released_at timestamptz,
  payout_phone text, payout_name text, seller_fee_cents int, seller_itbms_cents int
) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  return query
  select o.id, o.listing_id, l.title, o.seller_id, p.display_name, o.buyer_id, o.buyer_contact,
         o.price_cents, o.fee_cents, o.itbms_cents, o.status, public.order_stage(o), o.source,
         o.payment_ref, o.payout_ref, o.notes, o.created_at, o.updated_at,
         o.paid_at, o.delivered_at,
         case when o.buyer_confirmed_at is not null or o.claim_outcome = 'rejected' then coalesce(o.buyer_confirmed_at, o.updated_at)
              else o.delivered_at + interval '3 days' end,
         o.buyer_confirmed_at, o.claimed_at, o.claim_reason, o.claim_photos, o.claim_outcome, o.released_at,
         pa.yappy_phone, pa.holder_name, o.seller_fee_cents, o.seller_itbms_cents
  from public.protected_orders o
  left join public.listings l on l.id = o.listing_id
  left join public.profiles p on p.id = o.seller_id
  left join public.payout_accounts pa on pa.user_id = o.seller_id
  where not (o.source = 'checkout' and o.status = 'awaiting_payment' and o.hold_until < now() - interval '1 day')
  order by o.created_at desc
  limit 300;
end $$;
revoke all on function public.staff_orders() from public, anon;
grant execute on function public.staff_orders() to authenticated;

-- Checkout: both commissions are fixed when the order is opened or refreshed.
create or replace function public.start_checkout(p_listing uuid) returns public.protected_orders
  language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  l public.listings;
  o public.protected_orders;
  price int;
  q jsonb;
begin
  if uid is null then raise exception 'login required' using errcode = '42501'; end if;
  select * into l from public.listings where id = p_listing for update;
  if not found or l.status <> 'active' then raise exception 'checkout: listing not available' using errcode = '22023'; end if;
  if l.seller_id = uid then raise exception 'checkout: own listing' using errcode = '22023'; end if;
  if exists (select 1 from public.protected_orders
             where listing_id = l.id and buyer_id is distinct from uid
               and (status in ('paid', 'verifying', 'delivered')
                    or status = 'awaiting_payment' and source = 'checkout' and hold_until > now())) then
    raise exception 'checkout: listing on hold' using errcode = '22023';
  end if;
  select coalesce((select amount_cents from public.offers
                    where listing_id = l.id and buyer_id = uid and status = 'accepted'
                    order by updated_at desc limit 1), l.price_cents) into price;
  q := public.protected_quote(price);
  update public.protected_orders
     set price_cents = price, fee_cents = (q->>'fee')::int, itbms_cents = (q->>'itbms')::int,
         seller_fee_cents = (q->>'seller_fee')::int, seller_itbms_cents = (q->>'seller_itbms')::int,
         hold_until = now() + interval '15 minutes'
   where listing_id = l.id and buyer_id = uid and status = 'awaiting_payment' and source = 'checkout'
   returning * into o;
  if not found then
    if (select count(*) from public.protected_orders
        where buyer_id = uid and source = 'checkout' and created_at > now() - interval '1 day') >= 20 then
      raise exception 'checkout: too many' using errcode = '22023';
    end if;
    insert into public.protected_orders (listing_id, buyer_id, seller_id, price_cents, fee_cents, itbms_cents,
                                         seller_fee_cents, seller_itbms_cents, status, source, hold_until)
    values (l.id, uid, l.seller_id, price, (q->>'fee')::int, (q->>'itbms')::int,
            (q->>'seller_fee')::int, (q->>'seller_itbms')::int, 'awaiting_payment', 'checkout', now() + interval '15 minutes')
    returning * into o;
  end if;
  return o;
end $$;
revoke all on function public.start_checkout(uuid) from public, anon;
grant execute on function public.start_checkout(uuid) to authenticated;

-- Yappy is asked for the buyer's total: price + commission, with the commission's ITBMS as taxes.
create or replace function public.new_payment_attempt(p_order uuid, p_provider text default 'yappy') returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  o public.protected_orders;
  aid text;
  total int;
begin
  select * into o from public.protected_orders where id = p_order for update;
  if not found or auth.uid() is null or o.buyer_id is distinct from auth.uid() then
    raise exception 'order: not yours' using errcode = '42501';
  end if;
  if o.status <> 'awaiting_payment' or o.source <> 'checkout' or o.hold_until is null or o.hold_until < now() then
    raise exception 'payment: order not payable' using errcode = '22023';
  end if;
  if (select count(*) from public.payment_attempts where order_id = o.id) >= 10 then
    raise exception 'payment: too many attempts' using errcode = '22023';
  end if;
  total := public.order_buyer_total(o);
  aid := 'H' || upper(substr(md5(gen_random_uuid()::text), 1, 14));
  insert into public.payment_attempts (id, order_id, provider, amount_cents) values (aid, o.id, p_provider, total);
  update public.protected_orders set hold_until = greatest(hold_until, now() + interval '10 minutes') where id = o.id;
  return jsonb_build_object('attempt_id', aid, 'subtotal_cents', o.price_cents + o.fee_cents,
                            'taxes_cents', o.itbms_cents, 'total_cents', total);
end $$;
revoke all on function public.new_payment_attempt(uuid, text) from public, anon;
grant execute on function public.new_payment_attempt(uuid, text) to authenticated;
