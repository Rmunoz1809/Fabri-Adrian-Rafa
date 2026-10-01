-- 0027: several units per listing and preorders ("Preventa"). Run once in Supabase ▸ SQL Editor after
-- 0026 (safe to re-run). holo.html works before and after it.
--
-- Verified shops can sell sealed product with a quantity (e.g. 20 ETBs) and as a preorder with a
-- release date: buyers pay now with Compra Protegida, Holo keeps the money and the shop delivers when
-- the product comes out (the 3-day window starts at delivery, as always). Each paid order takes one
-- unit; the listing is "reserved" only when every unit is taken and "sold" when every unit is paid
-- out. With quantity 1 (every card) everything works exactly as before. The checkout and staff
-- functions below are the 0014/0016 versions with the listing updates moved into three helpers.

alter table public.listings
  add column if not exists quantity int not null default 1 check (quantity between 1 and 500),
  add column if not exists release_date date;

-- ------------------------------------------------------------------ units
create or replace function public.listing_units_taken(p_listing uuid) returns int
  language sql stable security definer set search_path = public as $$
  select count(*)::int from public.protected_orders
   where listing_id = p_listing and status in ('paid', 'verifying', 'delivered', 'released')
$$;
create or replace function public.listing_after_paid(p_listing uuid) returns void
  language sql security definer set search_path = public as $$
  update public.listings set status = 'reserved'
   where id = p_listing and status = 'active' and public.listing_units_taken(id) >= quantity
$$;
create or replace function public.listing_after_release(p_listing uuid) returns void
  language sql security definer set search_path = public as $$
  update public.listings set status = 'sold'
   where id = p_listing and status in ('active', 'reserved')
     and (select count(*) from public.protected_orders where listing_id = p_listing and status = 'released') >= quantity
$$;
create or replace function public.listing_after_refund(p_listing uuid) returns void
  language sql security definer set search_path = public as $$
  update public.listings set status = 'active'
   where id = p_listing and status = 'reserved' and public.listing_units_taken(id) < quantity
$$;

-- Only verified shops, only sealed product; a release date from today up to a year ahead.
create or replace function public.guard_listing_stock() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.quantity = 1 and new.release_date is null then return new; end if;
  if tg_op = 'UPDATE' and new.quantity is not distinct from old.quantity and new.release_date is not distinct from old.release_date then
    return new;
  end if;
  if public.is_admin_context() then return new; end if;
  if new.product_type <> 'sealed' then
    raise exception 'stock: only sealed product can have a quantity or a preorder' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = new.seller_id and is_shop and verified) then
    raise exception 'stock: only verified shops' using errcode = '42501';
  end if;
  if new.release_date is not null and (new.release_date < (now() at time zone 'America/Panama')::date
       or new.release_date > (now() at time zone 'America/Panama')::date + 366) then
    raise exception 'stock: release date' using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists listings_stock_guard on public.listings;
create trigger listings_stock_guard before insert or update of quantity, release_date on public.listings
  for each row execute function public.guard_listing_stock();

-- Public: how many units are left (counts only, never who bought).
create or replace view public.listing_stock as
  select l.id as listing_id, l.quantity, public.listing_units_taken(l.id) as taken
    from public.listings l
   where l.quantity > 1 and l.status in ('active', 'reserved', 'sold');
revoke all on public.listing_stock from anon, authenticated;
grant select on public.listing_stock to anon, authenticated;

-- ------------------------------------------------------------------ checkout, staff and payment notices
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
  -- Units paid for (by anyone) plus other buyers' live checkouts: none left means on hold / sold out.
  if public.listing_units_taken(l.id)
     + (select count(*) from public.protected_orders
         where listing_id = l.id and buyer_id is distinct from uid
           and status = 'awaiting_payment' and source = 'checkout' and hold_until > now()) >= l.quantity then
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

