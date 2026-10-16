-- 0029: orders with escrow, Holo logistics, refunds and payouts. Run once in Supabase ▸ SQL Editor
-- after 0028. Replaces the Compra Protegida flow of 0014/0016/0027/0028 (decision 2026-10-15):
--
--   esperando_confirmacion_vendedor → pendiente_pago → pagada_retenida → esperando_entrega_vendedor
--   → en_custodia → en_camino → entregada → en_revision → completada
--   side exits: en_disputa, cancelada, reembolsada, fallida. Shop pickup skips custodia/en_camino.
--
-- What it adds:
--   * holo_settings: commission, shipping, every deadline, penalties and caps (staff can change them).
--   * order_transitions + a trigger: every status change is validated and written to
--     order_status_history (who, when, why). No code path can skip a step, not even staff.
--   * ledger_entries: double-entry ledger (debit > 0, credit < 0, each transaction sums to 0).
--     Seller balances are computed from it. Append-only.
--   * payment_notifications: every IPN received (valid or not), processed exactly once.
--   * order_photos, delivery_attempts, incidents, disputes, refund_requests, payouts, seller_penalties.
--   * run_order_deadlines() every 5 minutes (pg_cron) and prepare_weekly_payouts() on Mondays.
-- Money is always integer cents and always computed here from the database, never from the browser.

-- ================================================================== 1. settings
create table if not exists public.holo_settings (
  key text primary key,
  value bigint not null check (value >= 0),
  description text not null,
  updated_at timestamptz not null default now()
);
alter table public.holo_settings enable row level security;
drop policy if exists "staff read settings" on public.holo_settings;
create policy "staff read settings" on public.holo_settings for select using (public.is_staff());

insert into public.holo_settings (key, value, description) values
  ('commission_bps', 500, 'Comisión de Holo sobre el precio, en puntos básicos (500 = 5%), la paga el vendedor'),
  ('itbms_bps', 700, 'ITBMS sobre la comisión, en puntos básicos (700 = 7%)'),
  ('shipping_cents', 400, 'Envío que paga el comprador, en centavos (0 con retiro en tienda)'),
  ('delivery_retry_cents', 300, 'Costo del segundo intento de entrega, en centavos'),
  ('seller_confirm_minutes', 120, 'Minutos que tiene el vendedor para confirmar que aún tiene la carta'),
  ('payment_minutes', 10, 'Minutos para completar el pago (Yappy rechaza a los 5)'),
  ('seller_delivery_hours', 48, 'Horas que tiene el vendedor para entregar la carta o tenerla lista'),
  ('review_hours', 48, 'Horas que tiene el comprador para abrir una disputa después de la entrega'),
  ('remind_confirm_minutes', 30, 'Recordatorio al vendedor: minutos antes de que venza la confirmación'),
  ('remind_delivery_hours', 12, 'Recordatorio al vendedor: horas antes de que venza la entrega'),
  ('strike_window_days', 180, 'Días que cuenta una falta por no entregar'),
  ('warning_pause_days', 3, 'Falta 1: advertencia y anuncios pausados estos días'),
  ('suspension_strikes', 2, 'Faltas para la suspensión temporal'),
  ('suspension_days', 14, 'Días de suspensión'),
  ('ban_strikes', 3, 'Faltas para la expulsión'),
  ('shop_penalty_cents', 500, 'Penalización a tiendas verificadas por no entregar, en centavos'),
  ('new_seller_sales', 3, 'Ventas completadas para dejar de ser vendedor nuevo'),
  ('new_seller_max_price_cents', 15000, 'Precio máximo por anuncio de un vendedor nuevo, en centavos'),
  ('incident_max_cents', 20000, 'Máximo cubierto por envío en un incidente, en centavos'),
  ('delivery_code_max_failures', 5, 'Intentos fallidos del código de entrega antes de bloquearlo'),
  ('alert_pair_orders', 3, 'Alerta: órdenes pagadas entre el mismo comprador y vendedor'),
  ('alert_pair_days', 30, 'Alerta: ventana en días para las órdenes repetidas')
on conflict (key) do nothing;

-- Stuck-order alert: expected hours in each state.
create table if not exists public.order_state_sla (
  status text primary key,
  max_hours int not null check (max_hours > 0)
);
alter table public.order_state_sla enable row level security;
drop policy if exists "staff read sla" on public.order_state_sla;
create policy "staff read sla" on public.order_state_sla for select using (public.is_staff());
insert into public.order_state_sla values
  ('esperando_confirmacion_vendedor', 3), ('pendiente_pago', 1), ('pagada_retenida', 1),
  ('esperando_entrega_vendedor', 50), ('en_custodia', 48), ('en_camino', 24), ('entregada', 1),
  ('en_revision', 50), ('en_disputa', 72)
on conflict (status) do nothing;

create or replace function public.setting_int(p_key text) returns int
  language plpgsql stable security definer set search_path = public as $$
declare v bigint;
begin
  select value into v from public.holo_settings where key = p_key;
  if v is null then raise exception 'setting % missing', p_key; end if;
  return v::int;
end $$;

-- What the page needs to show prices and deadlines (no secrets here).
create or replace function public.public_order_settings() returns jsonb
  language sql stable security definer set search_path = public as $$
  select jsonb_object_agg(key, value) from public.holo_settings
   where key in ('commission_bps', 'itbms_bps', 'shipping_cents', 'delivery_retry_cents', 'seller_confirm_minutes',
                 'payment_minutes', 'seller_delivery_hours', 'review_hours', 'new_seller_sales', 'new_seller_max_price_cents')
$$;

create or replace function public.staff_set_setting(p_key text, p_value bigint) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  if p_value is null or p_value < 0 then raise exception 'setting: bad value' using errcode = '22023'; end if;
  if p_key like '%bps' and p_value > 10000 then raise exception 'setting: bps over 100%%' using errcode = '22023'; end if;
  update public.holo_settings set value = p_value, updated_at = now() where key = p_key;
  if not found then raise exception 'setting: unknown key %', p_key using errcode = '22023'; end if;
end $$;

-- ================================================================== 2. amounts
-- Seller pays the commission (+ ITBMS on it); buyer pays price + shipping. Half-up rounding.
-- Mirrors quoteOrder() in src/lib/fees.ts.
create or replace function public.protected_quote(p_price int) returns jsonb
  language sql stable security definer set search_path = public as $$
  with f as (select floor(p_price * public.setting_int('commission_bps') / 10000.0 + 0.5)::int as seller_fee),
       t as (select seller_fee, floor(seller_fee * public.setting_int('itbms_bps') / 10000.0 + 0.5)::int as seller_itbms from f)
  select jsonb_build_object('price', p_price,
                            'fee', 0, 'itbms', 0, 'total', p_price,
                            'seller_fee', seller_fee, 'seller_itbms', seller_itbms,
                            'payout', p_price - seller_fee - seller_itbms)
  from t
$$;

create or replace function public.order_quote(p_price int, p_pickup boolean default false) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare
  q jsonb;
  ship int := case when p_pickup then 0 else public.setting_int('shipping_cents') end;
begin
  if p_price is null or p_price <= 0 then raise exception 'quote: price must be positive' using errcode = '22023'; end if;
  q := public.protected_quote(p_price);
  return q || jsonb_build_object('shipping', ship, 'total', p_price + ship);
end $$;

-- ================================================================== 3. order columns and statuses
alter table public.protected_orders
  add column if not exists shipping_cents int not null default 0 check (shipping_cents >= 0),
  add column if not exists seller_confirm_deadline timestamptz,
  add column if not exists payment_deadline timestamptz,
  add column if not exists delivery_deadline timestamptz,
  add column if not exists review_deadline timestamptz,
  add column if not exists reminded_status text,             -- last deadline reminder sent (per status)
  add column if not exists status_changed_at timestamptz not null default now(),
  add column if not exists seller_confirmed_at timestamptz,
  add column if not exists picked_up_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists closed_at timestamptz,            -- cancelada / reembolsada / fallida
  add column if not exists close_reason text check (char_length(close_reason) <= 300),
  add column if not exists delivery_code_failures int not null default 0,
  add column if not exists retry_fee_cents int not null default 0 check (retry_fee_cents >= 0),
  add column if not exists retry_paid_at timestamptz;

alter table public.protected_orders drop constraint if exists protected_orders_status_check;
alter table public.protected_orders alter column status drop default;

-- Old statuses → new ones (the guard trigger is created below, after this).
update public.protected_orders set status = 'pendiente_pago',
       payment_deadline = greatest(coalesce(hold_until, now()), now() + interval '10 minutes')
 where status = 'awaiting_payment';
update public.protected_orders set status = 'esperando_entrega_vendedor',
       delivery_deadline = now() + interval '48 hours'
 where status in ('paid', 'verifying');
update public.protected_orders set status = 'en_disputa'
 where status = 'delivered' and claimed_at is not null and claim_outcome is null;
update public.protected_orders set status = 'en_revision',
       review_deadline = case when buyer_confirmed_at is not null or claim_outcome = 'rejected' then now()
                              else coalesce(delivered_at, now()) + interval '3 days' end
 where status = 'delivered';
update public.protected_orders set status = 'completada', completed_at = coalesce(released_at, updated_at) where status = 'released';
update public.protected_orders set status = 'reembolsada', closed_at = updated_at where status = 'refunded';
update public.protected_orders set status = 'cancelada', closed_at = updated_at where status = 'cancelled';

alter table public.protected_orders add constraint protected_orders_status_check check (status in (
  'esperando_confirmacion_vendedor', 'pendiente_pago', 'pagada_retenida', 'esperando_entrega_vendedor',
  'en_custodia', 'en_camino', 'entregada', 'en_revision', 'completada', 'en_disputa',
  'cancelada', 'reembolsada', 'fallida'));
alter table public.protected_orders alter column status set default 'esperando_confirmacion_vendedor';
create index if not exists protected_orders_status_idx on public.protected_orders (status, status_changed_at);

-- A paid listing is "sold" right away now (it used to stay "reserved" until the payout).
update public.listings set status = 'sold' where status = 'reserved';

-- ================================================================== 4. state machine
create table if not exists public.order_transitions (
  from_status text not null,
  to_status text not null,
  actors text[] not null,
  primary key (from_status, to_status)
);
alter table public.order_transitions enable row level security;
drop policy if exists "anyone reads transitions" on public.order_transitions;
create policy "anyone reads transitions" on public.order_transitions for select using (true);
delete from public.order_transitions;
insert into public.order_transitions (from_status, to_status, actors) values
  ('esperando_confirmacion_vendedor', 'pendiente_pago',             '{vendedor,admin}'),
  ('esperando_confirmacion_vendedor', 'cancelada',                  '{vendedor,comprador,sistema,admin}'),
  ('pendiente_pago',                  'pagada_retenida',            '{proveedor,admin}'),
  ('pendiente_pago',                  'fallida',                    '{proveedor,sistema,admin}'),
  ('pendiente_pago',                  'cancelada',                  '{comprador,admin}'),
  ('pagada_retenida',                 'esperando_entrega_vendedor', '{proveedor,sistema,admin}'),
  ('pagada_retenida',                 'reembolsada',                '{proveedor,sistema,admin}'),
  ('esperando_entrega_vendedor',      'en_custodia',                '{admin}'),
  ('esperando_entrega_vendedor',      'entregada',                  '{vendedor,admin}'),
  ('esperando_entrega_vendedor',      'cancelada',                  '{sistema,admin}'),
  ('en_custodia',                     'en_camino',                  '{admin}'),
  ('en_custodia',                     'reembolsada',                '{admin}'),
  ('en_camino',                       'entregada',                  '{admin}'),
  ('en_camino',                       'en_custodia',                '{admin}'),
  ('en_camino',                       'reembolsada',                '{admin}'),
  ('entregada',                       'en_revision',                '{sistema,admin}'),
  ('en_revision',                     'completada',                 '{sistema,comprador,admin}'),
  ('en_revision',                     'en_disputa',                 '{comprador,admin}'),
  ('en_disputa',                      'completada',                 '{admin}'),
  ('en_disputa',                      'reembolsada',                '{admin}');

create table if not exists public.order_status_history (
  id bigserial primary key,
  order_id uuid not null references public.protected_orders on delete cascade,
  from_status text,
  to_status text not null,
  actor_kind text not null check (actor_kind in ('comprador', 'vendedor', 'admin', 'sistema', 'proveedor')),
  actor_id uuid,
  reason text check (char_length(reason) <= 500),
  created_at timestamptz not null default now()
);
create index if not exists order_status_history_order_idx on public.order_status_history (order_id, id);
alter table public.order_status_history enable row level security;
drop policy if exists "parties read history" on public.order_status_history;
create policy "parties read history" on public.order_status_history for select using (
  public.is_staff() or exists (select 1 from public.protected_orders o where o.id = order_id
                                and auth.uid() in (o.buyer_id, o.seller_id)));

-- Who is acting: set by order_move(); a direct update by staff is "admin", a job "sistema".
create or replace function public.order_actor() returns text
  language sql stable security definer set search_path = public as $$
  select coalesce(nullif(current_setting('holo.actor', true), ''),
                  case when public.is_staff() then 'admin' when auth.uid() is null then 'sistema' else 'comprador' end)
$$;

create or replace function public.guard_order_status() returns trigger
  language plpgsql security definer set search_path = public as $$
