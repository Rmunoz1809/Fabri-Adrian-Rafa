-- 0028: shop pages, pickup at the shop and shop events. Run once in Supabase ▸ SQL Editor after 0027
-- (safe to re-run). holo.html works before and after it: until it runs, the new shop fields, the
-- pickup option and the events section are simply not shown.
--
-- 1. Shop page: a shop adds its address, province and opening hours; the page links the address to
--    Google Maps. Only shops keep these fields (they are cleared when a profile is not a shop).
-- 2. Retiro en tienda: a verified shop can offer pickup at its store. The buyer picks it when paying;
--    the order then shows the shop's address to the buyer and a short pickup code to both sides.
-- 3. Eventos: verified shops publish tournaments, leagues, prereleases… People mark "Me interesa",
--    get a reminder the day before, and a notice if the shop cancels.

-- ------------------------------------------------------------------ 1. shop page
alter table public.profiles
  add column if not exists shop_address text,
  add column if not exists shop_province text,
  add column if not exists shop_hours text,
  add column if not exists shop_pickup boolean not null default false;

alter table public.profiles drop constraint if exists profiles_shop_place;
alter table public.profiles add constraint profiles_shop_place check (
  (shop_address is null or char_length(shop_address) between 5 and 160)
  and (shop_province is null or char_length(shop_province) <= 40)
  and (shop_hours is null or char_length(shop_hours) <= 200)
  and (not shop_pickup or shop_address is not null));

create or replace function public.clear_shop_fields() returns trigger
  language plpgsql as $$
begin
  if not new.is_shop then
    new.shop_address := null; new.shop_province := null; new.shop_hours := null; new.shop_pickup := false;
  end if;
  return new;
end $$;
drop trigger if exists profiles_shop_fields on public.profiles;
create trigger profiles_shop_fields before insert or update on public.profiles
  for each row execute function public.clear_shop_fields();

-- New columns go at the end so CREATE OR REPLACE keeps the view (and its grants).
create or replace view public.public_profiles as
  select id, display_name, avatar_url, is_shop, verified, created_at,
         avatar_path, shop_description, shop_photo_path,
         shop_address, shop_province, shop_hours, shop_pickup
  from public.profiles;

-- ------------------------------------------------------------------ 2. pickup at the shop
alter table public.protected_orders add column if not exists pickup boolean not null default false;

-- The buyer chooses while the checkout is open. Pickup only at verified shops that offer it.
create or replace function public.set_order_pickup(p_order uuid, p_pickup boolean) returns void
  language plpgsql security definer set search_path = public as $$
declare o public.protected_orders;
begin
  select * into o from public.protected_orders where id = p_order for update;
  if not found or o.buyer_id is distinct from auth.uid() then raise exception 'order: not yours' using errcode = '42501'; end if;
  if o.status <> 'awaiting_payment' then raise exception 'order: already paid' using errcode = '22023'; end if;
  if p_pickup and not exists (select 1 from public.profiles
                              where id = o.seller_id and is_shop and verified and shop_pickup) then
    raise exception 'order: no pickup' using errcode = '22023';
  end if;
  update public.protected_orders set pickup = coalesce(p_pickup, false) where id = o.id;
end $$;

-- Code the buyer shows at the shop; the shop sees the same one on its sale.
create or replace function public.order_pickup_code(p_order uuid) returns text
  language sql immutable as $$
  select upper(left(replace(p_order::text, '-', ''), 6))
$$;

-- my_orders gains pickup, the pickup code and (for the buyer of a pickup) the shop to go to.
-- Same body as 0014/0016; the return type changes, so it is dropped and created again.
drop function if exists public.my_orders();
create function public.my_orders()
 returns table(id uuid, role text, listing_id uuid, title text, stage text, amount_cents integer,
               created_at timestamptz, paid_at timestamptz, delivered_at timestamptz, claim_deadline timestamptz,
               buyer_confirmed_at timestamptz, claimed_at timestamptz, claim_reason text, claim_outcome text,
               released_at timestamptz, hold_until timestamptz, pickup boolean, pickup_code text, pickup_shop uuid)
 language sql stable security definer set search_path = public as $$
  select o.id,
         case when o.buyer_id = auth.uid() then 'buyer' else 'seller' end,
         o.listing_id, l.title, public.order_stage(o),
         case when o.buyer_id = auth.uid() then public.order_buyer_total(o) else public.order_seller_payout(o) end,
         o.created_at, o.paid_at, o.delivered_at, o.delivered_at + interval '3 days',
         o.buyer_confirmed_at, o.claimed_at,
         case when o.buyer_id = auth.uid() then o.claim_reason end, o.claim_outcome,
         o.released_at, o.hold_until,
         o.pickup,
         case when o.pickup then public.order_pickup_code(o.id) end,
         case when o.pickup and o.buyer_id = auth.uid() then o.seller_id end
  from public.protected_orders o
  left join public.listings l on l.id = o.listing_id
  where auth.uid() is not null
    and (o.buyer_id = auth.uid() or o.seller_id = auth.uid())
    and not (o.status = 'awaiting_payment' and (o.seller_id = auth.uid() or o.source = 'checkout' and o.hold_until < now()))
    and not (o.status = 'cancelled' and o.paid_at is null)
  order by o.created_at desc
  limit 100
