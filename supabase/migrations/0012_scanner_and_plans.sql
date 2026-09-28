-- 0012: "¿Cuánto vale tu carta?" scanner (#/escanear) and the Plan Coleccionista.
-- Run once in Supabase ▸ SQL Editor after 0011 (safe to re-run).
--
-- Free accounts get 3 scans per day (Panama time); an active Plan Coleccionista raises it to 50
-- (a ceiling against abuse, shown as "sin límite"). The quota lives in the database, so it can't be
-- skipped from the browser. Plans are activated by staff in #/admin?tab=planes for now; once the
-- Yappy payment button exists, the payment webhook writes the same row (source = 'yappy').

-- ------------------------------------------------------------------ plans
create table if not exists public.subscriptions (
  user_id uuid primary key references public.profiles on delete cascade,
  plan text not null default 'coleccionista' check (plan in ('coleccionista')),
  active_until timestamptz not null,
  source text not null default 'manual' check (source in ('manual', 'yappy', 'tilopay')),
  payment_ref text check (char_length(payment_ref) <= 120),
  updated_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
drop policy if exists "own or staff read subscription" on public.subscriptions;
create policy "own or staff read subscription" on public.subscriptions for select
  using (user_id = auth.uid() or public.is_staff());
drop policy if exists "staff manage subscriptions" on public.subscriptions;
create policy "staff manage subscriptions" on public.subscriptions for all
  using (public.is_staff()) with check (public.is_staff());
drop trigger if exists subscriptions_touch on public.subscriptions;
create trigger subscriptions_touch before update on public.subscriptions
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------------ scan quota
-- One row per scan. No policies: only scan_quota() (security definer) reads and writes it.
create table if not exists public.scan_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists scan_log_user_idx on public.scan_log (user_id, created_at desc);
alter table public.scan_log enable row level security;
revoke all on public.scan_log from anon, authenticated;

-- p_use = false: how many scans are left today. p_use = true: spend one (allowed = false when none left).
create or replace function public.scan_quota(p_use boolean default false) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  plan_until timestamptz;
  lim int;
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
  select s.active_until into plan_until from public.subscriptions s where s.user_id = uid and s.active_until > now();
  lim := case when plan_until is not null then 50 else 3 end;
  select count(*) into used from public.scan_log where user_id = uid and created_at >= day_start;
  ok := used < lim;
  if p_use and ok then
    insert into public.scan_log (user_id) values (uid);
    used := used + 1;
  end if;
  return jsonb_build_object('allowed', ok, 'used', used, 'limit', lim, 'plan_until', plan_until);
end $$;
revoke all on function public.scan_quota(boolean) from public, anon;
grant execute on function public.scan_quota(boolean) to authenticated;

-- ------------------------------------------------------------------ analytics
alter table public.events drop constraint if exists events_name_check;
alter table public.events add constraint events_name_check check (name in (
  'visita', 'registro', 'ver_carta', 'click_whatsapp', 'click_protegida', 'publicar', 'compartir', 'escanear'
));
