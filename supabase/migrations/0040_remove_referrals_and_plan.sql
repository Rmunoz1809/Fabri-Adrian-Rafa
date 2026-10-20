-- 0040: Remove "Invita y gana" (0026) and the Plan Coleccionista (0012) completely (decisions, 2026-10-20).
-- Run once in Supabase ▸ SQL Editor after 0039 (safe to re-run).
--
-- Every account keeps the free limits: 3 scans per day in "¿Cuánto vale tu carta?" and 3 searches in
-- "Busco…". scan_quota() and guard_wanted() no longer read subscriptions, which is dropped.

-- ------------------------------------------------------------------ referrals (0026)
drop trigger if exists listings_referral_reward on public.listings;
drop function if exists public.reward_referral();
drop function if exists public.claim_referral(text);
drop function if exists public.my_referrals();
drop function if exists public.grant_plan_month(uuid);
drop table if exists public.referrals;

-- ------------------------------------------------------------------ Plan Coleccionista (0012)
create or replace function public.scan_quota(p_use boolean default false) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  lim int := 3;
  used int;
  ok boolean;
  day_start timestamptz := date_trunc('day', now() at time zone 'America/Panama') at time zone 'America/Panama';
begin
  if uid is null then
    raise exception 'login required' using errcode = '42501';
  end if;
  if p_use then
    perform pg_advisory_xact_lock(hashtext('scan:' || uid::text)); -- two tabs can't both take the last scan
  end if;
  select count(*) into used from public.scan_log where user_id = uid and created_at >= day_start;
  ok := used < lim;
  if p_use and ok then
    insert into public.scan_log (user_id) values (uid);
    used := used + 1;
  end if;
  return jsonb_build_object('allowed', ok, 'used', used, 'limit', lim);
end $$;
revoke all on function public.scan_quota(boolean) from public, anon;
grant execute on function public.scan_quota(boolean) to authenticated;

create or replace function public.guard_wanted() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  lim int := 3;
begin
  new.query := left(regexp_replace(trim(new.query), '\s+', ' ', 'g'), 80);
  new.created_at := now();
  if (select count(*) from public.wanted where user_id = new.user_id) >= lim then
    raise exception 'wanted: limit %', lim using errcode = '22023';
  end if;
  return new;
end $$;

drop trigger if exists subscriptions_notify on public.subscriptions;
drop function if exists public.notify_plan();
drop table if exists public.subscriptions;
