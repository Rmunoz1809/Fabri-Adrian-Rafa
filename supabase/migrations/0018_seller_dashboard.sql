-- 0018: seller dashboard in "Mi cuenta" (holo.html). Run once in Supabase ▸ SQL Editor after 0017
-- (safe to re-run). holo.html works before and after it: until it runs, only staff see view counts.
--
-- A seller sees, per card and in total, how many times their cards were viewed, by how many distinct
-- visitors, how many visitors tapped "Comprar" or WhatsApp, and how many times they were shared.
-- Only counts leave the database: never visitor ids, names or emails (Ley 81 de 2019).
-- Not counted: the seller's own visits (signed in, or from a browser they have used signed in) and
-- staff visits, the same way analytics_summary() (0007) leaves staff out.

create index if not exists events_listing_idx on public.events (listing_ref, name) where listing_ref is not null;
create index if not exists events_user_idx on public.events (user_id) where user_id is not null;

create or replace function public.my_listing_stats()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  result jsonb;
begin
  if uid is null then
    raise exception 'login required' using errcode = '42501';
  end if;
  with mine as (
    select id::text as ref from public.listings where seller_id = uid
  ), own_browsers as (
    select distinct visitor_id from public.events where user_id = uid
  ), ev as (
    select e.listing_ref, e.name, e.visitor_id, e.created_at
      from public.events e
      join mine m on m.ref = e.listing_ref
      left join public.profiles p on p.id = e.user_id
     where e.name in ('ver_carta', 'click_whatsapp', 'click_protegida', 'compartir')
       and e.user_id is distinct from uid
       and coalesce(p.is_staff, false) = false
       and not exists (select 1 from own_browsers b where b.visitor_id = e.visitor_id)
  ), per_listing as (
    select listing_ref,
           count(*) filter (where name = 'ver_carta') as views,
           count(distinct visitor_id) filter (where name = 'ver_carta') as visitors,
           count(*) filter (where name = 'ver_carta' and created_at >= now() - interval '7 days') as views_7d,
           count(distinct visitor_id) filter (where name = 'ver_carta' and created_at >= now() - interval '7 days') as visitors_7d,
           count(distinct visitor_id) filter (where name in ('click_whatsapp', 'click_protegida')) as interested,
           count(*) filter (where name = 'compartir') as shares,
           max(created_at) filter (where name = 'ver_carta') as last_view
      from ev group by listing_ref
  )
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
                 'views', count(*) filter (where name = 'ver_carta'),
                 'visitors', count(distinct visitor_id) filter (where name = 'ver_carta'),
                 'views_7d', count(*) filter (where name = 'ver_carta' and created_at >= now() - interval '7 days'),
                 'visitors_7d', count(distinct visitor_id) filter (where name = 'ver_carta' and created_at >= now() - interval '7 days'),
                 'interested', count(distinct visitor_id) filter (where name in ('click_whatsapp', 'click_protegida')),
                 'shares', count(*) filter (where name = 'compartir'))
               from ev),
    'listings', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', listing_ref, 'views', views, 'visitors', visitors, 'views_7d', views_7d,
                 'visitors_7d', visitors_7d, 'interested', interested, 'shares', shares, 'last_view', last_view))
               from per_listing), '[]'::jsonb)
  ) into result;
  return result;
end $$;
revoke all on function public.my_listing_stats() from public, anon;
grant execute on function public.my_listing_stats() to authenticated;