declare actor text := public.order_actor();
begin
  if tg_op = 'INSERT' then
    if new.status not in ('esperando_confirmacion_vendedor', 'pendiente_pago') then
      raise exception 'order_transition: a new order can''t start as %', new.status using errcode = '22023';
    end if;
    new.status_changed_at := now();
    return new;
  end if;
  if new.status is distinct from old.status then
    if not exists (select 1 from public.order_transitions
                   where from_status = old.status and to_status = new.status and actor = any(actors)) then
      raise exception 'order_transition: % → % not allowed for %', old.status, new.status, actor using errcode = '22023';
    end if;
    new.status_changed_at := now();
    new.reminded_status := null;
    if new.status in ('cancelada', 'reembolsada', 'fallida') then new.closed_at := now(); end if;
    if new.status = 'completada' then new.completed_at := now(); end if;
  end if;
  return new;
end $$;

create or replace function public.log_order_status() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.order_status_history (order_id, from_status, to_status, actor_kind, actor_id, reason)
    values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status, public.order_actor(), auth.uid(),
            nullif(current_setting('holo.reason', true), ''));
  end if;
  return null;
end $$;

-- Existing orders get one history row saying where they came from.
insert into public.order_status_history (order_id, from_status, to_status, actor_kind, reason, created_at)
select o.id, null, o.status, 'sistema', 'Migración 0029 (orden anterior al flujo nuevo)', now()
  from public.protected_orders o
 where not exists (select 1 from public.order_status_history h where h.order_id = o.id);

drop trigger if exists protected_orders_status_guard on public.protected_orders;
create trigger protected_orders_status_guard before insert or update of status on public.protected_orders
  for each row execute function public.guard_order_status();
drop trigger if exists protected_orders_status_log on public.protected_orders;
create trigger protected_orders_status_log after insert or update of status on public.protected_orders
  for each row execute function public.log_order_status();

-- The one way functions change an order's status: records who and why for the trigger above.
create or replace function public.order_move(p_order uuid, p_to text, p_actor text, p_reason text default null)
  returns public.protected_orders language plpgsql security definer set search_path = public as $$
declare o public.protected_orders;
begin
  perform set_config('holo.actor', p_actor, true);
  perform set_config('holo.reason', coalesce(p_reason, ''), true);
  update public.protected_orders set status = p_to where id = p_order returning * into o;
  perform set_config('holo.actor', '', true);
  perform set_config('holo.reason', '', true);
  return o;
end $$;

-- ================================================================== 5. ledger (double entry)
-- amount_cents > 0 is a debit, < 0 a credit; the lines of one txn_id always sum to 0.
--   banco               Holo's bank / Yappy Comercial account (asset)
--   retencion           money held for an order (escrow, liability; one balance per order_id)
--   vendedor            what Holo owes a seller (liability; party_id = seller); balance = -sum
--   comprador           refunds owed to a buyer (liability; party_id = buyer)
--   holo_comision, holo_itbms, holo_envio, holo_penalizaciones   income and tax payable
--   fondo_reserva       reserve that covers losses in Holo's custody (debits = money spent)
create table if not exists public.ledger_entries (
  id bigserial primary key,
  txn_id uuid not null,
  order_id uuid references public.protected_orders,
  account text not null check (account in ('banco', 'retencion', 'vendedor', 'comprador', 'holo_comision',
                                            'holo_itbms', 'holo_envio', 'holo_penalizaciones', 'fondo_reserva')),
  party_id uuid references public.profiles,
  kind text not null check (kind in ('cobro', 'retencion', 'venta', 'comision', 'itbms', 'envio', 'liquidacion',
                                     'reembolso', 'penalizacion', 'fondo_reserva')),
  amount_cents bigint not null check (amount_cents <> 0),
  memo text check (char_length(memo) <= 300),
  created_by uuid,
  created_at timestamptz not null default now(),
  check ((account in ('vendedor', 'comprador')) = (party_id is not null))
);
create index if not exists ledger_entries_order_idx on public.ledger_entries (order_id);
create index if not exists ledger_entries_party_idx on public.ledger_entries (account, party_id);
create index if not exists ledger_entries_txn_idx on public.ledger_entries (txn_id);
alter table public.ledger_entries enable row level security;
drop policy if exists "staff read ledger" on public.ledger_entries;
create policy "staff read ledger" on public.ledger_entries for select using (public.is_staff());

create or replace function public.ledger_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception 'ledger: entries can''t be changed or deleted; post a reversing entry' using errcode = '42501';
end $$;
drop trigger if exists ledger_entries_append_only on public.ledger_entries;
create trigger ledger_entries_append_only before update or delete on public.ledger_entries
  for each row execute function public.ledger_append_only();

-- p_lines: [{"account": "...", "party": uuid|null, "kind": "...", "amount": int}, ...]; zero lines are skipped.
create or replace function public.ledger_post(p_order uuid, p_lines jsonb, p_memo text default null,
                                              p_at timestamptz default now()) returns uuid
  language plpgsql security definer set search_path = public as $$
declare
  txn uuid := gen_random_uuid();
  l jsonb;
  total bigint := 0;
begin
  for l in select * from jsonb_array_elements(p_lines) loop
    if coalesce((l->>'amount')::bigint, 0) = 0 then continue; end if;
    insert into public.ledger_entries (txn_id, order_id, account, party_id, kind, amount_cents, memo, created_by, created_at)
    values (txn, p_order, l->>'account', nullif(l->>'party', '')::uuid, l->>'kind', (l->>'amount')::bigint,
            left(p_memo, 300), auth.uid(), p_at);
    total := total + (l->>'amount')::bigint;
  end loop;
  if total <> 0 then raise exception 'ledger: transaction does not balance (%)', total using errcode = '22023'; end if;
  return txn;
end $$;

create or replace function public.ledger_line(p_account text, p_kind text, p_amount bigint, p_party uuid default null)
  returns jsonb language sql immutable as $$
  select jsonb_build_object('account', p_account, 'kind', p_kind, 'amount', p_amount, 'party', p_party)
$$;

-- Escrow still held for an order, and what a seller is owed (credit balance).
create or replace function public.order_escrow_cents(p_order uuid) returns bigint
  language sql stable security definer set search_path = public as $$
  select coalesce(-sum(amount_cents), 0) from public.ledger_entries where account = 'retencion' and order_id = p_order
$$;
create or replace function public.seller_ledger_balance(p_seller uuid) returns bigint
  language sql stable security definer set search_path = public as $$
  select coalesce(-sum(amount_cents), 0) from public.ledger_entries where account = 'vendedor' and party_id = p_seller
$$;

-- Money in: the buyer paid; it is held for the order.
create or replace function public.post_charge(o public.protected_orders, p_amount bigint, p_memo text)
  returns uuid language sql security definer set search_path = public as $$
  select public.ledger_post(o.id, jsonb_build_array(
    public.ledger_line('banco', 'cobro', p_amount),
    public.ledger_line('retencion', 'retencion', -p_amount)), p_memo)
$$;

-- The sale is final: escrow → seller (net), Holo (commission, ITBMS, shipping) and, after a
-- partial dispute, part of it back to the buyer. Commission is charged on what the seller keeps.
create or replace function public.post_completion(o public.protected_orders, p_buyer_refund int default 0)
  returns uuid language plpgsql security definer set search_path = public as $$
declare
  held bigint := public.order_escrow_cents(o.id);
  price int := o.price_cents - coalesce(p_buyer_refund, 0);
  fee int;
  tax int;
begin
  if price <= 0 then raise exception 'completion: refund must be less than the price' using errcode = '22023'; end if;
  if held <> o.price_cents + o.shipping_cents + o.fee_cents + o.itbms_cents then
    raise exception 'completion: escrow % does not match order total', held using errcode = '22023';
  end if;
  if coalesce(p_buyer_refund, 0) = 0 then
    fee := o.seller_fee_cents; tax := o.seller_itbms_cents;           -- the amounts fixed at checkout
  else
    fee := (public.protected_quote(price)->>'seller_fee')::int;
    tax := (public.protected_quote(price)->>'seller_itbms')::int;
  end if;
  return public.ledger_post(o.id, jsonb_build_array(
    public.ledger_line('retencion', 'retencion', held),
    public.ledger_line('vendedor', 'venta', -(price - fee - tax), o.seller_id),
    public.ledger_line('holo_comision', 'comision', -(fee + o.fee_cents)),
    public.ledger_line('holo_itbms', 'itbms', -(tax + o.itbms_cents)),
    public.ledger_line('holo_envio', 'envio', -o.shipping_cents),
    public.ledger_line('comprador', 'reembolso', -coalesce(p_buyer_refund, 0), o.buyer_id)),
    case when coalesce(p_buyer_refund, 0) > 0 then 'Venta completada con reembolso parcial' else 'Venta completada' end);
end $$;

-- ================================================================== 6. supporting tables
create table if not exists public.refund_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.protected_orders,
  recipient_id uuid not null references public.profiles,
  amount_cents int not null check (amount_cents > 0),
  reason text not null check (char_length(reason) between 3 and 300),
  status text not null default 'pendiente' check (status in ('pendiente', 'pagado')),
  paid_ref text check (char_length(paid_ref) <= 120),
  paid_by uuid,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists refund_requests_status_idx on public.refund_requests (status, created_at);

