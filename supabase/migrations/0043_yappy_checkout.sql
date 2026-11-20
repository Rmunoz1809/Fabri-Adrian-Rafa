-- 0043: "Pagar con Yappy" goes straight to the payment (decisions, 2026-11-20). Run once in Supabase ▸
-- SQL Editor after 0042 (safe to re-run), and BEFORE deploying the yappy-pago Edge Function that calls it.
--
-- Tapping the button no longer opens a consulta. The page (or the yappy-pago Edge Function) calls
-- web_checkout(): it creates the order as a sale in Panel ▸ Ventas (concierge_sales, 0041) with an order
-- number (#001, #002…) and the buyer's Yappy phone, which the account already has. With the Yappy
-- payment button live, the Edge Function then calls start_web_payment() and asks Yappy to send the charge
-- to that phone; Yappy's notice (IPN) marks the sale paid by itself (process_yappy_notification). Until
-- then, staff sends the charge from Yappy Comercial with the description the panel shows
-- ("Pago <card> #001") and marks it paid as before.
--
--   * Shipping is $3 (decisions, 2026-11-12): the setting the amounts come from was still $4.
--   * buyer_phones: the Yappy phone of an account that has no seller account (only the person and staff
--     read it). A seller's or a shop's phone is used when it is a mobile.
--   * concierge_sales: order_no (every new sale, from 1), source ('staff' | 'web'), pay_deadline (a web
--     order that isn't paid in time frees the card for the next buyer) and a delivery address that a web
--     order doesn't have yet (staff coordinates it by WhatsApp after the payment).
--   * sale_payments: each Yappy charge for a sale. Its id is Yappy's orderId: the order number ("001"),
--     then "001B", "001C"… if the buyer tries again (Yappy wants a new id per charge, 1-15 letters or digits).
-- The amounts always come from the listing and holo_settings, never from the page.

-- ------------------------------------------------------------------ shipping $3
update public.holo_settings set value = 300, updated_at = now() where key = 'shipping_cents' and value = 400;

-- ------------------------------------------------------------------ buyer's Yappy phone
create table if not exists public.buyer_phones (
  user_id uuid primary key references public.profiles on delete cascade,
  phone text not null check (phone ~ '^\+5076[0-9]{7}$'),
  updated_at timestamptz not null default now()
);
alter table public.buyer_phones enable row level security;
drop policy if exists "own or staff read buyer phone" on public.buyer_phones;
create policy "own or staff read buyer phone" on public.buyer_phones for select using (user_id = auth.uid() or public.is_staff());
-- No write policies: web_checkout() saves it.

-- The phone Yappy charges for this account: the one given to pay, else the seller account's (if a mobile).
create or replace function public.account_yappy_phone(p_user uuid) returns text
  language sql stable security definer set search_path = public as $$
  select coalesce(
    (select phone from public.buyer_phones where user_id = p_user),
    (select phone from public.seller_accounts where user_id = p_user and phone ~ '^\+5076[0-9]{7}$'))
$$;

-- ------------------------------------------------------------------ order numbers and web orders
create sequence if not exists public.concierge_order_no_seq start 1;
alter table public.concierge_sales
  add column if not exists order_no int unique,
  add column if not exists source text not null default 'staff' check (source in ('staff', 'web')),
  add column if not exists pay_deadline timestamptz;
-- Sales made before this migration keep no number: the first order is #001.
alter table public.concierge_sales alter column order_no set default nextval('public.concierge_order_no_seq');
alter sequence public.concierge_order_no_seq owned by public.concierge_sales.order_no;
alter table public.concierge_sales alter column delivery_address drop not null;

-- "001", "002"… "999", "1000".
create or replace function public.order_label(p_no int) returns text
  language sql immutable set search_path = public as $$
  select case when p_no is null then null else lpad(p_no::text, 3, '0') end
$$;

-- What the buyer reads on the Yappy charge and staff copies into Yappy Comercial.
create or replace function public.sale_yappy_description(r public.concierge_sales) returns text
  language sql stable set search_path = public as $$
  select 'Pago ' || r.title || coalesce(' #' || public.order_label(r.order_no), '')
$$;

create or replace function public.new_sale_code() returns text
  language plpgsql volatile set search_path = public as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_code text;
begin
  loop
    v_code := 'V-' || (select string_agg(substr(alphabet, 1 + floor(random() * 32)::int, 1), '') from generate_series(1, 6));
    exit when not exists (select 1 from public.concierge_sales where code = v_code);
  end loop;
  return v_code;
end $$;

create table if not exists public.sale_payments (
  id text primary key check (id ~ '^[A-Za-z0-9]{1,15}$'),
  sale_id uuid not null references public.concierge_sales on delete cascade,
  provider text not null default 'yappy' check (provider in ('yappy', 'mock')),
  phone text not null check (phone ~ '^\+5076[0-9]{7}$'),
  amount_cents int not null check (amount_cents > 0),
  status text not null default 'created' check (status in ('created', 'executed', 'rejected', 'cancelled', 'expired', 'failed')),
  confirmation text check (char_length(confirmation) <= 120),
  error text check (char_length(error) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sale_payments_sale_idx on public.sale_payments (sale_id, created_at);
alter table public.sale_payments enable row level security;
drop policy if exists "staff read sale payments" on public.sale_payments;
create policy "staff read sale payments" on public.sale_payments for select using (public.is_staff());
-- No write policies: start_web_payment(), web_payment_failed() and process_yappy_notification().

-- The order as the buyer's page sees it.
create or replace function public.web_order_json(r public.concierge_sales) returns jsonb
  language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'sale_id', r.id, 'order_no', r.order_no, 'order_label', public.order_label(r.order_no), 'status', r.status,
    'title', r.title, 'description', public.sale_yappy_description(r), 'phone', r.buyer_phone,
    'price_cents', r.price_cents, 'shipping_cents', r.shipping_cents, 'total_cents', r.price_cents + r.shipping_cents,
    'pay_deadline', r.pay_deadline, 'paid_at', r.paid_at,
    'payment', (select jsonb_build_object('id', p.id, 'status', p.status, 'created_at', p.created_at, 'error', p.error)
                  from public.sale_payments p where p.sale_id = r.id order by p.created_at desc limit 1))
$$;

-- "Pagar con Yappy": creates the order (or returns the buyer's open one for this card). p_phone, when
-- given, becomes the account's Yappy phone; otherwise the account's phone is used.
create or replace function public.web_checkout(p_listing uuid, p_phone text default null) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  l public.listings;
  r public.concierge_sales;
  q jsonb;
  ph text;
  v_name text;
begin
  if uid is null then raise exception 'checkout: login required' using errcode = '42501'; end if;
  select * into l from public.listings where id = p_listing for update; -- one buyer at a time per card
  if not found or l.status <> 'active' or public.seller_blocked(l.seller_id) then
    raise exception 'checkout: listing not available' using errcode = '22023';
  end if;
  if l.seller_id = uid then raise exception 'checkout: own listing' using errcode = '22023'; end if;

  if nullif(trim(coalesce(p_phone, '')), '') is not null then
    ph := public.pa_phone(p_phone);
    if ph is null or ph !~ '^\+5076[0-9]{7}$' then raise exception 'checkout: phone must be a mobile' using errcode = '22023'; end if;
    insert into public.buyer_phones (user_id, phone) values (uid, ph)
    on conflict (user_id) do update set phone = excluded.phone, updated_at = now();
  else
    ph := public.account_yappy_phone(uid);
    if ph is null then raise exception 'checkout: phone required' using errcode = '22023'; end if;
  end if;

  select * into r from public.concierge_sales
   where listing_id = l.id and status in ('nueva', 'pagada', 'retirada', 'en_ruta') for update;
  if found then
    if r.buyer_id = uid then
      if r.status = 'nueva' then
        update public.concierge_sales
           set buyer_phone = ph, pay_deadline = now() + make_interval(mins => public.setting_int('payment_minutes')), updated_at = now()
         where id = r.id returning * into r;
      end if;
      return public.web_order_json(r);
    end if;
    -- Someone else's web order that wasn't paid in time frees the card.
    if r.source = 'web' and r.status = 'nueva' and r.pay_deadline < now()
       and not exists (select 1 from public.sale_payments p where p.sale_id = r.id and p.status = 'executed') then
      update public.concierge_sales
         set status = 'cancelada', cancelled_at = now(), updated_at = now(),
             note = left(concat_ws(E'\n', nullif(note, ''), 'Venció sin pago: otra persona compró la carta.'), 1000)
       where id = r.id;
    else
      raise exception 'checkout: listing on hold' using errcode = '22023';
    end if;
  end if;

  if (select count(*) from public.concierge_sales where buyer_id = uid and source = 'web' and created_at > now() - interval '1 day') >= 10 then
    raise exception 'checkout: too many' using errcode = '22023';
  end if;
  select nullif(trim(display_name), '') into v_name from public.profiles where id = uid;
  v_name := coalesce(case when char_length(v_name) between 2 and 80 then v_name end, 'Comprador web');
  q := public.order_quote(l.price_cents, false);
  insert into public.concierge_sales (code, listing_id, title, seller_id, buyer_id, buyer_name, buyer_phone, delivery_address,
                                      price_cents, shipping_cents, commission_cents, itbms_cents, payout_cents,
                                      source, pay_deadline, created_by)
  values (public.new_sale_code(), l.id, left(l.title, 200), l.seller_id, uid, v_name, ph, null,
          l.price_cents, (q->>'shipping')::int, (q->>'seller_fee')::int, (q->>'seller_itbms')::int, (q->>'payout')::int,
          'web', now() + make_interval(mins => public.setting_int('payment_minutes')), uid)
  returning * into r;
  perform public.notify_staff('staff_web_order', 'Orden #' || public.order_label(r.order_no),
    public.sale_yappy_description(r) || ' · ' || public.usd(r.price_cents + r.shipping_cents) || ' · Yappy ' || r.buyer_phone,
    '#/admin?tab=ventas');
  return public.web_order_json(r);
end $$;

-- The buyer's order for this card (open, or the last one) and the phone Yappy would charge.
create or replace function public.my_web_checkout(p_listing uuid) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  r public.concierge_sales;
begin
  if uid is null then return null; end if;
  select * into r from public.concierge_sales
   where listing_id = p_listing and buyer_id = uid and source = 'web'
   order by (status in ('nueva', 'pagada', 'retirada', 'en_ruta', 'entregada')) desc, created_at desc limit 1;
  return jsonb_build_object('phone', public.account_yappy_phone(uid), 'order', case when found then public.web_order_json(r) end);
end $$;

-- A Yappy charge for the order, called by the Edge Function with the buyer's session (after
-- web_checkout() inside it). Returns the order plus the attempt: Yappy's orderId and the amounts. A charge
-- created less than a minute ago is returned again (existing: true) instead of sending a second one.
create or replace function public.start_web_payment(p_listing uuid, p_phone text default null, p_provider text default 'yappy')
  returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c jsonb := public.web_checkout(p_listing, p_phone);
  r public.concierge_sales;
  p public.sale_payments;
  n int;
  total int;
begin
  select * into r from public.concierge_sales where id = (c->>'sale_id')::uuid for update;
  if r.status <> 'nueva' then raise exception 'checkout: already paid' using errcode = '22023'; end if;
  total := r.price_cents + r.shipping_cents;
  select * into p from public.sale_payments
   where sale_id = r.id and status = 'created' and created_at > now() - interval '1 minute' and phone = r.buyer_phone
   order by created_at desc limit 1;
  if found then
    return c || jsonb_build_object('attempt_id', p.id, 'existing', true, 'alias', substr(r.buyer_phone, 5),
                                   'subtotal_cents', total, 'taxes_cents', 0, 'total_cents', total);
  end if;
  select count(*) into n from public.sale_payments where sale_id = r.id;
  if n >= 10 then raise exception 'checkout: too many attempts' using errcode = '22023'; end if;
  update public.sale_payments set status = 'failed', error = 'Reemplazado por un cobro nuevo', updated_at = now()
   where sale_id = r.id and status = 'created';
  insert into public.sale_payments (id, sale_id, provider, phone, amount_cents)
  values (public.order_label(r.order_no) || case when n = 0 then '' else chr(65 + n) end, r.id,
          coalesce(p_provider, 'yappy'), r.buyer_phone, total)
  returning * into p;
  update public.concierge_sales set pay_deadline = now() + make_interval(mins => public.setting_int('payment_minutes')), updated_at = now()
   where id = r.id returning * into r;
  return public.web_order_json(r) || jsonb_build_object('attempt_id', p.id, 'existing', false, 'alias', substr(r.buyer_phone, 5),
                                                         'subtotal_cents', total, 'taxes_cents', 0, 'total_cents', total);
end $$;

-- Yappy refused to create the charge (e.g. the phone has no Yappy): the attempt is closed and the card
-- is free for others right away. The buyer can fix the phone and try again with the same order number.
create or replace function public.web_payment_failed(p_attempt text, p_error text default null) returns void
  language plpgsql security definer set search_path = public as $$
declare p public.sale_payments;
begin
  select sp.* into p from public.sale_payments sp join public.concierge_sales c on c.id = sp.sale_id
   where sp.id = p_attempt and c.buyer_id = auth.uid() for update of sp;
  if not found then raise exception 'checkout: not yours' using errcode = '42501'; end if;
  if p.status <> 'created' then return; end if;
  update public.sale_payments set status = 'failed', error = left(nullif(trim(coalesce(p_error, '')), ''), 200), updated_at = now()
   where id = p.id;
  update public.concierge_sales set pay_deadline = least(coalesce(pay_deadline, now()), now()), updated_at = now()
   where id = p.sale_id and status = 'nueva';
end $$;

-- ------------------------------------------------------------------ Yappy's notice for a sale
-- Same rules as process_payment_notification() (0029): every notice is logged in payment_notifications
-- and each (charge, status) is processed once. E: the sale is paid and the card reserved (what staff did
-- by hand with "Marcar pagada"). E for a sale that isn't waiting any more: logged in the sale's note for a
-- refund. R, C, X: the charge closes and the card is free for others; the buyer can try again.
create or replace function public.process_sale_payment_notification(
  p_attempt text, p_status text, p_domain text, p_hash text, p_confirmation text, p_raw jsonb, p_provider text
) returns text language plpgsql security definer set search_path = public as $$
declare
  p public.sale_payments;
  r public.concierge_sales;
  mapped text := case p_status when 'E' then 'executed' when 'R' then 'rejected' when 'C' then 'cancelled' when 'X' then 'expired' end;
  v_conf text := nullif(left(trim(coalesce(p_confirmation, '')), 60), '');
  v_result text;
begin
  select * into p from public.sale_payments where id = p_attempt for update;
  if exists (select 1 from public.payment_notifications where attempt_id = p.id and status = p_status and processed) then
    insert into public.payment_notifications (provider, attempt_id, status, domain, hash, valid, result, raw)
    values (p_provider, p.id, p_status, left(p_domain, 200), left(p_hash, 200), true, 'duplicate', p_raw);
    return 'duplicate';
  end if;
  insert into public.payment_notifications (provider, attempt_id, status, domain, hash, valid, processed, result, raw)
  values (p_provider, p.id, p_status, left(p_domain, 200), left(p_hash, 200), true, true, 'processing', p_raw);

  if p.status = 'executed' then
    v_result := 'already executed';
  else
    update public.sale_payments set status = mapped, confirmation = left(p_confirmation, 120), updated_at = now()
     where id = p.id returning * into p;
    select * into r from public.concierge_sales where id = p.sale_id for update;
    if mapped = 'executed' and r.status = 'nueva' then
      update public.concierge_sales
         set status = 'pagada', paid_at = now(), pay_deadline = null, updated_at = now(),
             payment_ref = left('Yappy ' || coalesce(v_conf || ' ', '') || '(#' || p.id || ')', 80)
       where id = r.id returning * into r;
      update public.listings set status = 'reserved' where id = r.listing_id and status = 'active';
      perform public.notify_staff('staff_web_paid', 'Orden #' || public.order_label(r.order_no) || ' pagada',
        public.sale_yappy_description(r) || ' · ' || public.usd(p.amount_cents) || '. Coordina el retiro.', '#/admin?tab=ventas');
      v_result := 'paid';
    elsif mapped = 'executed' then
      update public.concierge_sales
         set note = left(concat_ws(E'\n', nullif(note, ''), 'Pago por Yappy ' || coalesce(v_conf || ' ', '') || '(#' || p.id || ') de '
                    || public.usd(p.amount_cents) || ' cuando la orden estaba ' || r.status || ': reembolsar.'), 1000),
             updated_at = now()
       where id = r.id;
      perform public.notify_staff('staff_web_late_payment', 'Pago para reembolsar',
        'Orden #' || coalesce(public.order_label(r.order_no), r.code) || ': llegó un pago de ' || public.usd(p.amount_cents) || ' cuando estaba ' || r.status || '.',
        '#/admin?tab=ventas');
      v_result := 'late payment: refund';
    else
      if r.status = 'nueva' and not exists (select 1 from public.sale_payments x where x.sale_id = r.id and x.status = 'created') then
        update public.concierge_sales set pay_deadline = least(coalesce(pay_deadline, now()), now()), updated_at = now() where id = r.id;
      end if;
      v_result := 'noted';
    end if;
  end if;
  update public.payment_notifications set result = v_result
   where id = (select max(id) from public.payment_notifications where attempt_id = p.id and status = p_status and processed);
  return v_result;
end $$;

-- The Edge Function's entry point for every notice: a sale's charge goes to the function above; the rest
-- (and every invalid notice) to process_payment_notification() of 0029, which logs it.
create or replace function public.process_yappy_notification(
  p_attempt text, p_status text, p_domain text, p_hash text, p_valid boolean,
  p_confirmation text default null, p_raw jsonb default null, p_provider text default 'yappy'
) returns text language plpgsql security definer set search_path = public as $$
begin
  if p_valid and p_status in ('E', 'R', 'C', 'X') and exists (select 1 from public.sale_payments where id = p_attempt) then
    return public.process_sale_payment_notification(p_attempt, p_status, p_domain, p_hash, p_confirmation, p_raw, p_provider);
  end if;
  return public.process_payment_notification(p_attempt, p_status, p_domain, p_hash, p_valid, p_confirmation, p_raw, p_provider);
end $$;

-- ------------------------------------------------------------------ Panel ▸ Ventas
-- staff_sales() gains the order number, where the sale came from, the Yappy description and the last charge.
drop function if exists public.staff_sales(text);
create function public.staff_sales(p_status text default null)
returns table (id uuid, code text, order_no int, order_label text, source text, yappy_description text, status text, title text,
               listing_id uuid, inquiry_id uuid, inquiry_code text,
               price_cents int, shipping_cents int, commission_cents int, itbms_cents int, payout_cents int,
               buyer_id uuid, buyer_name text, buyer_phone text, delivery_address text,
               seller_id uuid, seller_name text, seller_kind text, seller_phone text, seller_pickup_address text, seller_yappy text,
               payment_ref text, payout_ref text, refund_ref text, distribution_date date, note text, pay_deadline timestamptz,
               last_payment_status text, last_payment_id text,
               created_at timestamptz, paid_at timestamptz, picked_up_at timestamptz, out_at timestamptz,
               delivered_at timestamptz, cancelled_at timestamptz)
  language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_staff() then raise exception 'sales: staff only' using errcode = '42501'; end if;
  return query
    select c.id, c.code, c.order_no, public.order_label(c.order_no), c.source, public.sale_yappy_description(c), c.status, c.title,
           c.listing_id, c.inquiry_id, q.code, c.price_cents, c.shipping_cents, c.commission_cents,
           c.itbms_cents, c.payout_cents, c.buyer_id, c.buyer_name, c.buyer_phone, c.delivery_address,
           c.seller_id, p.display_name, public.staff_account_kind(c.seller_id), s.phone, coalesce(s.pickup_address, p.shop_address),
           coalesce((select r.yappy_phone from public.shop_requests r where r.user_id = c.seller_id and r.status = 'approved'
                      and r.yappy_phone is not null order by r.reviewed_at desc limit 1), s.phone),
           c.payment_ref, c.payout_ref, c.refund_ref, c.distribution_date, c.note, c.pay_deadline,
           lp.status, lp.id,
           c.created_at, c.paid_at, c.picked_up_at, c.out_at, c.delivered_at, c.cancelled_at
      from public.concierge_sales c
      left join public.profiles p on p.id = c.seller_id
      left join public.seller_accounts s on s.user_id = c.seller_id
      left join public.inquiries q on q.id = c.inquiry_id
      left join lateral (select sp.status, sp.id from public.sale_payments sp where sp.sale_id = c.id order by sp.created_at desc limit 1) lp on true
     where p_status is null or c.status = p_status
     order by case c.status when 'nueva' then 1 when 'pagada' then 2 when 'retirada' then 3 when 'en_ruta' then 4 else 5 end,
              c.distribution_date nulls last, c.created_at desc
     limit 500;
end $$;

-- ------------------------------------------------------------------ grants
revoke all on function public.account_yappy_phone(uuid) from public, anon, authenticated;
revoke all on function public.order_label(int) from public, anon, authenticated;
revoke all on function public.sale_yappy_description(public.concierge_sales) from public, anon, authenticated;
revoke all on function public.new_sale_code() from public, anon, authenticated;
revoke all on function public.web_order_json(public.concierge_sales) from public, anon, authenticated;
revoke all on function public.process_sale_payment_notification(text, text, text, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.process_yappy_notification(text, text, text, text, boolean, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.process_yappy_notification(text, text, text, text, boolean, text, jsonb, text) to service_role;
revoke all on function public.web_checkout(uuid, text) from public, anon;
revoke all on function public.my_web_checkout(uuid) from public, anon;
revoke all on function public.start_web_payment(uuid, text, text) from public, anon;
revoke all on function public.web_payment_failed(text, text) from public, anon;
revoke all on function public.staff_sales(text) from public, anon;
grant execute on function public.web_checkout(uuid, text) to authenticated;
grant execute on function public.my_web_checkout(uuid) to authenticated;
grant execute on function public.start_web_payment(uuid, text, text) to authenticated;
grant execute on function public.web_payment_failed(text, text) to authenticated;
grant execute on function public.staff_sales(text) to authenticated;
