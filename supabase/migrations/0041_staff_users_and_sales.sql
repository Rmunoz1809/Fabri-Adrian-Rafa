-- 0041: Staff panel ▸ Usuarios and ▸ Ventas. Run once in Supabase ▸ SQL Editor after 0040 (safe to re-run).
-- holo.html works before and after it: until it runs, Usuarios falls back to the seller list (0031) and
-- Ventas says the migration is missing.
--
-- Usuarios: every account with its type (comprador, vendedor, tienda, tienda en revisión, staff) and,
-- for the one staff pick, everything we ask for: e-mail, phone, the pickup address and its parts, the
-- shop's data and agreement, identity check, listings, consultas and sales. Staff only.
--
-- Ventas: the sale flow we run by hand while purchases go through WhatsApp (decisions, 2026-10-20):
--   nueva     the buyer wants the card; we wait for the Yappy payment
--   pagada    paid by Yappy: the card stops being available (listing reserved) and we hold the money
--   retirada  we picked the card up at the seller and paid the seller there (price − 7% − ITBMS);
--             it stays with us until the distribution day (distribution_date)
--   en_ruta   out for delivery on the distribution day
--   entregada the buyer has it: the listing is sold and the price goes into the local price data (sales)
--   cancelada before pickup only (nueva or pagada); a paid sale needs the refund reference
-- Amounts come from the listing and holo_settings (order_quote, 0029/0039), never from the page.
-- The tables of 0029 (protected_orders and its ledger) stay unused, as decided on 2026-10-16.

-- ------------------------------------------------------------------ Usuarios
create or replace function public.staff_account_kind(p_user uuid) returns text
  language sql stable security definer set search_path = public as $$
  select case
    when p.is_staff then 'staff'
    when p.is_shop and p.verified then 'tienda'
    when p.is_shop or u.raw_user_meta_data->>'account_type' = 'shop'
      or exists (select 1 from public.shop_requests r where r.user_id = p.id and r.status = 'pending') then 'tienda_revision'
    when exists (select 1 from public.seller_accounts s where s.user_id = p.id) then 'vendedor'
    else 'comprador' end
    from public.profiles p left join auth.users u on u.id = p.id
   where p.id = p_user
$$;

create or replace function public.staff_users(p_query text default null, p_kind text default null)
returns table (user_id uuid, display_name text, email text, kind text, phone text, pickup_address text,
               verified boolean, cards_on_sale int, created_at timestamptz)
  language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  q text := nullif(trim(coalesce(p_query, '')), '');
  q_digits text := nullif(regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g'), '');
begin
  if not public.is_staff() then raise exception 'users: staff only' using errcode = '42501'; end if;
  return query
    select x.id, x.display_name, x.email, x.kind, x.phone, x.pickup_address, x.verified, x.cards_on_sale, x.created_at
      from (select p.id, p.display_name, u.email::text as email, public.staff_account_kind(p.id) as kind, s.phone, s.pickup_address,
                   p.verified, p.created_at,
                   (select count(*)::int from public.listings l where l.seller_id = p.id and l.status in ('active', 'reserved')) as cards_on_sale
              from public.profiles p
              join auth.users u on u.id = p.id
              left join public.seller_accounts s on s.user_id = p.id
             where q is null or p.display_name ilike '%' || q || '%' or u.email ilike '%' || q || '%'
                or s.pickup_address ilike '%' || q || '%'
                or (q_digits is not null and char_length(q_digits) >= 4 and s.phone like '%' || q_digits || '%')) x
     where p_kind is null or x.kind = p_kind
     order by x.created_at desc
     limit 500;
end $$;

-- Everything about one account, for the staff panel. The drawn signature is left out (it opens in the
-- signed copy, #/acuerdo-tienda/<id>); has_signature says whether there is one.
create or replace function public.staff_user_detail(p_user uuid) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare
  p public.profiles;
  u auth.users;
begin
  if not public.is_staff() then raise exception 'users: staff only' using errcode = '42501'; end if;
  select * into p from public.profiles where id = p_user;
  if not found then return null; end if;
  select * into u from auth.users where id = p_user;
  return jsonb_build_object(
    'profile', jsonb_build_object('id', p.id, 'display_name', p.display_name, 'is_shop', p.is_shop, 'verified', p.verified,
      'is_staff', p.is_staff, 'avatar_path', p.avatar_path, 'shop_description', p.shop_description, 'shop_address', p.shop_address,
      'shop_province', p.shop_province, 'shop_hours', p.shop_hours, 'created_at', p.created_at),
    'kind', public.staff_account_kind(p_user),
    'account', jsonb_build_object('email', u.email, 'account_type', u.raw_user_meta_data->>'account_type',
      'shop_name', u.raw_user_meta_data->>'shop_name', 'pickup_parts', u.raw_user_meta_data->'pickup_parts',
      'terms_version', u.raw_user_meta_data->>'terms_version', 'created_at', u.created_at),
    'seller', (select to_jsonb(s) - 'user_id' from public.seller_accounts s where s.user_id = p_user),
    'shop_requests', coalesce((select jsonb_agg((to_jsonb(r) - 'signature_png') || jsonb_build_object('has_signature', r.signature_png is not null)
                                                order by r.created_at desc)
                                 from public.shop_requests r where r.user_id = p_user), '[]'),
    'identity', (select jsonb_build_object('status', i.status, 'full_name', i.full_name, 'submitted_at', i.submitted_at, 'reviewed_at', i.reviewed_at)
                   from public.identity_checks i where i.user_id = p_user),
    'listings', jsonb_build_object(
      'counts', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) as n from public.listings where seller_id = p_user group by status) c), '{}'),
      'latest', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'title', l.title, 'price_cents', l.price_cents, 'status', l.status) order by l.created_at desc)
                            from (select * from public.listings where seller_id = p_user order by created_at desc limit 20) l), '[]')),
    'inquiries', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'code', q.code, 'subject', q.subject, 'status', q.status,
                                                               'contact_phone', q.contact_phone, 'created_at', q.created_at) order by q.created_at desc)
                             from (select * from public.inquiries where user_id = p_user order by created_at desc limit 20) q), '[]'),
    'sales', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'code', c.code, 'title', c.title, 'status', c.status, 'price_cents', c.price_cents,
                                                           'role', case when c.seller_id = p_user then 'vendedor' else 'comprador' end, 'created_at', c.created_at)
                                        order by c.created_at desc)
                         from (select * from public.concierge_sales where seller_id = p_user or buyer_id = p_user order by created_at desc limit 20) c), '[]'));