create table if not exists public.payouts (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.profiles,
  amount_cents int not null check (amount_cents > 0),
  status text not null default 'pendiente' check (status in ('pendiente', 'pagado', 'anulado')),
  week_of date not null,
  paid_ref text check (char_length(paid_ref) <= 120),
  paid_by uuid,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists payouts_one_pending on public.payouts (seller_id) where status = 'pendiente';

create table if not exists public.disputes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.protected_orders,
  opened_by uuid references public.profiles,
  reason text not null check (char_length(reason) between 10 and 1000),
  photos text[] not null default '{}' check (cardinality(photos) <= 6),
  status text not null default 'abierta' check (status in ('abierta', 'resuelta')),
  outcome text check (outcome in ('comprador_total', 'comprador_parcial', 'vendedor')),
  refund_cents int check (refund_cents >= 0),
  resolution_note text check (char_length(resolution_note) <= 500),
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.order_photos (
  id bigserial primary key,
  order_id uuid not null references public.protected_orders on delete cascade,
  stage text not null check (stage in ('recogida', 'entrega')),
  side text not null default 'otra' check (side in ('frente', 'reverso', 'otra')),
  path text not null check (char_length(path) <= 300),
  uploaded_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists order_photos_order_idx on public.order_photos (order_id);

create table if not exists public.delivery_attempts (
  id bigserial primary key,
  order_id uuid not null references public.protected_orders on delete cascade,
  attempt int not null check (attempt between 1 and 2),
  started_at timestamptz not null default now(),
  result text check (result in ('entregada', 'ausente', 'incidente')),
  note text check (char_length(note) <= 300),
  finished_at timestamptz,
  unique (order_id, attempt)
);

create table if not exists public.incidents (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.protected_orders,
  kind text not null check (kind in ('perdida', 'dano', 'accidente', 'robo')),
  responsible text not null check (responsible in ('holo', 'mensajero', 'vendedor', 'comprador', 'tercero')),
  description text not null check (char_length(description) between 3 and 1000),
  covered_cents int not null default 0 check (covered_cents >= 0),
  created_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.seller_penalties (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.profiles,
  order_id uuid references public.protected_orders,
  level text not null check (level in ('advertencia', 'suspension', 'expulsion')),
  amount_cents int not null default 0 check (amount_cents >= 0),
  reason text not null,
  ends_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists seller_penalties_seller_idx on public.seller_penalties (seller_id, created_at);

-- The 4-digit code the buyer gives the courier. Only the buyer can read it (not the seller, not staff
-- through the page); functions check it.
create table if not exists public.order_delivery_codes (
  order_id uuid primary key references public.protected_orders on delete cascade,
  code text not null check (code ~ '^[0-9]{4}$')
);

create table if not exists public.payment_notifications (
  id bigserial primary key,
  received_at timestamptz not null default now(),
  provider text not null default 'yappy',
  attempt_id text,
  status text,
  domain text,
  hash text,
  valid boolean not null,
  processed boolean not null default false,
  result text,
  raw jsonb
);
create unique index if not exists payment_notifications_once on public.payment_notifications (attempt_id, status) where processed;
create index if not exists payment_notifications_received_idx on public.payment_notifications (received_at desc);

alter table public.payment_attempts
  add column if not exists purpose text not null default 'orden' check (purpose in ('orden', 'reintento'));
alter table public.payment_attempts drop constraint if exists payment_attempts_provider_check;
alter table public.payment_attempts add constraint payment_attempts_provider_check check (provider in ('yappy', 'tilopay', 'mock'));

do $$
declare t text;
begin
  foreach t in array array['refund_requests', 'payouts', 'disputes', 'order_photos', 'delivery_attempts',
                           'incidents', 'seller_penalties', 'order_delivery_codes', 'payment_notifications'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "staff read %s" on public.%I', t, t);
    execute format('create policy "staff read %s" on public.%I for select using (public.is_staff())', t, t);
  end loop;
end $$;
drop policy if exists "staff read order_delivery_codes" on public.order_delivery_codes;
drop policy if exists "buyer reads delivery code" on public.order_delivery_codes;
create policy "buyer reads delivery code" on public.order_delivery_codes for select using (
  exists (select 1 from public.protected_orders o where o.id = order_id and o.buyer_id = auth.uid()));
drop policy if exists "parties read order photos" on public.order_photos;
create policy "parties read order photos" on public.order_photos for select using (
  exists (select 1 from public.protected_orders o where o.id = order_id and auth.uid() in (o.buyer_id, o.seller_id)));
drop policy if exists "seller reads own payouts" on public.payouts;
create policy "seller reads own payouts" on public.payouts for select using (seller_id = auth.uid());
drop policy if exists "seller reads own penalties" on public.seller_penalties;
create policy "seller reads own penalties" on public.seller_penalties for select using (seller_id = auth.uid());

-- Photos of the card at pickup and delivery: private bucket, "<order id>/<file>", staff upload.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('order-photos', 'order-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
drop policy if exists "staff upload order photos" on storage.objects;
create policy "staff upload order photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'order-photos' and public.is_staff());
drop policy if exists "parties read order photos" on storage.objects;
create policy "parties read order photos" on storage.objects for select to authenticated
  using (bucket_id = 'order-photos' and (public.is_staff() or exists (
    select 1 from public.protected_orders o
     where o.id::text = (storage.foldername(name))[1] and auth.uid() in (o.buyer_id, o.seller_id))));

-- ================================================================== 7. seller standing
alter table public.profiles
  add column if not exists selling_blocked_until timestamptz,
  add column if not exists banned_at timestamptz;
alter table public.listings add column if not exists paused_by_penalty boolean not null default false;

create or replace function public.seller_blocked(p_seller uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select banned_at is not null or selling_blocked_until > now() from public.profiles where id = p_seller), false)
$$;
create or replace function public.seller_completed_sales(p_seller uuid) returns int
  language sql stable security definer set search_path = public as $$
  select count(*)::int from public.protected_orders where seller_id = p_seller and status = 'completada'
$$;

-- Users can't lift their own penalty.
create or replace function public.guard_profile_standing() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin_context() then return new; end if;
  if tg_op = 'INSERT' then
    new.selling_blocked_until := null; new.banned_at := null;
  elsif new.selling_blocked_until is distinct from old.selling_blocked_until or new.banned_at is distinct from old.banned_at then
    raise exception 'only staff can change a seller''s standing' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists profiles_standing_guard on public.profiles;
create trigger profiles_standing_guard before insert or update on public.profiles
  for each row execute function public.guard_profile_standing();

-- Blocked sellers can't publish; new sellers (not verified shops) have a price cap until N completed sales.
create or replace function public.guard_listing_seller() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin_context() then return new; end if;
  if new.paused_by_penalty is distinct from (case when tg_op = 'UPDATE' then old.paused_by_penalty else false end) then
    raise exception 'only staff can pause or unpause listings' using errcode = '42501';
  end if;
  if new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from 'active') then
    if public.seller_blocked(new.seller_id) or new.paused_by_penalty then
      raise exception 'seller_blocked: your account can''t publish right now' using errcode = '42501';
    end if;
  end if;
  if new.status in ('draft', 'active') and (tg_op = 'INSERT' or new.price_cents is distinct from old.price_cents
                                            or new.status is distinct from old.status)
     and new.price_cents > public.setting_int('new_seller_max_price_cents')
     and public.seller_completed_sales(new.seller_id) < public.setting_int('new_seller_sales')
     and not exists (select 1 from public.profiles where id = new.seller_id and is_shop and verified) then
    raise exception 'new_seller_price_cap: max % until % completed sales',
      public.usd(public.setting_int('new_seller_max_price_cents')), public.setting_int('new_seller_sales') using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists listings_seller_guard on public.listings;
create trigger listings_seller_guard before insert or update on public.listings
  for each row execute function public.guard_listing_seller();

-- 0010's seller flow, with the new open statuses (same rules otherwise).
create or replace function public.order_is_open(p_status text) returns boolean
  language sql immutable as $$
  select p_status in ('esperando_confirmacion_vendedor', 'pendiente_pago', 'pagada_retenida', 'esperando_entrega_vendedor',
                      'en_custodia', 'en_camino', 'entregada', 'en_revision', 'en_disputa')
$$;

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
           where listing_id = old.id and public.order_is_open(status)) then
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

-- Units (0027): an order holds a unit from the request until it closes without a sale.
create or replace function public.listing_units_taken(p_listing uuid) returns int
  language sql stable security definer set search_path = public as $$
  select count(*)::int from public.protected_orders
   where listing_id = p_listing and status not in ('esperando_confirmacion_vendedor', 'pendiente_pago',
                                                   'cancelada', 'reembolsada', 'fallida')
$$;
create or replace function public.listing_units_held(p_listing uuid) returns int
  language sql stable security definer set search_path = public as $$
  select count(*)::int from public.protected_orders
   where listing_id = p_listing and public.order_is_open(status)
$$;
-- Paid: the listing shows as sold as soon as every unit is paid for.
create or replace function public.listing_after_paid(p_listing uuid) returns void
  language sql security definer set search_path = public as $$
  update public.listings set status = 'sold'
   where id = p_listing and status in ('active', 'reserved') and public.listing_units_taken(id) >= quantity
$$;
create or replace function public.listing_after_release(p_listing uuid) returns void
  language sql security definer set search_path = public as $$
  select public.listing_after_paid(p_listing)
$$;
-- Back on sale when a paid order is undone and the card is still the seller's.
create or replace function public.listing_after_refund(p_listing uuid) returns void
  language sql security definer set search_path = public as $$
  update public.listings set status = 'active'
   where id = p_listing and status in ('sold', 'reserved') and public.listing_units_taken(id) < quantity
$$;

-- Progressive penalty for not delivering: warning + listings paused → temporary suspension → ban.
-- Verified shops also pay shop_penalty_cents, taken from their next payouts.
create or replace function public.penalize_no_delivery(o public.protected_orders) returns text
  language plpgsql security definer set search_path = public as $$
declare
  strikes int;
  lvl text;
  v_until timestamptz;
  fine int := 0;
  seller public.profiles;
begin
  select * into seller from public.profiles where id = o.seller_id for update;
  select count(*) + 1 into strikes from public.seller_penalties
   where seller_id = o.seller_id and created_at > now() - make_interval(days => public.setting_int('strike_window_days'));
  if strikes >= public.setting_int('ban_strikes') then
    lvl := 'expulsion';
  elsif strikes >= public.setting_int('suspension_strikes') then
    lvl := 'suspension'; v_until := now() + make_interval(days => public.setting_int('suspension_days'));
  else
    lvl := 'advertencia'; v_until := now() + make_interval(days => public.setting_int('warning_pause_days'));
  end if;
  if seller.is_shop and seller.verified then fine := public.setting_int('shop_penalty_cents'); end if;

  insert into public.seller_penalties (seller_id, order_id, level, amount_cents, reason, ends_at)
  values (o.seller_id, o.id, lvl, fine, 'No entregó la carta a tiempo', v_until);
  if fine > 0 then
    perform public.ledger_post(o.id, jsonb_build_array(
      public.ledger_line('vendedor', 'penalizacion', fine, o.seller_id),
      public.ledger_line('holo_penalizaciones', 'penalizacion', -fine)), 'Penalización por no entregar');
  end if;

  if lvl = 'expulsion' then
    update public.profiles set banned_at = now() where id = o.seller_id;
    update public.listings set status = 'removed' where seller_id = o.seller_id and status in ('draft', 'active');
  else
    update public.profiles set selling_blocked_until = greatest(coalesce(selling_blocked_until, now()), v_until)
     where id = o.seller_id;
    update public.listings set status = 'draft', paused_by_penalty = true
     where seller_id = o.seller_id and status = 'active'
       and not exists (select 1 from public.protected_orders x where x.listing_id = listings.id and public.order_is_open(x.status));
  end if;
  perform public.notify(o.seller_id, 'seller_penalty',
    case lvl when 'advertencia' then 'Advertencia: no entregaste una carta a tiempo'
             when 'suspension' then 'Tu cuenta de vendedor está suspendida'
             else 'Tu cuenta de vendedor fue cerrada' end,
    case lvl when 'expulsion' then 'Acumulaste ' || strikes || ' ventas sin entregar.'
             else 'Tus anuncios quedan pausados hasta el ' || to_char(v_until at time zone 'America/Panama', 'DD/MM HH24:MI') || '.' end
    || case when fine > 0 then ' Penalización: ' || public.usd(fine) || ', descontada de tu próxima liquidación.' else '' end,
    '#/cuenta');
  return lvl;
end $$;

-- ================================================================== 8. refunds and payouts
-- Creates the manual refund request and moves the money from the order's escrow to the buyer.
-- p_keep_shipping: Holo keeps the shipping (failed delivery: the trip was made).
create or replace function public.request_refund(o public.protected_orders, p_amount int, p_reason text,
                                                 p_keep_shipping int default 0) returns uuid
  language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  if p_amount <= 0 then return null; end if;
  if public.order_escrow_cents(o.id) < p_amount + p_keep_shipping then
    raise exception 'refund: escrow too small' using errcode = '22023';
  end if;
  perform public.ledger_post(o.id, jsonb_build_array(
    public.ledger_line('retencion', 'retencion', p_amount + p_keep_shipping),
    public.ledger_line('comprador', 'reembolso', -p_amount, o.buyer_id),
    public.ledger_line('holo_envio', 'envio', -p_keep_shipping)), p_reason);
  insert into public.refund_requests (order_id, recipient_id, amount_cents, reason)
  values (o.id, o.buyer_id, p_amount, left(p_reason, 300)) returning id into rid;
  return rid;
end $$;

create or replace function public.staff_mark_refund_paid(p_refund uuid, p_ref text) returns void
  language plpgsql security definer set search_path = public as $$
declare r public.refund_requests;
begin
  if not public.is_admin_context() then raise exception 'staff only' using errcode = '42501'; end if;
  if char_length(trim(coalesce(p_ref, ''))) < 3 then raise exception 'refund: reference required' using errcode = '22023'; end if;
  select * into r from public.refund_requests where id = p_refund for update;
  if not found or r.status <> 'pendiente' then raise exception 'refund: not pending' using errcode = '22023'; end if;
  perform public.ledger_post(r.order_id, jsonb_build_array(
    public.ledger_line('comprador', 'reembolso', r.amount_cents, r.recipient_id),
    public.ledger_line('banco', 'reembolso', -r.amount_cents)), 'Reembolso pagado: ' || trim(p_ref));
  update public.refund_requests set status = 'pagado', paid_ref = left(trim(p_ref), 120), paid_by = auth.uid(), paid_at = now()
   where id = r.id;
  perform public.notify(r.recipient_id, 'refund_paid', 'Te devolvimos ' || public.usd(r.amount_cents),
    'Referencia: ' || left(trim(p_ref), 120), '#/cuenta');
end $$;

-- Weekly: one pending payout per seller with money available (completed orders, minus penalties,
-- minus what is already pending). Runs on Mondays; staff can also run it.
create or replace function public.seller_available_cents(p_seller uuid) returns bigint
  language sql stable security definer set search_path = public as $$
  select public.seller_ledger_balance(p_seller)
       - coalesce((select sum(amount_cents) from public.payouts where seller_id = p_seller and status = 'pendiente'), 0)
$$;

create or replace function public.prepare_weekly_payouts() returns int
  language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_admin_context() then raise exception 'staff only' using errcode = '42501'; end if;
  with sellers as (select distinct party_id as id from public.ledger_entries where account = 'vendedor'),
       x as (insert into public.payouts (seller_id, amount_cents, week_of)
             select s.id, public.seller_available_cents(s.id)::int,
                    date_trunc('week', now() at time zone 'America/Panama')::date
               from sellers s
              where public.seller_available_cents(s.id) > 0
                and not exists (select 1 from public.payouts p where p.seller_id = s.id and p.status = 'pendiente')
             returning 1)
  select count(*)::int into n from x;
  return n;
end $$;

create or replace function public.staff_mark_payout_paid(p_payout uuid, p_ref text) returns void
  language plpgsql security definer set search_path = public as $$
declare p public.payouts;
begin
  if not public.is_admin_context() then raise exception 'staff only' using errcode = '42501'; end if;
  if char_length(trim(coalesce(p_ref, ''))) < 3 then raise exception 'payout: reference required' using errcode = '22023'; end if;
  select * into p from public.payouts where id = p_payout for update;
  if not found or p.status <> 'pendiente' then raise exception 'payout: not pending' using errcode = '22023'; end if;
  if public.seller_ledger_balance(p.seller_id) < p.amount_cents then
    raise exception 'payout: balance changed, void it and prepare again' using errcode = '22023';
  end if;
  perform public.ledger_post(null, jsonb_build_array(
    public.ledger_line('vendedor', 'liquidacion', p.amount_cents, p.seller_id),
    public.ledger_line('banco', 'liquidacion', -p.amount_cents)), 'Liquidación semanal: ' || trim(p_ref));
  update public.payouts set status = 'pagado', paid_ref = left(trim(p_ref), 120), paid_by = auth.uid(), paid_at = now()
   where id = p.id;
  perform public.notify(p.seller_id, 'payout_paid', 'Te pagamos ' || public.usd(p.amount_cents),
    'Liquidación semanal. Referencia: ' || left(trim(p_ref), 120), '#/cuenta');
end $$;

create or replace function public.staff_void_payout(p_payout uuid) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin_context() then raise exception 'staff only' using errcode = '42501'; end if;
  update public.payouts set status = 'anulado' where id = p_payout and status = 'pendiente';
  if not found then raise exception 'payout: not pending' using errcode = '22023'; end if;
end $$;

-- ================================================================== 9. order flow
create or replace function public.new_delivery_code() returns text
  language sql volatile as $$
  select lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint) % 10000)::text, 4, '0')
