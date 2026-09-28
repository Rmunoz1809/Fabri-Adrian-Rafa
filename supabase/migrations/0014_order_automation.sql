-- 0014: Compra Protegida runs itself, ready for the Yappy payment button. Run once in
-- Supabase ▸ SQL Editor after 0013 (safe to re-run). holo.html works before and after it.
--
-- What changes:
--   * Buyers see their orders in Mi cuenta and press "Ya recibí mi carta" or "Tengo un problema"
--     (a claim with photos). Sellers see their paid sales and press "Ya la entregué".
--   * The 3-day claim window starts when the card is marked delivered. After it (or as soon as the
--     buyer confirms) the order is "ready to pay" and shows up in the staff panel's payout list.
--   * Every order step is one function, so the order, the listing and the sale record can't get
--     out of step, and nobody can skip a rule from the browser.
--   * Checkout: a signed-in buyer opens an order with the exact amounts computed here (the listing
--     price or their accepted offer, plus the fee). The yappy-pago Edge Function creates a payment
--     attempt and, when Yappy notifies the payment, marks the order paid with the service role.
--     Until Yappy is connected, staff keep creating orders and marking them paid by hand.
-- Sellers still never see the buyer's contact: staff coordinate the delivery (0010).

-- ------------------------------------------------------------------ order columns
alter table public.protected_orders
  add column if not exists source text not null default 'staff' check (source in ('staff', 'checkout')),
  add column if not exists hold_until timestamptz,          -- checkout: the card is held while the buyer pays
  add column if not exists paid_at timestamptz,
  add column if not exists delivered_at timestamptz,        -- starts the 3-day claim window
  add column if not exists buyer_confirmed_at timestamptz,  -- "Ya recibí mi carta": ends the window early
  add column if not exists claimed_at timestamptz,          -- "Tengo un problema"
  add column if not exists claim_reason text check (char_length(claim_reason) <= 1000),
  add column if not exists claim_photos text[] not null default '{}' check (cardinality(claim_photos) <= 4),
  add column if not exists claim_outcome text check (claim_outcome in ('refunded', 'rejected')),
  add column if not exists released_at timestamptz,
  add column if not exists payout_ref text check (char_length(payout_ref) <= 120);
create index if not exists protected_orders_buyer_idx on public.protected_orders (buyer_id, created_at desc);
create index if not exists protected_orders_seller_idx on public.protected_orders (seller_id, created_at desc);

-- Same numbers as quoteProtected() in holo.html and src/lib/fees.ts: 4% (half-up), min $1,
-- max $40, plus 7% ITBMS on the fee (half-up). Amounts in cents.
create or replace function public.protected_quote(p_price int) returns jsonb
  language sql immutable set search_path = public as $$
  with f as (select least(4000, greatest(100, floor(p_price * 400 / 10000.0 + 0.5)::int)) as fee)
  select jsonb_build_object('price', p_price, 'fee', fee, 'itbms', floor(fee * 700 / 10000.0 + 0.5)::int,
                            'total', p_price + fee + floor(fee * 700 / 10000.0 + 0.5)::int)
  from f
$$;

-- When the seller can be paid: delivered, no open claim, and the buyer confirmed, staff rejected
-- the claim, or 3 days went by.
create or replace function public.order_ready_to_pay(o public.protected_orders) returns boolean
  language sql stable set search_path = public as $$
  select o.status = 'delivered'
     and (o.claimed_at is null or o.claim_outcome = 'rejected')
     and (o.buyer_confirmed_at is not null or o.claim_outcome = 'rejected'
          or o.delivered_at + interval '3 days' <= now())
$$;

-- One word for the page: awaiting_payment, paid, delivered, claim, ready, released, refunded, cancelled.
create or replace function public.order_stage(o public.protected_orders) returns text
  language sql stable set search_path = public as $$
  select case
    when o.status in ('released', 'refunded', 'cancelled', 'awaiting_payment') then o.status
    when o.claimed_at is not null and o.claim_outcome is null then 'claim'
    when public.order_ready_to_pay(o) then 'ready'
    when o.status = 'delivered' then 'delivered'
    else 'paid' -- paid, or 'verifying' on old orders
  end
$$;

