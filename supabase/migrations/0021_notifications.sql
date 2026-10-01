-- 0021: notifications ("Avisos"). Run once in Supabase ▸ SQL Editor after 0020 (safe to re-run).
-- holo.html works before and after it: until it runs there is simply no bell.
--
-- Every important event creates a row here, written by triggers in the database (so nothing depends
-- on the browser that caused it): offers, Compras Protegidas (paid, delivered, confirmed, claim,
-- refunded, released), reviews, shop verification, Revisión en tienda results and the Plan
-- Coleccionista. holo.html shows them behind the bell (#/avisos). The enviar-avisos Edge Function
-- e-mails the pending ones once a sending domain exists (docs/08-avisos.md); until then email_status
-- simply stays 'pending' and the sender ignores anything older than a day, so nothing floods later.

create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  kind text not null check (char_length(kind) <= 40),
  title text not null check (char_length(title) <= 160),
  body text check (char_length(body) <= 400),
  link text check (link ~ '^#/' and char_length(link) <= 200),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  email_status text not null default 'pending' check (email_status in ('pending', 'sent', 'skipped', 'failed')),
  email_attempts int not null default 0
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_email_idx on public.notifications (created_at) where email_status = 'pending';
alter table public.notifications enable row level security;
drop policy if exists "own notifications" on public.notifications;
create policy "own notifications" on public.notifications for select using (user_id = auth.uid());
-- No insert/update/delete policies: rows come from the triggers below; reading marks go through
-- mark_notifications_read().

-- Per-user switch for e-mail (the bell always works).
create table if not exists public.notification_settings (
  user_id uuid primary key references public.profiles on delete cascade,
  email boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.notification_settings enable row level security;
drop policy if exists "own notification settings" on public.notification_settings;
create policy "own notification settings" on public.notification_settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.mark_notifications_read(p_ids bigint[] default null) returns int
  language sql security definer set search_path = public as $$
  with x as (
    update public.notifications set read_at = now()
     where user_id = auth.uid() and read_at is null and (p_ids is null or id = any (p_ids))
    returning 1)
  select count(*)::int from x
$$;
revoke all on function public.mark_notifications_read(bigint[]) from public, anon;
grant execute on function public.mark_notifications_read(bigint[]) to authenticated;

-- ------------------------------------------------------------------ helpers (internal)
create or replace function public.notify(p_user uuid, p_kind text, p_title text, p_body text, p_link text)
  returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is null then return; end if;
  insert into public.notifications (user_id, kind, title, body, link)
  values (p_user, p_kind, left(p_title, 160), left(p_body, 400), p_link);
end $$;
create or replace function public.notify_staff(p_kind text, p_title text, p_body text, p_link text)
  returns void language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, kind, title, body, link)
  select id, p_kind, left(p_title, 160), left(p_body, 400), p_link from public.profiles where is_staff
$$;
create or replace function public.usd(p_cents int) returns text
  language sql immutable as $$
  select '$' || case when p_cents % 100 = 0 then to_char(p_cents / 100, 'FM999,999,990')
                     else to_char(p_cents / 100.0, 'FM999,999,990.00') end
$$;
revoke all on function public.notify(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.notify_staff(text, text, text, text) from public, anon, authenticated;

-- ------------------------------------------------------------------ offers
create or replace function public.notify_offer() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  t text := coalesce((select title from public.listings where id = new.listing_id), 'tu carta');
  card text := '#/carta/' || new.listing_id;
begin
  if new.status = 'pending' and (tg_op = 'INSERT' or old.status is distinct from 'pending' or old.amount_cents <> new.amount_cents) then
    perform public.notify(new.seller_id, 'offer_new', 'Nueva oferta: ' || public.usd(new.amount_cents) || ' por ' || t,
      'Acéptala, recházala o contraoferta desde Mi cuenta.', '#/cuenta');
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'countered' then
      perform public.notify(new.buyer_id, 'offer_countered', 'Te contraofertaron ' || public.usd(new.counter_cents) || ' por ' || t,
        'Ofreciste ' || public.usd(new.amount_cents) || '. Acepta o rechaza la contraoferta en la carta.', card);
    elsif new.status = 'accepted' and old.status = 'pending' then
      perform public.notify(new.buyer_id, 'offer_accepted', '¡Aceptaron tu oferta de ' || public.usd(new.amount_cents) || '!',
        t || ': ya puedes comprarla con Compra Protegida a ese precio.', card);
    elsif new.status = 'accepted' and old.status = 'countered' then
      perform public.notify(new.seller_id, 'offer_accepted', 'Aceptaron tu contraoferta de ' || public.usd(new.amount_cents),
        t || ': el comprador puede comprarla a ese precio.', '#/cuenta');
    elsif new.status = 'rejected' and old.status = 'pending' then
      perform public.notify(new.buyer_id, 'offer_rejected', 'No aceptaron tu oferta por ' || t,
        'Puedes ofrecer otro monto desde la carta.', card);
    elsif new.status = 'rejected' and old.status = 'countered' then
      perform public.notify(new.seller_id, 'offer_rejected', 'Rechazaron tu contraoferta por ' || t, null, '#/cuenta');
    end if;
  end if;
  return null;
end $$;
drop trigger if exists offers_notify on public.offers;
create trigger offers_notify after insert or update on public.offers
  for each row execute function public.notify_offer();

-- ------------------------------------------------------------------ Compra Protegida
create or replace function public.notify_order() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  t text := coalesce((select title from public.listings where id = new.listing_id), 'tu carta');
  was text := case when tg_op = 'UPDATE' then old.status end;
begin
  if tg_op = 'INSERT' then return null; end if;

  if new.status = 'paid' and was in ('awaiting_payment', 'cancelled') then
    perform public.notify(new.seller_id, 'order_paid', '¡Vendiste ' || t || '!',
      'El comprador ya pagó. Entrégale la carta: el equipo te escribe para coordinar. Recibirás ' || public.usd(public.order_seller_payout(new)) || '.', '#/cuenta');
    perform public.notify(new.buyer_id, 'order_paid', 'Recibimos tu pago por ' || t,
      'Guardamos tu dinero hasta que confirmes que la carta llegó bien.', '#/cuenta');
    perform public.notify_staff('staff_order_paid', 'Orden pagada: ' || t, 'Coordina la entrega.', '#/admin?tab=ordenes');
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
drop trigger if exists protected_orders_notify on public.protected_orders;
create trigger protected_orders_notify after update on public.protected_orders
  for each row execute function public.notify_order();

-- ------------------------------------------------------------------ reviews, shops, checks, plans
create or replace function public.notify_review() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  perform public.notify(new.reviewee_id, 'review_new', 'Recibiste una reseña de ' || new.rating || ' ' ||
    case when new.rating = 1 then 'estrella' else 'estrellas' end, left(new.comment, 300), '#/vendedor/' || new.reviewee_id);
  return null;
end $$;
drop trigger if exists reviews_notify on public.reviews;
create trigger reviews_notify after insert on public.reviews
  for each row execute function public.notify_review();

create or replace function public.notify_profile() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.verified and not old.verified then
    perform public.notify(new.id, 'shop_verified', '¡Tu tienda está verificada!',
      'Tus anuncios ya llevan el sello de tienda verificada.', '#/vendedor/' || new.id);
  end if;
  return null;
end $$;
drop trigger if exists profiles_notify on public.profiles;
create trigger profiles_notify after update of verified on public.profiles
  for each row execute function public.notify_profile();

create or replace function public.notify_check() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status and new.status in ('paid', 'authentic', 'not_authentic', 'inconclusive') then
    perform public.notify(new.requester_id, 'check_' || new.status,
      case new.status
        when 'paid' then 'Recibimos el pago de tu Revisión en tienda'
        when 'authentic' then 'Tu carta pasó la Revisión en tienda'
        when 'not_authentic' then 'Resultado de tu Revisión en tienda'
        else 'Resultado de tu Revisión en tienda' end,
      left(new.listing_title, 200),
      case when new.listing_id is null then '#/cuenta' else '#/carta/' || new.listing_id end);
  end if;
  return null;
end $$;
drop trigger if exists authenticity_checks_notify on public.authenticity_checks;
create trigger authenticity_checks_notify after update on public.authenticity_checks
  for each row execute function public.notify_check();

create or replace function public.notify_plan() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.active_until > old.active_until then
    perform public.notify(new.user_id, 'plan_active', 'Tu Plan Coleccionista está activo',
      'Hasta el ' || to_char(new.active_until at time zone 'America/Panama', 'DD/MM/YYYY') || ': escaneos sin límite.', '#/escanear');
  end if;
  return null;
end $$;
drop trigger if exists subscriptions_notify on public.subscriptions;
create trigger subscriptions_notify after insert or update on public.subscriptions
  for each row execute function public.notify_plan();

revoke all on function public.notify_offer() from public, anon, authenticated;
revoke all on function public.notify_order() from public, anon, authenticated;
revoke all on function public.notify_review() from public, anon, authenticated;
revoke all on function public.notify_profile() from public, anon, authenticated;
revoke all on function public.notify_check() from public, anon, authenticated;
revoke all on function public.notify_plan() from public, anon, authenticated;