$$;

-- Buyer asks to buy. The seller then has seller_confirm_minutes to confirm they still have it;
-- nothing is charged yet. With an accepted offer the seller already said yes: straight to payment.
create or replace function public.request_order(p_listing uuid, p_pickup boolean default false)
  returns public.protected_orders language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  l public.listings;
  o public.protected_orders;
  offer_price int;
  price int;
  q jsonb;
  pickup boolean := coalesce(p_pickup, false);
begin
  if uid is null then raise exception 'login required' using errcode = '42501'; end if;
  select * into l from public.listings where id = p_listing for update;
  if not found or l.status <> 'active' then raise exception 'order: listing not available' using errcode = '22023'; end if;
  if l.seller_id = uid then raise exception 'order: own listing' using errcode = '22023'; end if;
  if public.seller_blocked(l.seller_id) then raise exception 'order: seller can''t sell right now' using errcode = '22023'; end if;
  select * into o from public.protected_orders
   where listing_id = l.id and buyer_id = uid and status in ('esperando_confirmacion_vendedor', 'pendiente_pago');
  if found then return o; end if;
  if public.listing_units_held(l.id) >= l.quantity then
    raise exception 'order: listing on hold' using errcode = '22023';
  end if;
  if (select count(*) from public.protected_orders where buyer_id = uid and created_at > now() - interval '1 day') >= 20 then
    raise exception 'order: too many' using errcode = '22023';
  end if;
  if pickup and not exists (select 1 from public.profiles where id = l.seller_id and is_shop and verified and shop_pickup) then
    raise exception 'order: no pickup' using errcode = '22023';
  end if;
  select amount_cents into offer_price from public.offers
   where listing_id = l.id and buyer_id = uid and status = 'accepted' order by updated_at desc limit 1;
  price := coalesce(offer_price, l.price_cents);
  q := public.order_quote(price, pickup);

  perform set_config('holo.actor', 'comprador', true);
  perform set_config('holo.reason', case when offer_price is null then 'Solicitud de compra' else 'Oferta aceptada: va directo al pago' end, true);
  insert into public.protected_orders (listing_id, buyer_id, seller_id, price_cents, fee_cents, itbms_cents,
                                       seller_fee_cents, seller_itbms_cents, shipping_cents, pickup, status, source,
                                       seller_confirm_deadline, seller_confirmed_at, payment_deadline)
  values (l.id, uid, l.seller_id, price, (q->>'fee')::int, (q->>'itbms')::int,
          (q->>'seller_fee')::int, (q->>'seller_itbms')::int, (q->>'shipping')::int, pickup,
          case when offer_price is null then 'esperando_confirmacion_vendedor' else 'pendiente_pago' end, 'checkout',
          case when offer_price is null then now() + make_interval(mins => public.setting_int('seller_confirm_minutes')) end,
          case when offer_price is not null then now() end,
          case when offer_price is not null then now() + make_interval(mins => public.setting_int('payment_minutes')) end)
  returning * into o;
  perform set_config('holo.actor', '', true);
  return o; -- its 4-digit delivery code is created by the protected_orders_code trigger
end $$;

-- Kept for holo.html before this migration: same as request_order without pickup.
create or replace function public.start_checkout(p_listing uuid) returns public.protected_orders
  language sql security definer set search_path = public as $$
  select * from public.request_order(p_listing, false)
$$;

create or replace function public.seller_confirm_order(p_order uuid) returns public.protected_orders
  language plpgsql security definer set search_path = public as $$
declare o public.protected_orders;
begin
  select * into o from public.protected_orders where id = p_order for update;
  if not found or auth.uid() is null or o.seller_id <> auth.uid() then raise exception 'order: not yours' using errcode = '42501'; end if;
  if o.status <> 'esperando_confirmacion_vendedor' or o.seller_confirm_deadline < now() then
    raise exception 'order: can''t confirm now' using errcode = '22023';
  end if;
  update public.protected_orders
     set seller_confirmed_at = now(), payment_deadline = now() + make_interval(mins => public.setting_int('payment_minutes'))
   where id = o.id;
  return public.order_move(o.id, 'pendiente_pago', 'vendedor', 'El vendedor confirmó que tiene la carta');
end $$;

create or replace function public.seller_decline_order(p_order uuid, p_reason text default null) returns void
  language plpgsql security definer set search_path = public as $$
declare o public.protected_orders;
begin
  select * into o from public.protected_orders where id = p_order for update;
  if not found or auth.uid() is null or o.seller_id <> auth.uid() then raise exception 'order: not yours' using errcode = '42501'; end if;
  if o.status <> 'esperando_confirmacion_vendedor' then raise exception 'order: can''t decline now' using errcode = '22023'; end if;
  update public.protected_orders set close_reason = left(coalesce(nullif(trim(p_reason), ''), 'El vendedor ya no la tiene'), 300) where id = o.id;
  perform public.order_move(o.id, 'cancelada', 'vendedor', 'El vendedor no la tiene: ' || coalesce(nullif(trim(p_reason), ''), 'sin motivo'));
end $$;