$$;
revoke all on function public.my_orders() from public, anon;
grant execute on function public.my_orders() to authenticated;

-- 0021's "paid" notices, with the pickup wording when the buyer collects at the shop.
create or replace function public.notify_order() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  t text := coalesce((select title from public.listings where id = new.listing_id), 'tu carta');
  was text := case when tg_op = 'UPDATE' then old.status end;
  shop public.profiles;
begin
  if tg_op = 'INSERT' then return null; end if;

  if new.status = 'paid' and was in ('awaiting_payment', 'cancelled') then
    if new.pickup then
      select * into shop from public.profiles where id = new.seller_id;
      perform public.notify(new.seller_id, 'order_paid', '¡Vendiste ' || t || '!',
        'El comprador la retira en tu tienda con el código ' || public.order_pickup_code(new.id) || '. Recibirás ' || public.usd(public.order_seller_payout(new)) || '.', '#/cuenta');
      perform public.notify(new.buyer_id, 'order_paid', 'Recibimos tu pago por ' || t,
        'Retírala en ' || coalesce(shop.display_name, 'la tienda') || coalesce(' (' || shop.shop_address || ')', '') ||
        ' y muestra el código ' || public.order_pickup_code(new.id) || '.', '#/cuenta');
    else
      perform public.notify(new.seller_id, 'order_paid', '¡Vendiste ' || t || '!',
        'El comprador ya pagó. Entrégale la carta: el equipo te escribe para coordinar. Recibirás ' || public.usd(public.order_seller_payout(new)) || '.', '#/cuenta');
      perform public.notify(new.buyer_id, 'order_paid', 'Recibimos tu pago por ' || t,
        'Guardamos tu dinero hasta que confirmes que la carta llegó bien.', '#/cuenta');
    end if;
    perform public.notify_staff('staff_order_paid', 'Orden pagada: ' || t,
      case when new.pickup then 'Retiro en la tienda.' else 'Coordina la entrega.' end, '#/admin?tab=ordenes');
  end if;

  if new.status = 'delivered' and was is distinct from 'delivered' and new.buyer_confirmed_at is null then
    perform public.notify(new.buyer_id, 'order_delivered', 'Marcaron ' || t || ' como entregada',
      'Revísala: tienes 3 días para confirmar que está bien o reportar un problema.', '#/cuenta');
  end if;

  if new.buyer_confirmed_at is not null and old.buyer_confirmed_at is null then
    perform public.notify(new.seller_id, 'order_confirmed', 'El comprador confirmó que recibió ' || t || ' bien',
      'Te pagamos ' || public.usd(public.order_seller_payout(new)) || ' por Yappy.', '#/cuenta');
  end if;

  if new.claimed_at is not null and old.claimed_at is null then
    perform public.notify(new.seller_id, 'order_claim', 'El comprador reportó un problema con ' || t,
      'Lo estamos revisando y te escribimos. El pago queda en espera.', '#/cuenta');
    perform public.notify_staff('staff_claim', 'Reclamo nuevo: ' || t, left(new.claim_reason, 300), '#/admin?tab=ordenes');
  end if;

  if new.claim_outcome = 'rejected' and old.claim_outcome is null then
    perform public.notify(new.buyer_id, 'claim_rejected', 'Revisamos tu reclamo por ' || t,
      'No correspondía un reembolso. Si tienes dudas, escríbenos.', '#/cuenta');
    perform public.notify(new.seller_id, 'claim_rejected', 'El reclamo por ' || t || ' se resolvió a tu favor',
      'Te pagamos tu venta.', '#/cuenta');
  end if;

  if new.status = 'refunded' and was is distinct from 'refunded' then
    perform public.notify(new.buyer_id, 'order_refunded', 'Te devolvimos el dinero de ' || t,
      'El reembolso llega por el mismo medio de pago en un máximo de 5 días hábiles.', '#/cuenta');
    perform public.notify(new.seller_id, 'order_refunded', 'La venta de ' || t || ' se reembolsó al comprador', null, '#/cuenta');
  end if;

  if new.status = 'released' and was is distinct from 'released' then
    perform public.notify(new.seller_id, 'order_released', 'Te pagamos ' || public.usd(public.order_seller_payout(new)) || ' por ' || t,
      coalesce('Referencia: ' || new.payout_ref, 'Revisa tu Yappy.'), '#/cuenta');
    perform public.notify(new.buyer_id, 'review_request', '¿Cómo te fue con ' || t || '?',
      'Deja una reseña del vendedor: ayuda a otros a comprar con confianza.', '#/cuenta');
  end if;
  return null;