end $$;

-- ------------------------------------------------------------------ Ventas
create table if not exists public.concierge_sales (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  listing_id uuid references public.listings on delete set null,
  inquiry_id uuid references public.inquiries on delete set null,
  title text not null check (char_length(title) between 1 and 200),
  seller_id uuid references public.profiles on delete set null,
  buyer_id uuid references public.profiles on delete set null,
  buyer_name text not null check (char_length(buyer_name) between 2 and 80),
  buyer_phone text not null check (buyer_phone ~ '^\+507(6[0-9]{7}|[2-57-9][0-9]{6})$'),
  delivery_address text not null check (char_length(delivery_address) between 10 and 240),
  price_cents int not null check (price_cents > 0),
  shipping_cents int not null check (shipping_cents >= 0),
  commission_cents int not null check (commission_cents >= 0),
  itbms_cents int not null check (itbms_cents >= 0),
  payout_cents int not null check (payout_cents >= 0),
  status text not null default 'nueva' check (status in ('nueva', 'pagada', 'retirada', 'en_ruta', 'entregada', 'cancelada')),
  payment_ref text check (char_length(payment_ref) <= 80),
  payout_ref text check (char_length(payout_ref) <= 80),
  refund_ref text check (char_length(refund_ref) <= 80),
  distribution_date date,
  note text check (char_length(note) <= 1000),
  created_by uuid references public.profiles on delete set null,
  created_at timestamptz not null default now(),
  paid_at timestamptz, picked_up_at timestamptz, out_at timestamptz, delivered_at timestamptz, cancelled_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists concierge_sales_status_idx on public.concierge_sales (status, created_at desc);
-- One open sale per card.
create unique index if not exists concierge_sales_one_open on public.concierge_sales (listing_id)
  where status in ('nueva', 'pagada', 'retirada', 'en_ruta');
alter table public.concierge_sales enable row level security;
drop policy if exists "staff read sales" on public.concierge_sales;
create policy "staff read sales" on public.concierge_sales for select using (public.is_staff());
-- No write policies: staff_create_sale() and staff_sale_step() below.

create or replace function public.staff_create_sale(
  p_listing uuid, p_buyer_name text, p_buyer_phone text, p_delivery_address text,
  p_buyer uuid default null, p_inquiry uuid default null, p_note text default null) returns public.concierge_sales
  language plpgsql security definer set search_path = public as $$
declare
  l public.listings;
  q jsonb;
  r public.concierge_sales;
  v_name text := trim(regexp_replace(coalesce(p_buyer_name, ''), '\s+', ' ', 'g'));
  v_phone text := public.pa_phone(p_buyer_phone);
  v_addr text := public.clean_pickup_address(p_delivery_address);
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_code text;
begin
  if not public.is_staff() then raise exception 'sale: staff only' using errcode = '42501'; end if;
  select * into l from public.listings where id = p_listing for update;
  if not found then raise exception 'sale: listing not found' using errcode = '22023'; end if;
  if l.status <> 'active' then raise exception 'sale: listing is %', l.status using errcode = '22023'; end if;
  if exists (select 1 from public.concierge_sales where listing_id = p_listing and status in ('nueva', 'pagada', 'retirada', 'en_ruta')) then
    raise exception 'sale: listing already has an open sale' using errcode = '22023';
  end if;
  if v_name = '' and p_buyer is not null then select display_name into v_name from public.profiles where id = p_buyer; end if;
  if char_length(coalesce(v_name, '')) not between 2 and 80 then raise exception 'sale: buyer name' using errcode = '22023'; end if;
  if v_phone is null then raise exception 'sale: buyer phone' using errcode = '22023'; end if;
  if char_length(v_addr) not between 10 and 240 then raise exception 'sale: delivery address' using errcode = '22023'; end if;
  if p_buyer is not null and p_buyer = l.seller_id then raise exception 'sale: buyer is the seller' using errcode = '22023'; end if;
  q := public.order_quote(l.price_cents, false);
  loop
    v_code := 'V-' || (select string_agg(substr(alphabet, 1 + floor(random() * 32)::int, 1), '') from generate_series(1, 6));
    exit when not exists (select 1 from public.concierge_sales where code = v_code);
  end loop;
  insert into public.concierge_sales (code, listing_id, inquiry_id, title, seller_id, buyer_id, buyer_name, buyer_phone, delivery_address,
                                      price_cents, shipping_cents, commission_cents, itbms_cents, payout_cents, note, created_by)
  values (v_code, l.id, p_inquiry, left(l.title, 200), l.seller_id, p_buyer, v_name, v_phone, v_addr,
          l.price_cents, (q->>'shipping')::int, (q->>'seller_fee')::int, (q->>'seller_itbms')::int, (q->>'payout')::int,
          nullif(left(trim(coalesce(p_note, '')), 1000), ''), auth.uid())
  returning * into r;
  if p_inquiry is not null then
    update public.inquiries set status = 'en_curso', handled_by = auth.uid(), updated_at = now(),
           staff_note = left(concat_ws(E'\n', nullif(staff_note, ''), 'Venta ' || v_code), 1000)
     where id = p_inquiry and status <> 'cerrada';
  end if;
  return r;
end $$;

-- One step of the flow. p_ref: the Yappy reference (pagada: the buyer's payment; retirada: our payment to
-- the seller; cancelada after paying: the refund). p_date: the distribution day (programar).
create or replace function public.staff_sale_step(p_id uuid, p_step text, p_ref text default null, p_date date default null,
                                                  p_note text default null) returns public.concierge_sales
  language plpgsql security definer set search_path = public as $$
declare
  r public.concierge_sales;
  l public.listings;
  v_ref text := nullif(left(trim(coalesce(p_ref, '')), 80), '');
  v_note text := nullif(left(trim(coalesce(p_note, '')), 1000), '');
begin
  if not public.is_staff() then raise exception 'sale: staff only' using errcode = '42501'; end if;
  select * into r from public.concierge_sales where id = p_id for update;
  if not found then raise exception 'sale: not found' using errcode = '22023'; end if;

  if p_step = 'pagada' then
    if r.status <> 'nueva' then raise exception 'sale: % → pagada is not allowed', r.status using errcode = '22023'; end if;
    if v_ref is null then raise exception 'sale: payment reference required' using errcode = '22023'; end if;
    update public.concierge_sales set status = 'pagada', payment_ref = v_ref, paid_at = now() where id = p_id;
    update public.listings set status = 'reserved' where id = r.listing_id and status = 'active';
  elsif p_step = 'retirada' then
    if r.status <> 'pagada' then raise exception 'sale: % → retirada is not allowed', r.status using errcode = '22023'; end if;
    if v_ref is null then raise exception 'sale: payout reference required' using errcode = '22023'; end if;
    update public.concierge_sales set status = 'retirada', payout_ref = v_ref, picked_up_at = now() where id = p_id;
  elsif p_step = 'programar' then
    if r.status not in ('pagada', 'retirada') then raise exception 'sale: can''t schedule a % sale', r.status using errcode = '22023'; end if;
    if p_date is null or p_date < current_date then raise exception 'sale: distribution date' using errcode = '22023'; end if;
    update public.concierge_sales set distribution_date = p_date where id = p_id;
  elsif p_step = 'en_ruta' then
    if r.status <> 'retirada' then raise exception 'sale: % → en_ruta is not allowed', r.status using errcode = '22023'; end if;
    update public.concierge_sales set status = 'en_ruta', out_at = now(), distribution_date = coalesce(distribution_date, current_date) where id = p_id;
  elsif p_step = 'entregada' then
    if r.status <> 'en_ruta' then raise exception 'sale: % → entregada is not allowed', r.status using errcode = '22023'; end if;
    update public.concierge_sales set status = 'entregada', delivered_at = now() where id = p_id;
    update public.listings set status = 'sold' where id = r.listing_id and status in ('active', 'reserved');
    select * into l from public.listings where id = r.listing_id;
    if found then
      insert into public.sales (listing_id, catalog_id, grading_key, condition, price_cents, via_protected)
      values (l.id, l.catalog_id,
              case when l.grading_company is null then 'raw' else l.grading_company || rtrim(rtrim(l.grade::text, '0'), '.') end,
              l.condition, r.price_cents, true)
      on conflict do nothing;
    end if;
    if r.inquiry_id is not null then
      update public.inquiries set status = 'cerrada', updated_at = now() where id = r.inquiry_id;
    end if;
  elsif p_step = 'cancelada' then
    if r.status not in ('nueva', 'pagada') then
      raise exception 'sale: a % sale can''t be cancelled here (the card was already picked up)', r.status using errcode = '22023';
    end if;
    if r.status = 'pagada' and v_ref is null then raise exception 'sale: refund reference required' using errcode = '22023'; end if;
    update public.concierge_sales set status = 'cancelada', refund_ref = v_ref, cancelled_at = now() where id = p_id;
    if r.status = 'pagada' then
      update public.listings set status = 'active' where id = r.listing_id and status = 'reserved';
    end if;
  else
    raise exception 'sale: unknown step %', p_step using errcode = '22023';
  end if;

  if v_note is not null then
    update public.concierge_sales set note = left(concat_ws(E'\n', nullif(note, ''), v_note), 1000) where id = p_id;
  end if;
  update public.concierge_sales set updated_at = now() where id = p_id returning * into r;
  return r;
end $$;

-- The Ventas tab: each sale with who sells (phone, pickup address and the Yappy we pay to) and who buys.
create or replace function public.staff_sales(p_status text default null)
returns table (id uuid, code text, status text, title text, listing_id uuid, inquiry_id uuid, inquiry_code text,
               price_cents int, shipping_cents int, commission_cents int, itbms_cents int, payout_cents int,
               buyer_id uuid, buyer_name text, buyer_phone text, delivery_address text,
               seller_id uuid, seller_name text, seller_kind text, seller_phone text, seller_pickup_address text, seller_yappy text,
               payment_ref text, payout_ref text, refund_ref text, distribution_date date, note text,
               created_at timestamptz, paid_at timestamptz, picked_up_at timestamptz, out_at timestamptz,
               delivered_at timestamptz, cancelled_at timestamptz)
  language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_staff() then raise exception 'sales: staff only' using errcode = '42501'; end if;
  return query
    select c.id, c.code, c.status, c.title, c.listing_id, c.inquiry_id, q.code, c.price_cents, c.shipping_cents, c.commission_cents,
           c.itbms_cents, c.payout_cents, c.buyer_id, c.buyer_name, c.buyer_phone, c.delivery_address,
           c.seller_id, p.display_name, public.staff_account_kind(c.seller_id), s.phone, coalesce(s.pickup_address, p.shop_address),
           coalesce((select r.yappy_phone from public.shop_requests r where r.user_id = c.seller_id and r.status = 'approved'
                      and r.yappy_phone is not null order by r.reviewed_at desc limit 1), s.phone),
           c.payment_ref, c.payout_ref, c.refund_ref, c.distribution_date, c.note,
           c.created_at, c.paid_at, c.picked_up_at, c.out_at, c.delivered_at, c.cancelled_at
      from public.concierge_sales c
      left join public.profiles p on p.id = c.seller_id
      left join public.seller_accounts s on s.user_id = c.seller_id
      left join public.inquiries q on q.id = c.inquiry_id
     where p_status is null or c.status = p_status
     order by case c.status when 'nueva' then 1 when 'pagada' then 2 when 'retirada' then 3 when 'en_ruta' then 4 else 5 end,
              c.distribution_date nulls last, c.created_at desc
     limit 500;
end $$;

revoke all on function public.staff_account_kind(uuid) from public, anon, authenticated;
revoke all on function public.staff_users(text, text) from public, anon;
revoke all on function public.staff_user_detail(uuid) from public, anon;
revoke all on function public.staff_create_sale(uuid, text, text, text, uuid, uuid, text) from public, anon;
revoke all on function public.staff_sale_step(uuid, text, text, date, text) from public, anon;
revoke all on function public.staff_sales(text) from public, anon;
grant execute on function public.staff_users(text, text) to authenticated;
grant execute on function public.staff_user_detail(uuid) to authenticated;
grant execute on function public.staff_create_sale(uuid, text, text, text, uuid, uuid, text) to authenticated;
grant execute on function public.staff_sale_step(uuid, text, text, date, text) to authenticated;
grant execute on function public.staff_sales(text) to authenticated;