create or replace function public.buyer_cancel_order(p_order uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare o public.protected_orders;
begin
  select * into o from public.protected_orders where id = p_order for update;
  if not found or auth.uid() is null or o.buyer_id is distinct from auth.uid() then raise exception 'order: not yours' using errcode = '42501'; end if;
  if o.status not in ('esperando_confirmacion_vendedor', 'pendiente_pago') then raise exception 'order: can''t cancel now' using errcode = '22023'; end if;
  if exists (select 1 from public.payment_attempts where order_id = o.id and status = 'created' and created_at > now() - interval '10 minutes') then
    raise exception 'order: a payment is in progress' using errcode = '22023';
  end if;
  update public.protected_orders set close_reason = 'El comprador canceló' where id = o.id;
  perform public.order_move(o.id, 'cancelada', 'comprador', 'El comprador canceló antes de pagar');
end $$;

-- Pickup vs Holo delivery can be changed until the order is paid; shipping follows.
create or replace function public.set_order_pickup(p_order uuid, p_pickup boolean) returns void
  language plpgsql security definer set search_path = public as $$
declare o public.protected_orders;
begin
  select * into o from public.protected_orders where id = p_order for update;
  if not found or o.buyer_id is distinct from auth.uid() then raise exception 'order: not yours' using errcode = '42501'; end if;
  if o.status not in ('esperando_confirmacion_vendedor', 'pendiente_pago') then raise exception 'order: already paid' using errcode = '22023'; end if;
  if p_pickup and not exists (select 1 from public.profiles
                              where id = o.seller_id and is_shop and verified and shop_pickup) then
    raise exception 'order: no pickup' using errcode = '22023';
  end if;
  update public.protected_orders
     set pickup = coalesce(p_pickup, false),
         shipping_cents = (public.order_quote(o.price_cents, coalesce(p_pickup, false))->>'shipping')::int
   where id = o.id;
end $$;

create or replace function public.order_buyer_total(o public.protected_orders) returns int
  language sql immutable set search_path = public as $$
  select o.price_cents + o.fee_cents + o.itbms_cents + o.shipping_cents
$$;

-- A payment try for the order (purpose 'orden') or for the second delivery attempt ('reintento').
-- Called by the payment Edge Function with the buyer's session. Amounts come from here.
create or replace function public.new_payment_attempt(p_order uuid, p_provider text default 'yappy') returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  o public.protected_orders;
  aid text;
  purpose text;
  total int;
  subtotal int;
  taxes int;
begin
  select * into o from public.protected_orders where id = p_order for update;
  if not found or auth.uid() is null or o.buyer_id is distinct from auth.uid() then
    raise exception 'order: not yours' using errcode = '42501';
  end if;
  if o.status = 'pendiente_pago' and o.payment_deadline > now() then
    purpose := 'orden'; total := public.order_buyer_total(o); taxes := o.itbms_cents; subtotal := total - taxes;
  elsif o.status = 'en_custodia' and o.retry_fee_cents > 0 and o.retry_paid_at is null then
    purpose := 'reintento'; total := o.retry_fee_cents; taxes := 0; subtotal := total;
  else
    raise exception 'payment: order not payable' using errcode = '22023';
  end if;
  if (select count(*) from public.payment_attempts where order_id = o.id) >= 10 then
    raise exception 'payment: too many attempts' using errcode = '22023';
  end if;
  aid := 'H' || upper(substr(md5(gen_random_uuid()::text), 1, 14));
  insert into public.payment_attempts (id, order_id, provider, amount_cents, purpose)
  values (aid, o.id, coalesce(p_provider, 'yappy'), total, purpose);
  return jsonb_build_object('attempt_id', aid, 'purpose', purpose, 'subtotal_cents', subtotal,
                            'taxes_cents', taxes, 'total_cents', total);
end $$;

-- Payment executed for the order: charge, hold, mark the listing sold, start the 48 h delivery clock.
-- If the card can't be sold any more (or the order already closed), the money is refunded right away.
create or replace function public.order_paid(o public.protected_orders, a public.payment_attempts) returns text
  language plpgsql security definer set search_path = public as $$
declare l public.listings;
begin
  perform public.post_charge(o, a.amount_cents, 'Cobro ' || a.provider || ' ' || a.id);
  if o.status <> 'pendiente_pago' then
    -- Late or duplicate payment for an order that is no longer waiting for it.
    perform public.request_refund(o, a.amount_cents, 'Pago recibido para una orden ' || o.status || ' (' || a.id || ')');
    update public.protected_orders set notes = left(concat_ws(E'\n', notes, 'Pago extra ' || a.id || ' reembolsado.'), 500) where id = o.id;
    return 'refund: order ' || o.status;
  end if;
  update public.protected_orders set paid_at = now(), hold_until = null,
         payment_ref = left(initcap(a.provider) || ' ' || coalesce(a.confirmation, '') || ' (' || a.id || ')', 120)
   where id = o.id;
  o := public.order_move(o.id, 'pagada_retenida', 'proveedor', 'Pago confirmado por ' || a.provider || ' (' || a.id || ')');
  select * into l from public.listings where id = o.listing_id for update;
  if l.status not in ('active', 'reserved') or public.listing_units_taken(l.id) > l.quantity then
    perform public.request_refund(o, a.amount_cents, 'La carta ya no estaba disponible');
    perform public.order_move(o.id, 'reembolsada', 'proveedor', 'La carta ya no estaba disponible: reembolso completo');
    return 'refund: listing unavailable';
  end if;
  perform public.listing_after_paid(o.listing_id);
  update public.protected_orders
     set delivery_deadline = now() + make_interval(hours => public.setting_int('seller_delivery_hours'))
   where id = o.id;
  perform public.order_move(o.id, 'esperando_entrega_vendedor', 'proveedor', 'Dinero retenido; el vendedor tiene que entregar');
  return 'paid';
end $$;

-- Every notice from the provider, valid or not, is logged; each (attempt, status) is processed once.
-- Only the Edge Function (service role) calls this, after checking the hash and the domain.
create or replace function public.process_payment_notification(
  p_attempt text, p_status text, p_domain text, p_hash text, p_valid boolean,
  p_confirmation text default null, p_raw jsonb default null, p_provider text default 'yappy'
) returns text language plpgsql security definer set search_path = public as $$
declare
  a public.payment_attempts;
  o public.protected_orders;
  mapped text := case p_status when 'E' then 'executed' when 'R' then 'rejected' when 'C' then 'cancelled' when 'X' then 'expired' end;
  v_result text;
begin
  if not p_valid or mapped is null then
    insert into public.payment_notifications (provider, attempt_id, status, domain, hash, valid, result, raw)
    values (p_provider, left(p_attempt, 40), left(p_status, 4), left(p_domain, 200), left(p_hash, 200), false,
            case when not p_valid then 'invalid' else 'unknown status' end, p_raw);
    return case when not p_valid then 'invalid' else 'unknown status' end;
  end if;
  select * into a from public.payment_attempts where id = p_attempt for update;
  if not found then
    insert into public.payment_notifications (provider, attempt_id, status, domain, hash, valid, result, raw)
    values (p_provider, left(p_attempt, 40), p_status, left(p_domain, 200), left(p_hash, 200), true, 'unknown attempt', p_raw);
    return 'unknown attempt';
  end if;
  if exists (select 1 from public.payment_notifications where attempt_id = a.id and status = p_status and processed) then
    insert into public.payment_notifications (provider, attempt_id, status, domain, hash, valid, result, raw)
    values (p_provider, a.id, p_status, left(p_domain, 200), left(p_hash, 200), true, 'duplicate', p_raw);
    return 'duplicate';
  end if;
  insert into public.payment_notifications (provider, attempt_id, status, domain, hash, valid, processed, result, raw)
  values (p_provider, a.id, p_status, left(p_domain, 200), left(p_hash, 200), true, true, 'processing', p_raw);

  if a.status = 'executed' then
    v_result := 'already executed';
  else
    update public.payment_attempts set status = mapped, confirmation = left(p_confirmation, 120)
     where id = a.id returning * into a;
    select * into o from public.protected_orders where id = a.order_id for update;
    if mapped = 'executed' and a.purpose = 'orden' then
      v_result := public.order_paid(o, a);
    elsif mapped = 'executed' and a.purpose = 'reintento' then
      perform public.ledger_post(o.id, jsonb_build_array(
        public.ledger_line('banco', 'cobro', a.amount_cents),
        public.ledger_line('holo_envio', 'envio', -a.amount_cents)), 'Segundo intento de entrega ' || a.id);
      update public.protected_orders set retry_paid_at = now() where id = o.id;
      perform public.notify_staff('staff_retry_paid', 'Reintento pagado', 'Programa el segundo intento de entrega.', '#/admin?tab=ordenes');
      v_result := 'retry paid';
    elsif mapped in ('rejected', 'expired') and a.purpose = 'orden' and o.status = 'pendiente_pago'
          and not exists (select 1 from public.payment_attempts x where x.order_id = o.id and x.status = 'executed') then
      update public.protected_orders set close_reason = 'Pago ' || mapped where id = o.id;
      perform public.order_move(o.id, 'fallida', 'proveedor', 'Yappy: pago ' || case mapped when 'rejected' then 'rechazado' else 'expirado' end);
      v_result := 'failed';
    else
      v_result := 'noted';
    end if;
  end if;
  update public.payment_notifications set result = v_result
   where id = (select max(id) from public.payment_notifications where attempt_id = a.id and status = p_status and processed);
  return v_result;
end $$;

-- 0014's entry point, kept for old callers: a valid executed/rejected/... notice.
create or replace function public.confirm_payment(p_attempt text, p_status text, p_confirmation text default null)
  returns text language sql security definer set search_path = public as $$
  select public.process_payment_notification(p_attempt,
    case p_status when 'executed' then 'E' when 'rejected' then 'R' when 'cancelled' then 'C' when 'expired' then 'X' else p_status end,
    null, null, true, p_confirmation, null, 'yappy')
$$;

-- Concierge orders (staff created, paid by a manual Yappy transfer).
create or replace function public.staff_mark_paid(p_order uuid, p_ref text) returns text
  language plpgsql security definer set search_path = public as $$
declare
  o public.protected_orders;
  a public.payment_attempts;
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  if char_length(trim(coalesce(p_ref, ''))) < 3 then raise exception 'payment: reference required' using errcode = '22023'; end if;
  select * into o from public.protected_orders where id = p_order for update;
  if not found or o.status <> 'pendiente_pago' then raise exception 'order: not waiting for payment' using errcode = '22023'; end if;
  insert into public.payment_attempts (id, order_id, provider, amount_cents, status, confirmation)
  values ('M' || upper(substr(md5(gen_random_uuid()::text), 1, 14)), o.id, 'yappy', public.order_buyer_total(o), 'executed', left(trim(p_ref), 120))
  returning * into a;
  -- Same path as a provider notice: charge, hold, sold, delivery clock.
  return public.order_paid(o, a);
end $$;

-- ------------------------------------------------------------------ logistics (staff = Holo's courier)
create or replace function public.staff_add_order_photo(p_order uuid, p_stage text, p_side text, p_path text) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  if p_path not like p_order::text || '/%' or p_path like '%..%' then raise exception 'photo: bad path' using errcode = '22023'; end if;
  insert into public.order_photos (order_id, stage, side, path, uploaded_by) values (p_order, p_stage, coalesce(p_side, 'otra'), p_path, auth.uid());
end $$;

create or replace function public.staff_pickup(p_order uuid, p_note text default null) returns void
  language plpgsql security definer set search_path = public as $$
declare o public.protected_orders;
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  select * into o from public.protected_orders where id = p_order for update;
  if not found or o.status <> 'esperando_entrega_vendedor' or o.pickup then raise exception 'order: not ready for pickup' using errcode = '22023'; end if;
  if not exists (select 1 from public.order_photos where order_id = o.id and stage = 'recogida' and side = 'frente')
     or not exists (select 1 from public.order_photos where order_id = o.id and stage = 'recogida' and side = 'reverso') then
    raise exception 'pickup: front and back photos required' using errcode = '22023';
  end if;
  update public.protected_orders set picked_up_at = now() where id = o.id;
  perform public.order_move(o.id, 'en_custodia', 'admin', coalesce(nullif(trim(p_note), ''), 'Holo recogió la carta'));
end $$;

create or replace function public.staff_out_for_delivery(p_order uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare
  o public.protected_orders;
  n int;
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  select * into o from public.protected_orders where id = p_order for update;
  if not found or o.status <> 'en_custodia' then raise exception 'order: not in custody' using errcode = '22023'; end if;
  select count(*) + 1 into n from public.delivery_attempts where order_id = o.id;
  if n > 2 then raise exception 'delivery: no attempts left' using errcode = '22023'; end if;
  if n = 2 and o.retry_paid_at is null then raise exception 'delivery: retry not paid' using errcode = '22023'; end if;
  insert into public.delivery_attempts (order_id, attempt) values (o.id, n);
  perform public.order_move(o.id, 'en_camino', 'admin', 'Intento de entrega ' || n);
end $$;

-- Delivered: the courier types the buyer's 4-digit code (photo at delivery required).
create or replace function public.staff_confirm_delivery(p_order uuid, p_code text) returns void
  language plpgsql security definer set search_path = public as $$
declare o public.protected_orders;
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  select * into o from public.protected_orders where id = p_order for update;
  if not found or o.status <> 'en_camino' then raise exception 'order: not out for delivery' using errcode = '22023'; end if;
  if not exists (select 1 from public.order_photos where order_id = o.id and stage = 'entrega') then
    raise exception 'delivery: photo required' using errcode = '22023';
  end if;
  perform public.check_delivery_code(o, p_code);
  update public.delivery_attempts set result = 'entregada', finished_at = now()
   where order_id = o.id and finished_at is null;
  perform public.order_delivered(o, 'admin', 'El comprador dio su código de entrega');
end $$;

-- Raises on a wrong or locked code. deliver_with_code() is the entry point: it records wrong tries
-- without raising (a raise would roll the count back) and locks after delivery_code_max_failures.
create or replace function public.check_delivery_code(o public.protected_orders, p_code text) returns void
  language plpgsql security definer set search_path = public as $$
declare
  good text;
begin
  if o.delivery_code_failures >= public.setting_int('delivery_code_max_failures') then
    raise exception 'delivery_code: locked after too many tries; ask staff' using errcode = '42501';
  end if;
  select code into good from public.order_delivery_codes where order_id = o.id;
  if good is null or p_code is distinct from good then
    raise exception 'delivery_code: wrong code' using errcode = '22023';
  end if;
end $$;

-- Wrong code typed: recorded without failing the call, so the count sticks.
create or replace function public.record_wrong_code(p_order uuid) returns int
  language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.protected_orders set delivery_code_failures = delivery_code_failures + 1 where id = p_order
  returning delivery_code_failures into n;
  if n = public.setting_int('delivery_code_max_failures') then
    perform public.notify_staff('staff_code_locked', 'Código de entrega bloqueado', 'Demasiados intentos con un código equivocado.', '#/admin?tab=ordenes');
  end if;
  return n;
end $$;

-- entregada, then straight into the 48 h review window.
create or replace function public.order_delivered(o public.protected_orders, p_actor text, p_reason text) returns void
  language plpgsql security definer set search_path = public as $$
begin
  update public.protected_orders set delivered_at = now(),
         review_deadline = now() + make_interval(hours => public.setting_int('review_hours'))
   where id = o.id;
  perform public.order_move(o.id, 'entregada', p_actor, p_reason);
  perform public.order_move(o.id, 'en_revision', 'sistema', 'Empieza la ventana de revisión');
end $$;

-- Courier or shop: one call that checks the code and either delivers or records the wrong try.
create or replace function public.deliver_with_code(p_order uuid, p_code text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  o public.protected_orders;
  good text;
  n int;
begin
  select * into o from public.protected_orders where id = p_order for update;
  if not found then raise exception 'order: not found' using errcode = '22023'; end if;
  if not (public.is_staff() or (o.pickup and o.seller_id = auth.uid())) then raise exception 'order: not yours' using errcode = '42501'; end if;
  if o.delivery_code_failures >= public.setting_int('delivery_code_max_failures') then
    raise exception 'delivery_code: locked after too many tries; ask staff' using errcode = '42501';
  end if;
  select code into good from public.order_delivery_codes where order_id = o.id;
  if good is null or p_code is distinct from good then
    n := public.record_wrong_code(o.id);
    return jsonb_build_object('ok', false, 'failures', n, 'max', public.setting_int('delivery_code_max_failures'));
  end if;
  if o.pickup and o.status = 'esperando_entrega_vendedor' then
    perform public.order_delivered(o, case when public.is_staff() then 'admin' else 'vendedor' end, 'Retiro en tienda con el código del comprador');
  elsif o.status = 'en_camino' then
    perform public.staff_confirm_delivery(o.id, p_code);
  else
    raise exception 'order: not out for delivery' using errcode = '22023';
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Buyer wasn't there. First time: back to custody and the buyer can pay the retry fee for a second
-- attempt. Second time: the card goes back to the seller (staff_return_to_seller).
create or replace function public.staff_delivery_failed(p_order uuid, p_note text default null) returns void
  language plpgsql security definer set search_path = public as $$
declare
  o public.protected_orders;
  n int;
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  select * into o from public.protected_orders where id = p_order for update;
  if not found or o.status <> 'en_camino' then raise exception 'order: not out for delivery' using errcode = '22023'; end if;
  update public.delivery_attempts set result = 'ausente', finished_at = now(), note = left(p_note, 300)
   where order_id = o.id and finished_at is null returning attempt into n;
  if n = 1 then
    update public.protected_orders set retry_fee_cents = public.setting_int('delivery_retry_cents') where id = o.id;
    perform public.notify(o.buyer_id, 'delivery_failed', 'No te encontramos para entregarte tu carta',
      'Paga ' || public.usd(public.setting_int('delivery_retry_cents')) || ' para un segundo intento desde Mi cuenta.', '#/cuenta');
  end if;
  perform public.order_move(o.id, 'en_custodia', 'admin', 'Intento ' || n || ' fallido: comprador ausente' || coalesce(' (' || p_note || ')', ''));
end $$;

-- Card goes back to the seller (two failed attempts, or the buyer didn't pay the retry):
-- the buyer is refunded everything except the shipping; the listing is on sale again.
create or replace function public.staff_return_to_seller(p_order uuid, p_note text default null) returns void
  language plpgsql security definer set search_path = public as $$
declare o public.protected_orders;
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  select * into o from public.protected_orders where id = p_order for update;
  if not found or o.status <> 'en_custodia' or not exists (select 1 from public.delivery_attempts where order_id = o.id and result = 'ausente') then
    raise exception 'order: return only after a failed delivery' using errcode = '22023';
  end if;
  perform public.request_refund(o, public.order_buyer_total(o) - o.shipping_cents,
                                'Entrega fallida: reembolso sin el envío', o.shipping_cents);
  update public.protected_orders set close_reason = 'Entrega fallida, devuelta al vendedor' where id = o.id;
  perform public.order_move(o.id, 'reembolsada', 'admin', coalesce(nullif(trim(p_note), ''), 'Devuelta al vendedor tras entrega fallida'));
  perform public.listing_after_refund(o.listing_id);
end $$;

-- ------------------------------------------------------------------ review, completion, disputes
create or replace function public.complete_order(o public.protected_orders, p_actor text, p_reason text,
                                                 p_buyer_refund int default 0) returns void
  language plpgsql security definer set search_path = public as $$
declare l public.listings;
begin
  perform public.post_completion(o, p_buyer_refund);
  if coalesce(p_buyer_refund, 0) > 0 then
    insert into public.refund_requests (order_id, recipient_id, amount_cents, reason)
    values (o.id, o.buyer_id, p_buyer_refund, 'Disputa: reembolso parcial');
  end if;
  update public.protected_orders set released_at = now() where id = o.id;
  perform public.order_move(o.id, 'completada', p_actor, p_reason);
  select * into l from public.listings where id = o.listing_id;
  -- The local Panama price data behind the estimates (one row per listing).
  insert into public.sales (listing_id, catalog_id, grading_key, condition, price_cents, via_protected)
  values (o.listing_id, l.catalog_id,
          case when l.grading_company is null then 'raw' else l.grading_company || rtrim(rtrim(l.grade::text, '0'), '.') end,
          l.condition, o.price_cents - coalesce(p_buyer_refund, 0), true)
  on conflict do nothing;
end $$;

create or replace function public.buyer_confirm_received(p_order uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare o public.protected_orders;
begin
  select * into o from public.protected_orders where id = p_order for update;
  if not found or auth.uid() is null or o.buyer_id is distinct from auth.uid() then raise exception 'order: not yours' using errcode = '42501'; end if;
  if o.status = 'completada' then return; end if;
  if o.status <> 'en_revision' then raise exception 'order: can''t confirm now' using errcode = '22023'; end if;
  update public.protected_orders set buyer_confirmed_at = now() where id = o.id;
  perform public.complete_order(o, 'comprador', 'El comprador confirmó que la carta está bien');
end $$;

-- Only during the review window, with a reason and photos (claim-photos bucket, "<buyer>/<order>/...").
create or replace function public.buyer_open_dispute(p_order uuid, p_reason text, p_photos text[] default '{}')
  returns void language plpgsql security definer set search_path = public as $$
declare
  o public.protected_orders;
  p text;
  photos text[] := coalesce(p_photos, '{}');
begin
  select * into o from public.protected_orders where id = p_order for update;
  if not found or auth.uid() is null or o.buyer_id is distinct from auth.uid() then raise exception 'order: not yours' using errcode = '42501'; end if;
  if o.status <> 'en_revision' or o.review_deadline < now() then raise exception 'dispute: window closed' using errcode = '22023'; end if;
  if char_length(trim(coalesce(p_reason, ''))) < 10 or char_length(p_reason) > 1000 then
    raise exception 'dispute: reason length' using errcode = '22023';
  end if;
  if cardinality(photos) < 1 or cardinality(photos) > 6 then raise exception 'dispute: 1 to 6 photos' using errcode = '22023'; end if;
  foreach p in array photos loop
    if p not like auth.uid()::text || '/' || o.id::text || '/%' or p like '%..%' then
      raise exception 'dispute: bad photo path' using errcode = '22023';
    end if;
  end loop;
  insert into public.disputes (order_id, opened_by, reason, photos) values (o.id, auth.uid(), trim(p_reason), photos);
  update public.protected_orders set claimed_at = now(), claim_reason = trim(p_reason), claim_photos = photos[1:4] where id = o.id;
  perform public.order_move(o.id, 'en_disputa', 'comprador', left(trim(p_reason), 200));
end $$;

-- Kept name from 0014 for holo.html: a claim is a dispute now.
create or replace function public.buyer_open_claim(p_order uuid, p_reason text, p_photos text[] default '{}')
  returns void language sql security definer set search_path = public as $$
  select public.buyer_open_dispute(p_order, p_reason, p_photos)
$$;

-- p_outcome: 'vendedor' (seller gets paid), 'comprador_total' (everything back to the buyer) or
-- 'comprador_parcial' with p_refund_cents (part of the price back; the sale completes for the rest).
create or replace function public.staff_resolve_dispute(p_order uuid, p_outcome text, p_refund_cents int default null,
                                                        p_note text default null) returns void
  language plpgsql security definer set search_path = public as $$
declare
  o public.protected_orders;
  d public.disputes;
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  select * into o from public.protected_orders where id = p_order for update;
  select * into d from public.disputes where order_id = p_order for update;
  if not found or o.status <> 'en_disputa' or d.status <> 'abierta' then raise exception 'dispute: not open' using errcode = '22023'; end if;
  if p_outcome = 'vendedor' then
    update public.protected_orders set claim_outcome = 'rejected' where id = o.id;
    perform public.complete_order(o, 'admin', 'Disputa resuelta a favor del vendedor');
  elsif p_outcome = 'comprador_total' then
    update public.protected_orders set claim_outcome = 'refunded', close_reason = 'Disputa a favor del comprador' where id = o.id;
    perform public.request_refund(o, public.order_buyer_total(o), 'Disputa a favor del comprador: reembolso total');
    perform public.order_move(o.id, 'reembolsada', 'admin', 'Disputa resuelta a favor del comprador (total)');
  elsif p_outcome = 'comprador_parcial' then
    if p_refund_cents is null or p_refund_cents <= 0 or p_refund_cents >= o.price_cents then
      raise exception 'dispute: partial refund must be between 0 and the price' using errcode = '22023';
    end if;
    update public.protected_orders set claim_outcome = 'refunded' where id = o.id;
    perform public.complete_order(o, 'admin', 'Disputa: reembolso parcial de ' || public.usd(p_refund_cents), p_refund_cents);
  else
    raise exception 'dispute: unknown outcome' using errcode = '22023';
  end if;
  update public.disputes
     set status = 'resuelta', outcome = p_outcome,
         refund_cents = case p_outcome when 'comprador_total' then public.order_buyer_total(o)
                                       when 'comprador_parcial' then p_refund_cents else 0 end,
         resolution_note = left(p_note, 500), resolved_by = auth.uid(), resolved_at = now()
   where id = d.id;
end $$;

-- Loss, damage, accident or theft. If it happened in Holo's custody (en_custodia / en_camino) and
-- Holo is responsible: the buyer gets everything back and the seller is paid from the reserve fund,
-- up to incident_max_cents per shipment.
create or replace function public.staff_report_incident(p_order uuid, p_kind text, p_responsible text,
                                                        p_description text, p_covered_cents int default null) returns uuid
  language plpgsql security definer set search_path = public as $$
declare
  o public.protected_orders;
  iid uuid;
  cap int := public.setting_int('incident_max_cents');
  covered int;
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  select * into o from public.protected_orders where id = p_order for update;
  if not found then raise exception 'order: not found' using errcode = '22023'; end if;
  covered := coalesce(p_covered_cents, least(o.price_cents - o.seller_fee_cents - o.seller_itbms_cents, cap));
  if covered > cap then raise exception 'incident: coverage over the % cap', public.usd(cap) using errcode = '22023'; end if;
  if p_responsible <> 'holo' then covered := 0; end if;
  insert into public.incidents (order_id, kind, responsible, description, covered_cents, created_by)
  values (o.id, p_kind, p_responsible, p_description, covered, auth.uid()) returning id into iid;

  if p_responsible = 'holo' and o.status in ('en_custodia', 'en_camino') then
    perform public.request_refund(o, public.order_buyer_total(o), 'Incidente en custodia de Holo: ' || p_kind);
    if covered > 0 then
      perform public.ledger_post(o.id, jsonb_build_array(
        public.ledger_line('fondo_reserva', 'fondo_reserva', covered),
        public.ledger_line('vendedor', 'fondo_reserva', -covered, o.seller_id)), 'Incidente ' || p_kind || ': pago al vendedor desde el fondo de reserva');
    end if;
    update public.protected_orders set close_reason = 'Incidente: ' || p_kind where id = o.id;
    perform public.order_move(o.id, 'reembolsada', 'admin', 'Incidente en custodia (' || p_kind || ')');
  end if;
  return iid;
end $$;

-- ================================================================== 10. deadlines (pg_cron)
create or replace function public.run_order_deadlines() returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  o public.protected_orders;
  c_confirm int := 0; c_pay int := 0; c_deliver int := 0; c_review int := 0; c_remind int := 0;
  t text;
begin
  if not public.is_admin_context() then raise exception 'staff only' using errcode = '42501'; end if;

  for o in select * from public.protected_orders
            where status = 'esperando_confirmacion_vendedor' and seller_confirm_deadline <= now() for update skip locked loop
    update public.protected_orders set close_reason = 'El vendedor no confirmó a tiempo' where id = o.id;
    perform public.order_move(o.id, 'cancelada', 'sistema', 'Venció el plazo de confirmación del vendedor');
    c_confirm := c_confirm + 1;
  end loop;

  for o in select * from public.protected_orders
            where status = 'pendiente_pago' and payment_deadline <= now() for update skip locked loop
    if exists (select 1 from public.payment_attempts where order_id = o.id and status = 'created'
               and created_at > now() - interval '2 minutes') then
      continue; -- a payment started at the last second: give Yappy's notice a moment
    end if;
    update public.protected_orders set close_reason = 'Pago no completado a tiempo' where id = o.id;
    perform public.order_move(o.id, 'fallida', 'sistema', 'No se completó el pago a tiempo');
    c_pay := c_pay + 1;
  end loop;

  for o in select * from public.protected_orders
            where status = 'esperando_entrega_vendedor' and delivery_deadline <= now() for update skip locked loop
    perform public.request_refund(o, public.order_buyer_total(o), 'El vendedor no entregó a tiempo: reembolso completo');
    update public.protected_orders set close_reason = 'El vendedor no entregó a tiempo' where id = o.id;
    perform public.order_move(o.id, 'cancelada', 'sistema', 'Venció el plazo de entrega del vendedor');
    perform public.listing_after_refund(o.listing_id);   -- before the penalty, so it gets paused with the rest
    perform public.penalize_no_delivery(o);
    c_deliver := c_deliver + 1;
  end loop;

  for o in select * from public.protected_orders
            where status = 'en_revision' and review_deadline <= now() for update skip locked loop
    perform public.complete_order(o, 'sistema', 'Pasó la ventana de revisión sin disputa');
    c_review := c_review + 1;
  end loop;

  -- Reminders to the seller before each of their deadlines (once per status).
  for o in select * from public.protected_orders
            where reminded_status is distinct from status
              and ((status = 'esperando_confirmacion_vendedor'
                    and seller_confirm_deadline - make_interval(mins => public.setting_int('remind_confirm_minutes')) <= now())
                or (status = 'esperando_entrega_vendedor'
                    and delivery_deadline - make_interval(hours => public.setting_int('remind_delivery_hours')) <= now()))
            for update skip locked loop
    t := coalesce((select title from public.listings where id = o.listing_id), 'tu carta');
    if o.status = 'esperando_confirmacion_vendedor' then
      perform public.notify(o.seller_id, 'remind_confirm', 'Confirma si aún tienes ' || t,
        'Si no confirmas antes de las ' || to_char(o.seller_confirm_deadline at time zone 'America/Panama', 'HH24:MI') || ', la compra se cancela.', '#/cuenta');
    else
      perform public.notify(o.seller_id, 'remind_delivery', 'Entrega ' || t || ' pronto',
        'Tienes hasta el ' || to_char(o.delivery_deadline at time zone 'America/Panama', 'DD/MM HH24:MI') ||
        '. Si no, se reembolsa al comprador y recibes una penalización.', '#/cuenta');
    end if;
    update public.protected_orders set reminded_status = o.status where id = o.id;
    c_remind := c_remind + 1;
  end loop;

  -- Penalties that ended: listings paused by them come back.
  update public.listings l set status = 'active', paused_by_penalty = false
   where l.paused_by_penalty and l.status = 'draft' and not public.seller_blocked(l.seller_id);

  return jsonb_build_object('seller_confirm_expired', c_confirm, 'payment_expired', c_pay,
                            'delivery_expired', c_deliver, 'review_completed', c_review, 'reminders', c_remind);
end $$;

-- 0014's job cancelled 'awaiting_payment' orders; run_order_deadlines() does it now.
create or replace function public.expire_checkouts() returns int
  language sql security definer set search_path = public as $$
  select coalesce((public.run_order_deadlines()->>'payment_expired')::int, 0)
$$;
select cron.unschedule('holo-checkouts-vencidos') where exists (select 1 from cron.job where jobname = 'holo-checkouts-vencidos');
select cron.unschedule('holo-plazos-ordenes') where exists (select 1 from cron.job where jobname = 'holo-plazos-ordenes');
select cron.schedule('holo-plazos-ordenes', '*/5 * * * *', 'select public.run_order_deadlines()');
select cron.unschedule('holo-liquidacion-semanal') where exists (select 1 from cron.job where jobname = 'holo-liquidacion-semanal');
-- Mondays 8:00 Panama (13:00 UTC).
select cron.schedule('holo-liquidacion-semanal', '0 13 * * 1', 'select public.prepare_weekly_payouts()');

-- ================================================================== 11. what the pages read
create or replace function public.order_stage(o public.protected_orders) returns text
  language sql stable set search_path = public as $$
  select o.status
$$;
create or replace function public.order_ready_to_pay(o public.protected_orders) returns boolean
  language sql stable set search_path = public as $$
  select o.status = 'completada'
$$;

drop function if exists public.my_orders();
create function public.my_orders() returns table (
  id uuid, role text, listing_id uuid, title text, status text, amount_cents int, price_cents int,
  shipping_cents int, created_at timestamptz, deadline timestamptz, paid_at timestamptz, delivered_at timestamptz,
  completed_at timestamptz, pickup boolean, pickup_shop uuid, delivery_code text, retry_fee_cents int,
  retry_paid_at timestamptz, close_reason text, dispute_reason text
) language sql stable security definer set search_path = public as $$
  select o.id,
         case when o.buyer_id = auth.uid() then 'buyer' else 'seller' end,
         o.listing_id, l.title, o.status,
         case when o.buyer_id = auth.uid() then public.order_buyer_total(o) else public.order_seller_payout(o) end,
         o.price_cents, o.shipping_cents, o.created_at,
         case o.status when 'esperando_confirmacion_vendedor' then o.seller_confirm_deadline
                       when 'pendiente_pago' then o.payment_deadline
                       when 'esperando_entrega_vendedor' then o.delivery_deadline
                       when 'en_revision' then o.review_deadline end,
         o.paid_at, o.delivered_at, o.completed_at, o.pickup,
         case when o.pickup and o.buyer_id = auth.uid() then o.seller_id end,
         -- the code is the buyer's only, and only once there is something to deliver
         case when o.buyer_id = auth.uid() and o.status in ('esperando_entrega_vendedor', 'en_custodia', 'en_camino')
              then (select c.code from public.order_delivery_codes c where c.order_id = o.id) end,
         o.retry_fee_cents, o.retry_paid_at, o.close_reason,
         case when o.buyer_id = auth.uid() then (select d.reason from public.disputes d where d.order_id = o.id) end
  from public.protected_orders o
  left join public.listings l on l.id = o.listing_id
  where auth.uid() is not null
    and (o.buyer_id = auth.uid() or o.seller_id = auth.uid())
    and not (o.seller_id = auth.uid() and o.status = 'pendiente_pago')
    and not (o.status in ('cancelada', 'fallida') and o.paid_at is null and o.closed_at < now() - interval '7 days')
  order by o.created_at desc
  limit 100
$$;

-- Seller: balance from the ledger, pending payout and penalties.
create or replace function public.my_seller_balance() returns jsonb
  language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'balance_cents', public.seller_ledger_balance(auth.uid()),
    'available_cents', public.seller_available_cents(auth.uid()),
    'pending_payout_cents', coalesce((select sum(amount_cents) from public.payouts where seller_id = auth.uid() and status = 'pendiente'), 0),
    'held_cents', coalesce((select sum(public.order_seller_payout(o)) from public.protected_orders o
                             where o.seller_id = auth.uid() and o.status in ('pagada_retenida', 'esperando_entrega_vendedor',
                                   'en_custodia', 'en_camino', 'entregada', 'en_revision', 'en_disputa')), 0),
    'completed_sales', public.seller_completed_sales(auth.uid()),
    'blocked_until', (select selling_blocked_until from public.profiles where id = auth.uid()),
    'banned', (select banned_at is not null from public.profiles where id = auth.uid()))
  where auth.uid() is not null
$$;

drop function if exists public.staff_orders();
create function public.staff_orders(p_status text default null) returns table (
  id uuid, listing_id uuid, title text, seller_id uuid, seller_name text, seller_is_shop boolean,
  buyer_id uuid, buyer_name text, buyer_contact text, price_cents int, shipping_cents int,
  buyer_total_cents int, seller_payout_cents int, status text, source text, pickup boolean,
  payment_ref text, notes text, created_at timestamptz, status_changed_at timestamptz, deadline timestamptz,
  close_reason text, delivery_attempts int, retry_fee_cents int, retry_paid_at timestamptz,
  photos int, open_dispute boolean, payout_phone text, payout_name text
) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  return query
  select o.id, o.listing_id, l.title, o.seller_id, s.display_name, s.is_shop and s.verified,
         o.buyer_id, b.display_name, o.buyer_contact, o.price_cents, o.shipping_cents,
         public.order_buyer_total(o), public.order_seller_payout(o), o.status, o.source, o.pickup,
         o.payment_ref, o.notes, o.created_at, o.status_changed_at,
         case o.status when 'esperando_confirmacion_vendedor' then o.seller_confirm_deadline
                       when 'pendiente_pago' then o.payment_deadline
                       when 'esperando_entrega_vendedor' then o.delivery_deadline
                       when 'en_revision' then o.review_deadline end,
         o.close_reason,
         (select count(*)::int from public.delivery_attempts da where da.order_id = o.id),
         o.retry_fee_cents, o.retry_paid_at,
         (select count(*)::int from public.order_photos ph where ph.order_id = o.id),
         exists (select 1 from public.disputes d where d.order_id = o.id and d.status = 'abierta'),
         pa.yappy_phone, pa.holder_name
  from public.protected_orders o
  left join public.listings l on l.id = o.listing_id
  left join public.profiles s on s.id = o.seller_id
  left join public.profiles b on b.id = o.buyer_id
  left join public.payout_accounts pa on pa.user_id = o.seller_id
  where (p_status is null or o.status = p_status)
  order by o.status_changed_at desc
  limit 500;
end $$;

-- Everything about one order: history, photos, payments, notices, ledger, refunds, dispute, incidents.
create or replace function public.staff_order_detail(p_order uuid) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  return jsonb_build_object(
    'history', (select coalesce(jsonb_agg(to_jsonb(h) order by h.id), '[]') from public.order_status_history h where h.order_id = p_order),
    'photos', (select coalesce(jsonb_agg(to_jsonb(p) order by p.id), '[]') from public.order_photos p where p.order_id = p_order),
    'attempts', (select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at), '[]') from public.payment_attempts a where a.order_id = p_order),
    'notifications', (select coalesce(jsonb_agg(to_jsonb(n) order by n.id), '[]') from public.payment_notifications n
                       where n.attempt_id in (select a.id from public.payment_attempts a where a.order_id = p_order)),
    'deliveries', (select coalesce(jsonb_agg(to_jsonb(d) order by d.attempt), '[]') from public.delivery_attempts d where d.order_id = p_order),
    'ledger', (select coalesce(jsonb_agg(to_jsonb(e) order by e.id), '[]') from public.ledger_entries e where e.order_id = p_order),
    'refunds', (select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at), '[]') from public.refund_requests r where r.order_id = p_order),
    'dispute', (select to_jsonb(d) from public.disputes d where d.order_id = p_order),
    'incidents', (select coalesce(jsonb_agg(to_jsonb(i) order by i.created_at), '[]') from public.incidents i where i.order_id = p_order));
end $$;

create or replace function public.staff_refunds(p_status text default 'pendiente') returns table (
  id uuid, order_id uuid, title text, recipient_id uuid, recipient_name text, recipient_contact text,
  amount_cents int, reason text, status text, paid_ref text, created_at timestamptz, paid_at timestamptz
) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  return query
  select r.id, r.order_id, l.title, r.recipient_id, p.display_name, coalesce(o.buyer_contact, p.whatsapp),
         r.amount_cents, r.reason, r.status, r.paid_ref, r.created_at, r.paid_at
    from public.refund_requests r
    join public.protected_orders o on o.id = r.order_id
    left join public.listings l on l.id = o.listing_id
    left join public.profiles p on p.id = r.recipient_id
   where p_status is null or r.status = p_status
   order by r.created_at;
end $$;

-- Weekly payout list (also what the CSV export contains).
create or replace function public.staff_payouts(p_status text default 'pendiente') returns table (
  id uuid, seller_id uuid, seller_name text, is_shop boolean, yappy_phone text, holder_name text,
  amount_cents int, balance_cents bigint, status text, week_of date, paid_ref text, created_at timestamptz, paid_at timestamptz
) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  return query
  select p.id, p.seller_id, s.display_name, s.is_shop and s.verified, pa.yappy_phone, pa.holder_name,
         p.amount_cents, public.seller_ledger_balance(p.seller_id), p.status, p.week_of, p.paid_ref, p.created_at, p.paid_at
    from public.payouts p
    join public.profiles s on s.id = p.seller_id
    left join public.payout_accounts pa on pa.user_id = p.seller_id
   where p_status is null or p.status = p_status
   order by p.created_at, s.display_name;
end $$;

create or replace function public.staff_payouts_csv() returns text
  language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  return 'vendedor,tienda,yappy,titular,monto,semana,id' || E'\n' || coalesce((
    select string_agg(concat_ws(',', '"' || replace(seller_name, '"', '""') || '"', case when is_shop then 'si' else 'no' end,
                                coalesce(yappy_phone, ''), '"' || replace(coalesce(holder_name, ''), '"', '""') || '"',
                                to_char(amount_cents / 100.0, 'FM999999990.00'), week_of, id), E'\n')
      from public.staff_payouts('pendiente')), '');
end $$;

create or replace function public.staff_disputes() returns table (
  order_id uuid, title text, buyer_name text, seller_name text, price_cents int, reason text, photos text[],
  opened_at timestamptz, review_deadline timestamptz
) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  return query
  select d.order_id, l.title, b.display_name, s.display_name, o.price_cents, d.reason, d.photos, d.created_at, o.review_deadline
    from public.disputes d
    join public.protected_orders o on o.id = d.order_id
    left join public.listings l on l.id = o.listing_id
    left join public.profiles b on b.id = o.buyer_id
    left join public.profiles s on s.id = o.seller_id
   where d.status = 'abierta'
   order by d.created_at;
end $$;

-- Reconciliation: what came in and went out per day (Panama time), to match the bank statement.
create or replace function public.staff_reconciliation(p_days int default 30) returns table (
  day date, payments int, charged_cents bigint, refunds_paid_cents bigint, payouts_paid_cents bigint, net_cents bigint
) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  return query
  with b as (
    select (created_at at time zone 'America/Panama')::date as d, kind, amount_cents
      from public.ledger_entries
     where account = 'banco' and created_at > now() - make_interval(days => least(greatest(p_days, 1), 366)))
  select d,
         count(*) filter (where kind = 'cobro')::int,
         coalesce(sum(amount_cents) filter (where kind = 'cobro'), 0)::bigint,
         coalesce(-sum(amount_cents) filter (where kind = 'reembolso'), 0)::bigint,
         coalesce(-sum(amount_cents) filter (where kind = 'liquidacion'), 0)::bigint,
         coalesce(sum(amount_cents), 0)::bigint
    from b group by d order by d desc;
end $$;

-- Alerts: orders stuck longer than expected, and the same buyer and seller trading again and again.
create or replace function public.staff_alerts() returns table (kind text, order_id uuid, detail text, since timestamptz)
  language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  return query
  select 'atascada'::text, o.id,
         'En ' || o.status || ' hace ' || floor(extract(epoch from now() - o.status_changed_at) / 3600)::int || ' h (esperado: ' || s.max_hours || ' h)',
         o.status_changed_at
    from public.protected_orders o
    join public.order_state_sla s on s.status = o.status
   where o.status_changed_at + make_interval(hours => s.max_hours) < now()
  union all
  select 'repetida', max(o.id::text)::uuid,
         'Comprador ' || coalesce(b.display_name, '?') || ' y vendedor ' || coalesce(v.display_name, '?') || ': '
           || count(*) || ' órdenes pagadas en ' || public.setting_int('alert_pair_days') || ' días',
         min(o.paid_at)
    from public.protected_orders o
    left join public.profiles b on b.id = o.buyer_id
    left join public.profiles v on v.id = o.seller_id
   where o.paid_at > now() - make_interval(days => public.setting_int('alert_pair_days')) and o.buyer_id is not null
   group by o.buyer_id, o.seller_id, b.display_name, v.display_name
  having count(*) >= public.setting_int('alert_pair_orders')
  union all
  select 'codigo_bloqueado', o.id, 'Código de entrega bloqueado por intentos fallidos', o.status_changed_at
    from public.protected_orders o
   where o.delivery_code_failures >= public.setting_int('delivery_code_max_failures') and public.order_is_open(o.status)
  order by 4;
end $$;

-- ================================================================== 12. 0014 staff actions, rewired
-- holo.html's panel buttons map to the new functions.
create or replace function public.staff_order_action(p_order uuid, p_action text, p_ref text default null)
  returns void language plpgsql security definer set search_path = public as $$
declare o public.protected_orders;
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  select * into o from public.protected_orders where id = p_order;
  if not found then raise exception 'order: not found' using errcode = '22023'; end if;
  case p_action
    when 'mark_paid' then perform public.staff_mark_paid(p_order, coalesce(p_ref, 'Yappy manual'));
    when 'pickup' then perform public.staff_pickup(p_order, p_ref);
    when 'out_for_delivery' then perform public.staff_out_for_delivery(p_order);
    when 'delivery_failed' then perform public.staff_delivery_failed(p_order, p_ref);
    when 'return_to_seller' then perform public.staff_return_to_seller(p_order, p_ref);
    when 'cancel' then
      if o.status not in ('esperando_confirmacion_vendedor', 'pendiente_pago') then
        raise exception 'order: action cancel not allowed in stage %', o.status using errcode = '22023';
      end if;
      update public.protected_orders set close_reason = coalesce(p_ref, 'Cancelada por Holo') where id = o.id;
      perform public.order_move(o.id, 'cancelada', 'admin', coalesce(p_ref, 'Cancelada por Holo'));
    else raise exception 'order: action % not allowed in stage %', p_action, o.status using errcode = '22023';
  end case;
end $$;

-- Concierge order from the staff panel (buyer wrote on WhatsApp, seller confirmed there). Amounts
-- are computed here like request_order(): the listing price, or the buyer's accepted offer.
create or replace function public.staff_create_order(p_listing uuid, p_buyer uuid default null, p_contact text default null,
                                                     p_pickup boolean default false) returns public.protected_orders
  language plpgsql security definer set search_path = public as $$
declare
  l public.listings;
  o public.protected_orders;
  price int;
  q jsonb;
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  select * into l from public.listings where id = p_listing for update;
  if not found or l.status <> 'active' then raise exception 'order: listing not available' using errcode = '22023'; end if;
  if public.listing_units_held(l.id) >= l.quantity then raise exception 'order: listing on hold' using errcode = '22023'; end if;
  if p_buyer is null and char_length(trim(coalesce(p_contact, ''))) < 3 then
    raise exception 'order: buyer account or contact required' using errcode = '22023';
  end if;
  select coalesce((select amount_cents from public.offers where listing_id = l.id and buyer_id = p_buyer and status = 'accepted'
                   order by updated_at desc limit 1), l.price_cents) into price;
  q := public.order_quote(price, coalesce(p_pickup, false));
  perform set_config('holo.actor', 'admin', true);
  perform set_config('holo.reason', 'Orden creada por el staff (el vendedor confirmó por WhatsApp)', true);
  insert into public.protected_orders (listing_id, buyer_id, seller_id, buyer_contact, price_cents, fee_cents, itbms_cents,
                                       seller_fee_cents, seller_itbms_cents, shipping_cents, pickup, status, source)
  values (l.id, p_buyer, l.seller_id, nullif(left(trim(coalesce(p_contact, '')), 120), ''), price, (q->>'fee')::int, (q->>'itbms')::int,
          (q->>'seller_fee')::int, (q->>'seller_itbms')::int, (q->>'shipping')::int, coalesce(p_pickup, false), 'pendiente_pago', 'staff')
  returning * into o;
  perform set_config('holo.actor', '', true);
  update public.listings set protected_eligible = true where id = l.id;
  return o;
end $$;

-- Staff-created concierge orders start at pendiente_pago (the seller confirmed on WhatsApp).
create or replace function public.fill_new_order() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'pendiente_pago' and new.payment_deadline is null then
    new.payment_deadline := now() + case when new.source = 'staff' then interval '3 days'
                                         else make_interval(mins => public.setting_int('payment_minutes')) end;
    new.seller_confirmed_at := coalesce(new.seller_confirmed_at, now());
  end if;
  if new.status = 'esperando_confirmacion_vendedor' and new.seller_confirm_deadline is null then
    new.seller_confirm_deadline := now() + make_interval(mins => public.setting_int('seller_confirm_minutes'));
  end if;
  return new;
end $$;
drop trigger if exists protected_orders_fill on public.protected_orders;
create trigger protected_orders_fill before insert on public.protected_orders
  for each row execute function public.fill_new_order();
create or replace function public.add_delivery_code() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  insert into public.order_delivery_codes (order_id, code) values (new.id, public.new_delivery_code()) on conflict do nothing;
  return null;
end $$;
drop trigger if exists protected_orders_code on public.protected_orders;
create trigger protected_orders_code after insert on public.protected_orders
  for each row execute function public.add_delivery_code();
insert into public.order_delivery_codes (order_id, code)
select id, public.new_delivery_code() from public.protected_orders on conflict do nothing;

-- Reviews and public stats count completed orders.
drop policy if exists "buyers review released orders" on public.reviews;
drop policy if exists "buyers review completed orders" on public.reviews;
create policy "buyers review completed orders" on public.reviews for insert with check (
  reviewer_id = auth.uid() and exists (
    select 1 from public.protected_orders o
    where o.id = order_id and o.status = 'completada'
      and auth.uid() in (o.buyer_id, o.seller_id)
      and reviewee_id in (o.buyer_id, o.seller_id) and reviewee_id <> auth.uid()));
create or replace view public.seller_stats as
  select p.id as seller_id,
         (select count(*) from public.protected_orders o where o.seller_id = p.id and o.status = 'completada')::int as completed_sales,
         (select count(*) from public.reviews r where r.reviewee_id = p.id and not r.hidden)::int as review_count,
         (select round(avg(r.rating), 1) from public.reviews r where r.reviewee_id = p.id and not r.hidden) as avg_rating
  from public.profiles p;

-- ================================================================== 13. notifications
create or replace function public.notify_order() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  t text := coalesce((select title from public.listings where id = new.listing_id), 'tu carta');
  shop public.profiles;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return null; end if;
  case new.status
    when 'esperando_confirmacion_vendedor' then
      perform public.notify(new.seller_id, 'order_requested', 'Quieren comprar ' || t,
        'Confirma que aún la tienes antes de ' || public.setting_int('seller_confirm_minutes') || ' minutos. Recibirás ' || public.usd(public.order_seller_payout(new)) || '.', '#/cuenta');
    when 'pendiente_pago' then
      if tg_op = 'UPDATE' then
        perform public.notify(new.buyer_id, 'order_confirmed_by_seller', 'El vendedor confirmó ' || t,
          'Paga ' || public.usd(public.order_buyer_total(new)) || ' en los próximos ' || public.setting_int('payment_minutes') || ' minutos.', '#/cuenta');
      end if;
    when 'esperando_entrega_vendedor' then
      if new.pickup then
        select * into shop from public.profiles where id = new.seller_id;
        perform public.notify(new.seller_id, 'order_paid', '¡Vendiste ' || t || '!',
          'El comprador la retira en tu tienda: pídele su código de 4 dígitos. Recibirás ' || public.usd(public.order_seller_payout(new)) || '.', '#/cuenta');
        perform public.notify(new.buyer_id, 'order_paid', 'Recibimos tu pago por ' || t,
          'Retírala en ' || coalesce(shop.display_name, 'la tienda') || coalesce(' (' || shop.shop_address || ')', '') ||
          ' y da tu código de entrega (está en Mi cuenta).', '#/cuenta');
      else
        perform public.notify(new.seller_id, 'order_paid', '¡Vendiste ' || t || '!',
          'Tenla lista: Holo la recoge en las próximas ' || public.setting_int('seller_delivery_hours') || ' horas. Recibirás ' || public.usd(public.order_seller_payout(new)) || '.', '#/cuenta');
        perform public.notify(new.buyer_id, 'order_paid', 'Recibimos tu pago por ' || t,
          'Guardamos tu dinero hasta que la recibas. Tu código de entrega está en Mi cuenta: dáselo solo al mensajero de Holo.', '#/cuenta');
      end if;
      perform public.notify_staff('staff_order_paid', 'Orden pagada: ' || t,
        case when new.pickup then 'Retiro en la tienda.' else 'Coordina la recogida.' end, '#/admin?tab=ordenes');
    when 'en_custodia' then
      if tg_op = 'UPDATE' and old.status = 'esperando_entrega_vendedor' then
        perform public.notify(new.buyer_id, 'order_in_custody', 'Holo ya tiene ' || t, 'Te avisamos cuando salga a entregarse.', '#/cuenta');
      end if;
    when 'en_camino' then
      perform public.notify(new.buyer_id, 'order_on_the_way', t || ' va en camino', 'Ten a mano tu código de entrega de 4 dígitos.', '#/cuenta');
    when 'en_revision' then
      perform public.notify(new.buyer_id, 'order_delivered', 'Entregamos ' || t,
        'Revísala: tienes ' || public.setting_int('review_hours') || ' horas para reportar un problema.', '#/cuenta');
    when 'en_disputa' then
      perform public.notify(new.seller_id, 'order_claim', 'El comprador reportó un problema con ' || t,
        'Lo estamos revisando. El pago queda en espera.', '#/cuenta');
      perform public.notify_staff('staff_claim', 'Disputa nueva: ' || t, left(new.claim_reason, 300), '#/admin?tab=disputas');
    when 'completada' then
      perform public.notify(new.seller_id, 'order_released', 'Venta completada: ' || t,
        public.usd(public.order_seller_payout(new)) || ' quedan en tu saldo; se paga en la liquidación semanal.', '#/cuenta');
      perform public.notify(new.buyer_id, 'review_request', '¿Cómo te fue con ' || t || '?',
        'Deja una reseña del vendedor: ayuda a otros a comprar con confianza.', '#/cuenta');
    when 'cancelada' then
      perform public.notify(new.buyer_id, 'order_cancelled', 'Se canceló tu compra de ' || t,
        coalesce(new.close_reason, '') || case when new.paid_at is not null then '. Te devolvemos todo lo que pagaste.' else '. No se te cobró nada.' end, '#/cuenta');
      if tg_op = 'UPDATE' and old.status <> 'esperando_confirmacion_vendedor' then
        perform public.notify(new.seller_id, 'order_cancelled', 'Se canceló la venta de ' || t, new.close_reason, '#/cuenta');
      end if;
    when 'fallida' then
      perform public.notify(new.buyer_id, 'order_failed', 'No se completó el pago de ' || t, 'Puedes intentarlo otra vez desde la carta.', '#/cuenta');
    when 'reembolsada' then
      perform public.notify(new.buyer_id, 'order_refunded', 'Te devolvemos el dinero de ' || t,
        'El reembolso llega por Yappy en un máximo de 5 días hábiles.', '#/cuenta');
      perform public.notify(new.seller_id, 'order_refunded', 'La venta de ' || t || ' se reembolsó al comprador', new.close_reason, '#/cuenta');
    else null;
  end case;
  return null;
end $$;
drop trigger if exists protected_orders_notify on public.protected_orders;
create trigger protected_orders_notify after insert or update of status on public.protected_orders
  for each row execute function public.notify_order();

-- ================================================================== 14. ledger for orders made before 0029
-- Paid orders get their charge (money held); completed ones the sale and the payout already made;
-- refunded ones the refund already paid. Run once (skipped when the order already has entries).
do $$
declare o public.protected_orders;
begin
  for o in select * from public.protected_orders p
            where p.paid_at is not null and not exists (select 1 from public.ledger_entries e where e.order_id = p.id)
            order by p.paid_at loop
    perform public.ledger_post(o.id, jsonb_build_array(
      public.ledger_line('banco', 'cobro', public.order_buyer_total(o)),
      public.ledger_line('retencion', 'retencion', -public.order_buyer_total(o))), 'Cobro anterior a 0029', o.paid_at);
    if o.status = 'completada' then
      perform public.post_completion(o, 0);
      if o.payout_ref is not null or o.released_at is not null then
        perform public.ledger_post(null, jsonb_build_array(
          public.ledger_line('vendedor', 'liquidacion', public.order_seller_payout(o), o.seller_id),
          public.ledger_line('banco', 'liquidacion', -public.order_seller_payout(o))),
          'Pago anterior a 0029: ' || coalesce(o.payout_ref, 'sin referencia'), coalesce(o.released_at, now()));
      end if;
    elsif o.status = 'reembolsada' then
      perform public.ledger_post(o.id, jsonb_build_array(
        public.ledger_line('retencion', 'retencion', public.order_buyer_total(o)),
        public.ledger_line('banco', 'reembolso', -public.order_buyer_total(o))), 'Reembolso anterior a 0029', coalesce(o.closed_at, now()));
    end if;
  end loop;
end $$;

-- ================================================================== 15. permissions
do $$
declare f text;
begin
  -- Internal helpers: nobody calls them from the page.
  foreach f in array array[
    'public.setting_int(text)', 'public.order_actor()', 'public.guard_order_status()',
    'public.log_order_status()', 'public.order_move(uuid, text, text, text)', 'public.ledger_post(uuid, jsonb, text, timestamptz)',
    'public.ledger_line(text, text, bigint, uuid)', 'public.order_escrow_cents(uuid)', 'public.seller_ledger_balance(uuid)',
    'public.post_charge(public.protected_orders, bigint, text)', 'public.post_completion(public.protected_orders, int)',
    'public.seller_blocked(uuid)', 'public.seller_completed_sales(uuid)', 'public.guard_profile_standing()',
    'public.guard_listing_seller()', 'public.listing_units_held(uuid)', 'public.penalize_no_delivery(public.protected_orders)',
    'public.request_refund(public.protected_orders, int, text, int)', 'public.seller_available_cents(uuid)',
    'public.new_delivery_code()', 'public.order_paid(public.protected_orders, public.payment_attempts)',
    'public.process_payment_notification(text, text, text, text, boolean, text, jsonb, text)', 'public.confirm_payment(text, text, text)',
    'public.check_delivery_code(public.protected_orders, text)', 'public.staff_confirm_delivery(uuid, text)', 'public.record_wrong_code(uuid)',
    'public.order_delivered(public.protected_orders, text, text)', 'public.complete_order(public.protected_orders, text, text, int)',
    'public.expire_checkouts()', 'public.fill_new_order()', 'public.add_delivery_code()',
    'public.notify_order()', 'public.ledger_append_only()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  -- Signed-in users (each function checks who may do what).
  foreach f in array array[
    'public.public_order_settings()', 'public.order_quote(int, boolean)', 'public.request_order(uuid, boolean)',
    'public.start_checkout(uuid)', 'public.seller_confirm_order(uuid)', 'public.seller_decline_order(uuid, text)',
    'public.buyer_cancel_order(uuid)', 'public.set_order_pickup(uuid, boolean)', 'public.new_payment_attempt(uuid, text)',
    'public.deliver_with_code(uuid, text)', 'public.buyer_confirm_received(uuid)', 'public.buyer_open_dispute(uuid, text, text[])',
    'public.buyer_open_claim(uuid, text, text[])', 'public.my_orders()', 'public.my_seller_balance()',
    'public.staff_set_setting(text, bigint)', 'public.staff_mark_refund_paid(uuid, text)', 'public.staff_mark_payout_paid(uuid, text)',
    'public.staff_void_payout(uuid)', 'public.staff_mark_paid(uuid, text)', 'public.staff_add_order_photo(uuid, text, text, text)',
    'public.staff_pickup(uuid, text)', 'public.staff_out_for_delivery(uuid)',
    'public.staff_delivery_failed(uuid, text)', 'public.staff_return_to_seller(uuid, text)',
    'public.staff_resolve_dispute(uuid, text, int, text)', 'public.staff_report_incident(uuid, text, text, text, int)',
    'public.staff_orders(text)', 'public.staff_order_detail(uuid)', 'public.staff_refunds(text)', 'public.staff_payouts(text)',
    'public.staff_payouts_csv()', 'public.staff_disputes()', 'public.staff_reconciliation(int)', 'public.staff_alerts()',
    'public.staff_order_action(uuid, text, text)', 'public.staff_create_order(uuid, uuid, text, boolean)', 'public.run_order_deadlines()', 'public.prepare_weekly_payouts()'] loop
    if to_regprocedure(f) is not null then
      execute format('revoke all on function %s from public, anon', f);
      execute format('grant execute on function %s to authenticated', f);
    end if;
  end loop;
  execute 'grant execute on function public.public_order_settings() to anon';
  execute 'grant execute on function public.order_quote(int, boolean) to anon';
  execute 'grant execute on function public.process_payment_notification(text, text, text, text, boolean, text, jsonb, text) to service_role';
  execute 'grant execute on function public.confirm_payment(text, text, text) to service_role';
  execute 'grant execute on function public.run_order_deadlines() to service_role';
end $$;