-- ------------------------------------------------------------------ Mi cuenta: my purchases and sales
-- Buyers get their totals; sellers get what they will receive, never the buyer's contact.
create or replace function public.my_orders() returns table (
  id uuid, role text, listing_id uuid, title text, stage text, amount_cents int,
  created_at timestamptz, paid_at timestamptz, delivered_at timestamptz, claim_deadline timestamptz,
  buyer_confirmed_at timestamptz, claimed_at timestamptz, claim_reason text, claim_outcome text,
  released_at timestamptz, hold_until timestamptz
) language sql stable security definer set search_path = public as $$
  select o.id,
         case when o.buyer_id = auth.uid() then 'buyer' else 'seller' end,
         o.listing_id, l.title, public.order_stage(o),
         case when o.buyer_id = auth.uid() then o.price_cents + o.fee_cents + o.itbms_cents else o.price_cents end,
         o.created_at, o.paid_at, o.delivered_at, o.delivered_at + interval '3 days',
         o.buyer_confirmed_at, o.claimed_at,
         case when o.buyer_id = auth.uid() then o.claim_reason end, o.claim_outcome,
         o.released_at, o.hold_until
  from public.protected_orders o
  left join public.listings l on l.id = o.listing_id
  where auth.uid() is not null
    and (o.buyer_id = auth.uid() or o.seller_id = auth.uid())
    -- a checkout the buyer never paid is noise after its hold ends; sellers only see paid orders
    and not (o.status = 'awaiting_payment' and (o.seller_id = auth.uid() or o.source = 'checkout' and o.hold_until < now()))
    and not (o.status = 'cancelled' and o.paid_at is null)
  order by o.created_at desc
  limit 100
$$;

