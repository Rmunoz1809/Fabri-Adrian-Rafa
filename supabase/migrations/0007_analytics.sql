-- 0007: first-party analytics for the launch funnel (#/admin?tab=analitica).
-- Run once in Supabase ▸ SQL Editor after 0006 (safe to re-run).
--
-- Privacy (Ley 81 de 2019): visitors get a random id stored in their browser.
-- No IP, email, name or device data is stored. user_id is only set for
-- signed-in users (to exclude staff and count sign-ups), never shown in reports.

create table if not exists public.events (
  id bigint generated always as identity primary key,
  name text not null check (name in (
    'visita', 'registro', 'ver_carta', 'click_whatsapp', 'click_protegida', 'publicar', 'compartir'
  )),
  visitor_id uuid not null,
  user_id uuid default auth.uid(),
  listing_ref text check (char_length(listing_ref) <= 64), -- listing uuid, or a demo id like "l-001"
  path text check (char_length(path) <= 200),
  created_at timestamptz not null default now()
);
create index if not exists events_created_idx on public.events (created_at desc);
create index if not exists events_name_idx on public.events (name, created_at desc);
alter table public.events enable row level security;

-- Anyone can record an event, but only as themselves (or anonymously).
drop policy if exists "anyone records events" on public.events;
create policy "anyone records events" on public.events for insert to anon, authenticated
  with check (user_id is null or user_id = auth.uid());
-- Only staff read raw events.
drop policy if exists "staff read events" on public.events;
create policy "staff read events" on public.events for select using (public.is_staff());

-- Aggregates for the staff panel. Staff's own clicks are excluded.
create or replace function public.analytics_summary(p_days int default 7)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  since timestamptz := now() - make_interval(days => greatest(1, least(p_days, 365)));
  result jsonb;
begin
  if not public.is_staff() then
    raise exception 'staff only' using errcode = '42501';
  end if;
  with ev as (
    select e.* from public.events e
    left join public.profiles p on p.id = e.user_id
    where e.created_at >= since and coalesce(p.is_staff, false) = false
  )
  select jsonb_build_object(
    'days', greatest(1, least(p_days, 365)),
    'funnel', coalesce((select jsonb_object_agg(name, jsonb_build_object('visitors', v, 'events', n))
                        from (select name, count(distinct visitor_id) v, count(*) n from ev group by name) f), '{}'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'visitors', v) order by d)
                       from (select (created_at at time zone 'America/Panama')::date d, count(distinct visitor_id) v
                             from ev group by 1) x), '[]'::jsonb),
    'top_listings', coalesce((select jsonb_agg(jsonb_build_object('ref', t.listing_ref, 'title', l.title, 'views', t.views, 'visitors', t.visitors,
                                                                  'clicks', t.clicks) order by t.views desc)
                              from (select listing_ref,
                                           count(*) filter (where name = 'ver_carta') views,
                                           count(distinct visitor_id) filter (where name = 'ver_carta') visitors,
                                           count(*) filter (where name in ('click_whatsapp', 'click_protegida')) clicks
                                    from ev where listing_ref is not null group by listing_ref
                                    order by 2 desc limit 10) t
                              left join public.listings l on l.id::text = t.listing_ref), '[]'::jsonb)
  ) into result;
  return result;
end $$;
revoke all on function public.analytics_summary(int) from public, anon;
grant execute on function public.analytics_summary(int) to authenticated;