end $$;

-- ------------------------------------------------------------------ 3. shop events
create table if not exists public.shop_events (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.profiles on delete cascade,
  title text not null check (char_length(title) between 3 and 80),
  game text not null check (game in ('pokemon', 'one_piece', 'magic', 'yugioh', 'lorcana', 'deportivas', 'otro')),
  kind text not null check (kind in ('torneo', 'liga', 'prerelease', 'lanzamiento', 'intercambio', 'otro')),
  starts_at timestamptz not null,
  ends_at timestamptz,
  fee_cents int not null default 0 check (fee_cents between 0 and 100000),
  capacity int check (capacity between 1 and 1000),
  description text check (char_length(description) <= 600),
  cancelled_at timestamptz,
  reminded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or (ends_at > starts_at and ends_at <= starts_at + interval '3 days'))
);
create index if not exists shop_events_starts_idx on public.shop_events (starts_at);
create index if not exists shop_events_shop_idx on public.shop_events (shop_id, starts_at);
alter table public.shop_events enable row level security;
drop policy if exists "events readable" on public.shop_events;
create policy "events readable" on public.shop_events for select using (true);
drop policy if exists "shops add events" on public.shop_events;
create policy "shops add events" on public.shop_events for insert to authenticated with check (shop_id = auth.uid());
drop policy if exists "shops edit events" on public.shop_events;
create policy "shops edit events" on public.shop_events for update to authenticated
  using (shop_id = auth.uid() or public.is_staff()) with check (shop_id = auth.uid() or public.is_staff());
-- No delete policy: an event is cancelled (people who marked "Me interesa" get a notice).