create or replace function public.staff_order_action(p_order uuid, p_action text, p_ref text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  o public.protected_orders;
  l public.listings;
  ref text := nullif(left(trim(coalesce(p_ref, '')), 120), '');
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  select * into o from public.protected_orders where id = p_order for update;
  if not found then raise exception 'order: not found' using errcode = '22023'; end if;
  select * into l from public.listings where id = o.listing_id for update;

  if p_action = 'mark_paid' and o.status = 'awaiting_payment' then
    update public.protected_orders set status = 'paid', paid_at = now(), hold_until = null,
           payment_ref = coalesce(ref, payment_ref) where id = o.id;
    perform public.listing_after_paid(o.listing_id);

  elsif p_action = 'mark_delivered' and o.status in ('paid', 'verifying') and o.claimed_at is null then
    update public.protected_orders set status = 'delivered', delivered_at = now() where id = o.id;

  elsif p_action = 'buyer_confirmed' and o.status in ('paid', 'verifying', 'delivered')
        and o.buyer_confirmed_at is null and (o.claimed_at is null or o.claim_outcome is not null) then
    update public.protected_orders set status = 'delivered', delivered_at = coalesce(delivered_at, now()),
           buyer_confirmed_at = now() where id = o.id;

  elsif p_action = 'reject_claim' and o.claimed_at is not null and o.claim_outcome is null
        and o.status in ('paid', 'verifying', 'delivered') then
    update public.protected_orders set claim_outcome = 'rejected', status = 'delivered',
           delivered_at = coalesce(delivered_at, now()),
           notes = left(concat_ws(E'\n', notes, 'Reclamo rechazado: ' || ref), 500) where id = o.id;

  elsif p_action = 'release' and public.order_ready_to_pay(o) then
    update public.protected_orders set status = 'released', released_at = now(),
           payout_ref = coalesce(ref, payout_ref) where id = o.id;
    perform public.listing_after_release(o.listing_id);
    -- The local Panama price data behind the estimates (one row per listing).
    insert into public.sales (listing_id, catalog_id, grading_key, condition, price_cents, via_protected)
    values (o.listing_id, l.catalog_id,
            case when l.grading_company is null then 'raw'
                 else l.grading_company || rtrim(rtrim(l.grade::text, '0'), '.') end,
            l.condition, o.price_cents, true)
    on conflict do nothing;

  elsif p_action = 'refund' and o.status in ('paid', 'verifying', 'delivered') then
    update public.protected_orders set status = 'refunded', hold_until = null,
           claim_outcome = case when claimed_at is not null then 'refunded' else claim_outcome end,
           notes = case when ref is null then notes else left(concat_ws(E'\n', notes, 'Reembolso: ' || ref), 500) end
     where id = o.id;
    perform public.listing_after_refund(o.listing_id);

  elsif p_action = 'cancel' and o.status = 'awaiting_payment' then
    update public.protected_orders set status = 'cancelled', hold_until = null where id = o.id;

  else
    raise exception 'order: action % not allowed in stage %', p_action, public.order_stage(o) using errcode = '22023';
  end if;
end $function$;

create or replace function public.confirm_payment(p_attempt text, p_status text, p_confirmation text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  a public.payment_attempts;
  o public.protected_orders;
begin
  if p_status not in ('executed', 'rejected', 'cancelled', 'expired') then
    raise exception 'payment: bad status' using errcode = '22023';
  end if;
  select * into a from public.payment_attempts where id = p_attempt for update;
  if not found then return 'unknown attempt'; end if;
  if a.status = 'executed' then return 'already executed'; end if;
  update public.payment_attempts set status = p_status, confirmation = left(p_confirmation, 120) where id = a.id;
  if p_status <> 'executed' then return 'noted'; end if;

  select * into o from public.protected_orders where id = a.order_id for update;
  -- A checkout that expired while the buyer was still paying (hold_until is kept) is revived.
  if o.status = 'awaiting_payment' or (o.status = 'cancelled' and o.source = 'checkout' and o.hold_until is not null) then
    update public.protected_orders
       set status = 'paid', paid_at = now(), hold_until = null,
           payment_ref = left(initcap(a.provider) || ' ' || coalesce(p_confirmation, '') || ' (' || a.id || ')', 120)
     where id = o.id;
    -- Sold out or no longer for sale (counting this payment): flag it for a refund.
    if not exists (select 1 from public.listings l where l.id = o.listing_id and l.status = 'active'
                   and public.listing_units_taken(l.id) <= l.quantity) then
      update public.protected_orders
         set notes = left(concat_ws(E'\n', notes, 'ATENCIÓN: pago recibido pero la carta ya no estaba disponible. Reembolsar.'), 500)
       where id = o.id;
    else
      perform public.listing_after_paid(o.listing_id);
    end if;
    return 'paid';
  end if;
  -- Money arrived for an order that is no longer waiting for it (cancelled, or paid twice).
  update public.protected_orders
     set notes = left(concat_ws(E'\n', notes, 'ATENCIÓN: pago extra recibido (' || a.id || ', ' || coalesce(p_confirmation, '') || '). Reembolsar.'), 500)
   where id = o.id;
  return 'needs refund';
end $function$;

-- listing_stock calls it with the viewer's rights (Postgres rule for functions in views): it only returns a count.
revoke all on function public.listing_units_taken(uuid) from public;
grant execute on function public.listing_units_taken(uuid) to anon, authenticated;
revoke all on function public.listing_after_paid(uuid) from public, anon, authenticated;
revoke all on function public.listing_after_release(uuid) from public, anon, authenticated;
revoke all on function public.listing_after_refund(uuid) from public, anon, authenticated;
revoke all on function public.guard_listing_stock() from public, anon, authenticated;
