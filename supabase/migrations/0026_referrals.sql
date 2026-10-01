-- 0026: referrals ("Invita y gana"). Run once in Supabase ▸ SQL Editor after 0025 (safe to re-run).
-- holo.html works before and after it: until it runs, the invite section is not shown.
--
-- Each account's invite code is its buyer code (first 8 characters of its id). Someone who signs up
-- from an invite link has 7 days to be linked to whoever invited them (claim_referral). When the
-- invited account has 3 listings published, both get 1 month of the Plan Coleccionista (0012),
-- automatically, once. A person can earn the reward for up to 12 invites (a year of plan).

create table if not exists public.referrals (
  referred_id uuid primary key references public.profiles on delete cascade,
  referrer_id uuid not null references public.profiles on delete cascade,
  created_at timestamptz not null default now(),
  rewarded_at timestamptz,
  check (referred_id <> referrer_id)
);
create index if not exists referrals_referrer_idx on public.referrals (referrer_id);
alter table public.referrals enable row level security;
drop policy if exists "own referrals" on public.referrals;
create policy "own referrals" on public.referrals for select
  using (referrer_id = auth.uid() or referred_id = auth.uid() or public.is_staff());

alter table public.subscriptions drop constraint if exists subscriptions_source_check;
alter table public.subscriptions add constraint subscriptions_source_check check (source in ('manual', 'yappy', 'tilopay', 'referral'));

create or replace function public.claim_referral(p_code text) returns text
  language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  code text := lower(trim(coalesce(p_code, '')));
  me public.profiles;
  ref uuid;
begin
  if uid is null then raise exception 'login required' using errcode = '42501'; end if;
  if code !~ '^[0-9a-f]{8}$' then return 'invalid'; end if;
  select * into me from public.profiles where id = uid;
  if me.created_at < now() - interval '7 days' then return 'too late'; end if;
  if exists (select 1 from public.referrals where referred_id = uid) then return 'already'; end if;
  select id into ref from public.profiles where id::text like code || '%' and id <> uid limit 1;
  if ref is null then return 'invalid'; end if;
  insert into public.referrals (referred_id, referrer_id) values (uid, ref);
  return 'ok';
end $$;

-- Invite stats for Mi cuenta.
create or replace function public.my_referrals() returns jsonb
  language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'invited', count(*), 'rewarded', count(*) filter (where rewarded_at is not null))
  from public.referrals where referrer_id = auth.uid()
$$;

create or replace function public.grant_plan_month(p_user uuid) returns void
  language sql security definer set search_path = public as $$
  insert into public.subscriptions (user_id, plan, active_until, source)
  values (p_user, 'coleccionista', now() + interval '30 days', 'referral')
  on conflict (user_id) do update
    set active_until = greatest(subscriptions.active_until, now()) + interval '30 days', updated_at = now()
$$;

create or replace function public.reward_referral() returns trigger
  language plpgsql security definer set search_path = public as $$
declare r public.referrals;
begin
  if new.status <> 'active' or (tg_op = 'UPDATE' and old.status = 'active') then return null; end if;
  select * into r from public.referrals where referred_id = new.seller_id and rewarded_at is null for update;
  if not found then return null; end if;
  if (select count(*) from public.listings where seller_id = new.seller_id and status in ('active', 'reserved', 'sold')) < 3 then
    return null;
  end if;
  update public.referrals set rewarded_at = now() where referred_id = r.referred_id;
  perform public.grant_plan_month(r.referred_id);
  perform public.notify(r.referred_id, 'referral_reward', '¡Ganaste 1 mes del Plan Coleccionista!',
    'Por publicar tus primeras 3 cartas en Holo. Escaneos sin límite y hasta 50 búsquedas en “Busco…”.', '#/escanear');
  if (select count(*) from public.referrals where referrer_id = r.referrer_id and rewarded_at is not null) <= 12 then
    perform public.grant_plan_month(r.referrer_id);
    perform public.notify(r.referrer_id, 'referral_reward', '¡Ganaste 1 mes del Plan Coleccionista!',
      'Alguien que invitaste publicó sus primeras 3 cartas. ¡Gracias por traer gente a Holo!', '#/cuenta');
  end if;
  return null;
end $$;
drop trigger if exists listings_referral_reward on public.listings;
create trigger listings_referral_reward after insert or update of status on public.listings
  for each row execute function public.reward_referral();

-- 0021 announces every plan activation; a referral reward already sends its own message.
create or replace function public.notify_plan() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.source = 'referral' then return null; end if;
  if tg_op = 'INSERT' or new.active_until > old.active_until then
    perform public.notify(new.user_id, 'plan_active', 'Tu Plan Coleccionista está activo',
      'Hasta el ' || to_char(new.active_until at time zone 'America/Panama', 'DD/MM/YYYY') || ': escaneos sin límite.', '#/escanear');
  end if;
  return null;
end $$;
revoke all on function public.notify_plan() from public, anon, authenticated;

revoke all on function public.claim_referral(text) from public, anon;
revoke all on function public.my_referrals() from public, anon;
grant execute on function public.claim_referral(text) to authenticated;
grant execute on function public.my_referrals() to authenticated;
revoke all on function public.grant_plan_month(uuid) from public, anon, authenticated;
revoke all on function public.reward_referral() from public, anon, authenticated;