create table if not exists public.event_interest (
  event_id uuid not null references public.shop_events on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
create index if not exists event_interest_user_idx on public.event_interest (user_id);
alter table public.event_interest enable row level security;
drop policy if exists "own interest" on public.event_interest;
create policy "own interest" on public.event_interest for select using (user_id = auth.uid());
drop policy if exists "mark interest" on public.event_interest;
create policy "mark interest" on public.event_interest for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "unmark interest" on public.event_interest;
create policy "unmark interest" on public.event_interest for delete to authenticated using (user_id = auth.uid());

create or replace function public.guard_shop_event() returns trigger
  language plpgsql security definer set search_path = public as $$
declare c public.shop_events;
begin
  if auth.uid() is null then return new; end if; -- SQL editor and the reminder job (remind_events)
  if tg_op = 'UPDATE' then
    if new.shop_id is distinct from old.shop_id or new.created_at is distinct from old.created_at then
      raise exception 'event: fixed fields' using errcode = '42501';
    end if;
    if old.cancelled_at is not null then raise exception 'event: cancelled' using errcode = '22023'; end if;
    if new.cancelled_at is not null then -- cancelling is always allowed, and changes nothing else
      c := old;
      c.cancelled_at := now();
      c.updated_at := now();
      return c;
    end if;
    new.reminded_at := case when new.starts_at = old.starts_at then old.reminded_at end; -- only the job sets it; a new date gets a new reminder
  else
    new.created_at := now();
    new.cancelled_at := null;
    new.reminded_at := null;
    if (select count(*) from public.shop_events
        where shop_id = new.shop_id and cancelled_at is null and starts_at > now()) >= 40 then
      raise exception 'event: too many' using errcode = '22023';
    end if;
  end if;
  if not public.is_staff() and not exists (select 1 from public.profiles where id = new.shop_id and is_shop and verified) then
    raise exception 'event: verified shops only' using errcode = '42501';
  end if;
  if new.starts_at < now() - interval '1 hour' or new.starts_at > now() + interval '180 days' then
    raise exception 'event: date' using errcode = '22023';
  end if;
  new.title := trim(regexp_replace(new.title, '\s+', ' ', 'g'));
  new.description := nullif(trim(new.description), '');
  if char_length(new.title) < 3 then raise exception 'event: title' using errcode = '22023'; end if;
  if public.has_contact_info(new.title) or public.has_contact_info(new.description) then
    raise exception 'event: contact info' using errcode = '22023';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists shop_events_guard on public.shop_events;
create trigger shop_events_guard before insert or update on public.shop_events
  for each row execute function public.guard_shop_event();

create or replace function public.guard_event_interest() returns trigger
  language plpgsql security definer set search_path = public as $$
declare e public.shop_events;
begin
  select * into e from public.shop_events where id = new.event_id;
  if not found or e.cancelled_at is not null or coalesce(e.ends_at, e.starts_at + interval '6 hours') < now() then
    raise exception 'event: not available' using errcode = '22023';
  end if;
  new.created_at := now();
  return new;
end $$;
drop trigger if exists event_interest_guard on public.event_interest;
create trigger event_interest_guard before insert on public.event_interest
  for each row execute function public.guard_event_interest();

create or replace function public.notify_event_cancelled() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.cancelled_at is not null and old.cancelled_at is null and new.starts_at > now() then
    perform public.notify(i.user_id, 'event_cancelled', 'Se canceló: ' || new.title,
      coalesce((select display_name from public.profiles where id = new.shop_id), 'La tienda') || ' canceló el evento del ' ||
      to_char(new.starts_at at time zone 'America/Panama', 'DD/MM') || '.', '#/eventos')
    from public.event_interest i where i.event_id = new.id;
  end if;
  return null;
end $$;
drop trigger if exists shop_events_notify on public.shop_events;
create trigger shop_events_notify after update of cancelled_at on public.shop_events
  for each row execute function public.notify_event_cancelled();

-- Upcoming events (and the shop that runs them) with how many people are interested. Open to everyone.
create or replace function public.upcoming_events(p_shop uuid default null)
 returns table(id uuid, shop_id uuid, shop_name text, shop_verified boolean, shop_avatar text, shop_province text,
               shop_address text, title text, game text, kind text, starts_at timestamptz, ends_at timestamptz,
               fee_cents int, capacity int, description text, cancelled boolean, interested int, mine boolean)
 language sql stable security definer set search_path = public as $$
  select e.id, e.shop_id, p.display_name, p.is_shop and p.verified, p.avatar_path, p.shop_province, p.shop_address,
         e.title, e.game, e.kind, e.starts_at, e.ends_at, e.fee_cents, e.capacity, e.description,
         e.cancelled_at is not null,
         (select count(*)::int from public.event_interest i where i.event_id = e.id),
         exists (select 1 from public.event_interest i where i.event_id = e.id and i.user_id = auth.uid())
  from public.shop_events e
  join public.profiles p on p.id = e.shop_id
  where coalesce(e.ends_at, e.starts_at + interval '6 hours') > now()
    and (p_shop is null or e.shop_id = p_shop)
    and (e.cancelled_at is null or p_shop is not null and e.shop_id = auth.uid()
         or exists (select 1 from public.event_interest i where i.event_id = e.id and i.user_id = auth.uid()))
  order by e.starts_at
  limit 100
$$;

-- Reminder the day before, to everyone who marked "Me interesa". Runs every hour (pg_cron below).
create or replace function public.remind_events() returns int
  language plpgsql security definer set search_path = public as $$
declare n int := 0; e public.shop_events;
begin
  for e in select * from public.shop_events
            where cancelled_at is null and reminded_at is null
              and starts_at between now() + interval '1 hour' and now() + interval '24 hours'
            for update skip locked loop
    perform public.notify(i.user_id, 'event_reminder', 'Recordatorio: ' || e.title,
      coalesce((select display_name from public.profiles where id = e.shop_id), 'La tienda') || ', ' ||
      to_char(e.starts_at at time zone 'America/Panama', 'DD/MM') || ' a las ' ||
      replace(replace(to_char(e.starts_at at time zone 'America/Panama', 'FMHH12:MI AM'), 'AM', 'a. m.'), 'PM', 'p. m.'), '#/eventos')
    from public.event_interest i where i.event_id = e.id;
    update public.shop_events set reminded_at = now() where id = e.id;
    n := n + 1;
  end loop;
  return n;
end $$;
select cron.unschedule('holo-recordatorio-eventos') where exists (select 1 from cron.job where jobname = 'holo-recordatorio-eventos');
select cron.schedule('holo-recordatorio-eventos', '5 * * * *', 'select public.remind_events()');

revoke all on function public.clear_shop_fields() from public, anon, authenticated;
revoke all on function public.set_order_pickup(uuid, boolean) from public, anon;
grant execute on function public.set_order_pickup(uuid, boolean) to authenticated;
revoke all on function public.order_pickup_code(uuid) from public, anon, authenticated;
revoke all on function public.guard_shop_event() from public, anon, authenticated;
revoke all on function public.guard_event_interest() from public, anon, authenticated;
revoke all on function public.notify_event_cancelled() from public, anon, authenticated;
revoke all on function public.remind_events() from public, anon, authenticated;
revoke all on function public.notify_order() from public, anon, authenticated;
revoke all on function public.upcoming_events(uuid) from public;
grant execute on function public.upcoming_events(uuid) to anon, authenticated;