-- ------------------------------------------------------------------ buyer and seller actions
create or replace function public.seller_mark_delivered(p_order uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare o public.protected_orders;
begin
  select * into o from public.protected_orders where id = p_order for update;
  if not found or auth.uid() is null or o.seller_id <> auth.uid() then
    raise exception 'order: not yours' using errcode = '42501';
  end if;
  if o.status not in ('paid', 'verifying') then
    raise exception 'order: can''t mark delivered now' using errcode = '22023';
  end if;
  update public.protected_orders set status = 'delivered', delivered_at = now() where id = o.id;
end $$;

create or replace function public.buyer_confirm_received(p_order uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare o public.protected_orders;
begin
  select * into o from public.protected_orders where id = p_order for update;
  if not found or auth.uid() is null or o.buyer_id is distinct from auth.uid() then
    raise exception 'order: not yours' using errcode = '42501';
  end if;
  if o.buyer_confirmed_at is not null then return; end if;
  if o.status not in ('paid', 'verifying', 'delivered') or (o.claimed_at is not null and o.claim_outcome is null) then
    raise exception 'order: can''t confirm now' using errcode = '22023';
  end if;
  update public.protected_orders
     set status = 'delivered', delivered_at = coalesce(delivered_at, now()), buyer_confirmed_at = now()
   where id = o.id;
end $$;

-- Photos are uploaded first to the private claim-photos bucket under "<buyer id>/<order id>/".
create or replace function public.buyer_open_claim(p_order uuid, p_reason text, p_photos text[] default '{}')
  returns void language plpgsql security definer set search_path = public as $$
declare
  o public.protected_orders;
  p text;
  photos text[] := coalesce(p_photos, '{}');
begin
  select * into o from public.protected_orders where id = p_order for update;
  if not found or auth.uid() is null or o.buyer_id is distinct from auth.uid() then
    raise exception 'order: not yours' using errcode = '42501';
  end if;
  if o.claimed_at is not null then
    raise exception 'claim: already open' using errcode = '22023';
  end if;
  if o.status not in ('paid', 'verifying', 'delivered') or o.buyer_confirmed_at is not null then
    raise exception 'claim: not allowed now' using errcode = '22023';
  end if;
  if o.status = 'delivered' and o.delivered_at + interval '3 days' < now() then
    raise exception 'claim: window closed' using errcode = '22023';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) < 10 or char_length(p_reason) > 1000 then
    raise exception 'claim: reason length' using errcode = '22023';
  end if;
  if cardinality(photos) > 4 then raise exception 'claim: too many photos' using errcode = '22023'; end if;
  foreach p in array photos loop
    if p not like auth.uid()::text || '/' || o.id::text || '/%' or p like '%..%' then
      raise exception 'claim: bad photo path' using errcode = '22023';
    end if;
  end loop;
  update public.protected_orders
     set claimed_at = now(), claim_reason = trim(p_reason), claim_photos = photos
   where id = o.id;
end $$;

revoke all on function public.my_orders() from public, anon;
revoke all on function public.seller_mark_delivered(uuid) from public, anon;
revoke all on function public.buyer_confirm_received(uuid) from public, anon;
revoke all on function public.buyer_open_claim(uuid, text, text[]) from public, anon;
grant execute on function public.my_orders() to authenticated;
grant execute on function public.seller_mark_delivered(uuid) to authenticated;
grant execute on function public.buyer_confirm_received(uuid) to authenticated;
grant execute on function public.buyer_open_claim(uuid, text, text[]) to authenticated;

-- ------------------------------------------------------------------ claim photos (private)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('claim-photos', 'claim-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
drop policy if exists "buyers upload claim photos" on storage.objects;
create policy "buyers upload claim photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'claim-photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "buyers and staff read claim photos" on storage.objects;
create policy "buyers and staff read claim photos" on storage.objects for select to authenticated
  using (bucket_id = 'claim-photos' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_staff()));
drop policy if exists "buyers delete own claim photos" on storage.objects;
create policy "buyers delete own claim photos" on storage.objects for delete to authenticated
  using (bucket_id = 'claim-photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- ------------------------------------------------------------------ where sellers get paid
-- Private: the owner and staff only. Used for the staff payout list ("Pagar hoy").
create table if not exists public.payout_accounts (
  user_id uuid primary key references public.profiles on delete cascade,
  yappy_phone text not null check (yappy_phone ~ '^6[0-9]{7}$'),
  holder_name text not null check (char_length(holder_name) between 2 and 80),
  updated_at timestamptz not null default now()
);
alter table public.payout_accounts enable row level security;
drop policy if exists "own or staff read payout" on public.payout_accounts;
create policy "own or staff read payout" on public.payout_accounts for select
  using (user_id = auth.uid() or public.is_staff());
drop policy if exists "own payout insert" on public.payout_accounts;
create policy "own payout insert" on public.payout_accounts for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists "own payout update" on public.payout_accounts;
create policy "own payout update" on public.payout_accounts for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop trigger if exists payout_accounts_touch on public.payout_accounts;
create trigger payout_accounts_touch before update on public.payout_accounts
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------------ staff actions
create or replace function public.staff_order_action(p_order uuid, p_action text, p_ref text default null)
  returns void language plpgsql security definer set search_path = public as $$
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
    update public.listings set status = 'reserved' where id = o.listing_id and status = 'active';

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
    update public.listings set status = 'sold' where id = o.listing_id and status in ('active', 'reserved');
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
    update public.listings set status = 'active' where id = o.listing_id and status = 'reserved';

  elsif p_action = 'cancel' and o.status = 'awaiting_payment' then
    update public.protected_orders set status = 'cancelled', hold_until = null where id = o.id;

  else
    raise exception 'order: action % not allowed in stage %', p_action, public.order_stage(o) using errcode = '22023';
  end if;
end $$;
revoke all on function public.staff_order_action(uuid, text, text) from public, anon;
grant execute on function public.staff_order_action(uuid, text, text) to authenticated;

-- Staff panel: orders with their stage and payout details in one read.
create or replace function public.staff_orders() returns table (
  id uuid, listing_id uuid, title text, seller_id uuid, seller_name text, buyer_id uuid, buyer_contact text,
  price_cents int, fee_cents int, itbms_cents int, status text, stage text, source text,
  payment_ref text, payout_ref text, notes text, created_at timestamptz, updated_at timestamptz,
  paid_at timestamptz, delivered_at timestamptz, ready_at timestamptz, buyer_confirmed_at timestamptz,
  claimed_at timestamptz, claim_reason text, claim_photos text[], claim_outcome text, released_at timestamptz,
  payout_phone text, payout_name text
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
         pa.yappy_phone, pa.holder_name
  from public.protected_orders o
  left join public.listings l on l.id = o.listing_id
  left join public.profiles p on p.id = o.seller_id
  left join public.payout_accounts pa on pa.user_id = o.seller_id
  -- unpaid checkouts whose hold ended are abandoned carts, not orders
  where not (o.source = 'checkout' and o.status = 'awaiting_payment' and o.hold_until < now() - interval '1 day')
  order by o.created_at desc
  limit 300;
end $$;
revoke all on function public.staff_orders() from public, anon;
grant execute on function public.staff_orders() to authenticated;

-- ------------------------------------------------------------------ checkout (Yappy-ready)
-- Opens (or refreshes) the buyer's order for a card. The price is the listing's, or the buyer's
-- accepted offer; the card is held for 15 minutes so two buyers can't pay for it at once.
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
         hold_until = now() + interval '15 minutes'
   where listing_id = l.id and buyer_id = uid and status = 'awaiting_payment' and source = 'checkout'
   returning * into o;
  if not found then
    if (select count(*) from public.protected_orders
        where buyer_id = uid and source = 'checkout' and created_at > now() - interval '1 day') >= 20 then
      raise exception 'checkout: too many' using errcode = '22023';
    end if;
    insert into public.protected_orders (listing_id, buyer_id, seller_id, price_cents, fee_cents, itbms_cents,
                                         status, source, hold_until)
    values (l.id, uid, l.seller_id, price, (q->>'fee')::int, (q->>'itbms')::int,
            'awaiting_payment', 'checkout', now() + interval '15 minutes')
    returning * into o;
  end if;
  return o;
end $$;
revoke all on function public.start_checkout(uuid) from public, anon;
grant execute on function public.start_checkout(uuid) to authenticated;

-- One row per try at paying (Yappy wants a new order id, max 15 letters/digits, on each try).
create table if not exists public.payment_attempts (
  id text primary key check (id ~ '^[A-Z0-9]{1,15}$'),
  order_id uuid not null references public.protected_orders on delete cascade,
  provider text not null default 'yappy' check (provider in ('yappy', 'tilopay')),
  amount_cents int not null check (amount_cents > 0),
  status text not null default 'created' check (status in ('created', 'executed', 'rejected', 'cancelled', 'expired')),
  confirmation text check (char_length(confirmation) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payment_attempts_order_idx on public.payment_attempts (order_id);
alter table public.payment_attempts enable row level security;
drop policy if exists "staff read payment attempts" on public.payment_attempts;
create policy "staff read payment attempts" on public.payment_attempts for select using (public.is_staff());
drop trigger if exists payment_attempts_touch on public.payment_attempts;
create trigger payment_attempts_touch before update on public.payment_attempts
  for each row execute function public.touch_updated_at();

-- Called by the yappy-pago Edge Function with the buyer's session, right before it asks Yappy
-- to create the payment. Returns the attempt id and the amounts Yappy needs.
create or replace function public.new_payment_attempt(p_order uuid, p_provider text default 'yappy') returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  o public.protected_orders;
  aid text;
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
  aid := 'H' || upper(substr(md5(gen_random_uuid()::text), 1, 14));
  insert into public.payment_attempts (id, order_id, provider, amount_cents)
  values (aid, o.id, p_provider, o.price_cents + o.fee_cents + o.itbms_cents);
  -- Give the buyer the full hold to finish in the Yappy app.
  update public.protected_orders set hold_until = greatest(hold_until, now() + interval '10 minutes') where id = o.id;
  return jsonb_build_object('attempt_id', aid, 'subtotal_cents', o.price_cents + o.fee_cents,
                            'taxes_cents', o.itbms_cents, 'total_cents', o.price_cents + o.fee_cents + o.itbms_cents);
end $$;
revoke all on function public.new_payment_attempt(uuid, text) from public, anon;
grant execute on function public.new_payment_attempt(uuid, text) to authenticated;

-- Called only by the Edge Function (service role) after it checked the provider's signature.
-- Safe to call twice with the same notice. p_status: executed | rejected | cancelled | expired.
create or replace function public.confirm_payment(p_attempt text, p_status text, p_confirmation text default null)
  returns text language plpgsql security definer set search_path = public as $$
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
    update public.listings set status = 'reserved' where id = o.listing_id and status = 'active';
    if not found then
      update public.protected_orders
         set notes = left(concat_ws(E'\n', notes, 'ATENCIÓN: pago recibido pero la carta ya no estaba disponible. Reembolsar.'), 500)
       where id = o.id;
    end if;
    return 'paid';
  end if;
  -- Money arrived for an order that is no longer waiting for it (cancelled, or paid twice).
  update public.protected_orders
     set notes = left(concat_ws(E'\n', notes, 'ATENCIÓN: pago extra recibido (' || a.id || ', ' || coalesce(p_confirmation, '') || '). Reembolsar.'), 500)
   where id = o.id;
  return 'needs refund';
end $$;
revoke all on function public.confirm_payment(text, text, text) from public, anon, authenticated;
grant execute on function public.confirm_payment(text, text, text) to service_role;

-- Unpaid checkouts are cancelled 30 minutes after their hold ends, so an abandoned cart never
-- blocks the seller (mark sold, or another buyer). hold_until is kept to tell it from a staff cancel.
create or replace function public.expire_checkouts() returns int
  language sql security definer set search_path = public as $$
  with x as (
    update public.protected_orders set status = 'cancelled'
     where source = 'checkout' and status = 'awaiting_payment' and hold_until < now() - interval '30 minutes'
    returning 1)
  select count(*)::int from x
$$;
revoke all on function public.expire_checkouts() from public, anon, authenticated;
select cron.schedule('holo-checkouts-vencidos', '*/10 * * * *', 'select public.expire_checkouts()');

-- Internal helpers: the page calls my_orders()/staff_orders() instead.
revoke all on function public.order_ready_to_pay(public.protected_orders) from public, anon;
revoke all on function public.order_stage(public.protected_orders) from public, anon;
grant execute on function public.order_ready_to_pay(public.protected_orders) to authenticated;
grant execute on function public.order_stage(public.protected_orders) to authenticated;
