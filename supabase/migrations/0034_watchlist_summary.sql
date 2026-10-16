-- 0034: "Lo más buscado" for staff, from the watchlists (0032). Run once in Supabase ▸ SQL Editor after
-- 0032 (safe to re-run). holo.html works before and after it: until it runs, Panel ▸ Analítica keeps
-- showing the old "Busco…" searches (wanted_summary, 0022).
--
-- The cards most people have in their watchlist, how many active listings have them, and their
-- reference price: the ones nobody sells are what to ask the shops to bring. Only counts per card leave
-- the database, never who wants them; staff only.

create or replace function public.watchlist_summary(p_limit int default 30)
returns table (catalog_id text, name text, set_name text, number text, graded boolean, image_url text,
               ref_price_cents int, people bigint, on_sale bigint)
  language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_staff() then raise exception 'watchlist_summary: staff only' using errcode = '42501'; end if;
  return query
  with g as (
    select coalesce(w.catalog_id, lower(w.name) || '#' || coalesce(lower(w.number), '')) as k, w.graded,
           max(w.catalog_id) as catalog_id, max(w.name) as name, max(w.set_name) as set_name, max(w.number) as number,
           max(w.image_url) as image_url, max(w.ref_price_cents) as ref_price_cents, count(distinct w.user_id) as people
      from public.watchlist w
     group by 1, 2
  )
  select g.catalog_id, g.name, g.set_name, g.number, g.graded, g.image_url, g.ref_price_cents, g.people,
         (select count(*) from public.listings l
           where l.status = 'active'
             and (g.graded = (l.grading_company is not null))
             and (l.catalog_id = g.catalog_id
                  or (g.catalog_id is null and public.norm_text(l.title) like '%' || public.norm_text(g.name) || '%'))) as on_sale
    from g
   order by g.people desc, g.ref_price_cents desc nulls last, g.name
   limit greatest(1, least(coalesce(p_limit, 30), 100));
end $$;

revoke all on function public.watchlist_summary(int) from public, anon;
grant execute on function public.watchlist_summary(int) to authenticated;
