-- 0022: "Busco…" (wanted list). Run once in Supabase ▸ SQL Editor after 0021 (safe to re-run).
-- holo.html works before and after it: until it runs, #/busco says it opens soon.
--
-- A signed-in person saves what they are looking for (words, and optionally category, type and a
-- maximum price). When a listing goes live and matches, they get a notification (0021) with the link.
-- Free accounts keep up to 3 searches; the Plan Coleccionista (0012) raises it to 50.
-- Staff see the most wanted searches (wanted_summary): what shops should bring to Holo.

create table if not exists public.wanted (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  query text not null check (char_length(query) between 2 and 80),
  category text references public.categories,
  kind text not null default 'any' check (kind in ('any', 'raw', 'graded', 'sealed')),
  max_price_cents int check (max_price_cents between 100 and 10000000),
  created_at timestamptz not null default now()
);
create index if not exists wanted_user_idx on public.wanted (user_id, created_at desc);
alter table public.wanted enable row level security;
drop policy if exists "own wanted read" on public.wanted;
create policy "own wanted read" on public.wanted for select using (user_id = auth.uid());
drop policy if exists "own wanted insert" on public.wanted;
create policy "own wanted insert" on public.wanted for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "own wanted delete" on public.wanted;
create policy "own wanted delete" on public.wanted for delete using (user_id = auth.uid());

-- Each search tells a person about each listing once, even if the listing is re-published.
create table if not exists public.wanted_hits (
  wanted_id uuid not null references public.wanted on delete cascade,
  listing_id uuid not null references public.listings on delete cascade,
  created_at timestamptz not null default now(),
  primary key (wanted_id, listing_id)
);
alter table public.wanted_hits enable row level security; -- no policies: only the trigger writes it

-- Limit per account, and the stored text is trimmed.
create or replace function public.guard_wanted() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  lim int := case when exists (select 1 from public.subscriptions s where s.user_id = new.user_id and s.active_until > now()) then 50 else 3 end;
begin
  new.query := left(regexp_replace(trim(new.query), '\s+', ' ', 'g'), 80);
  new.created_at := now();
  if (select count(*) from public.wanted where user_id = new.user_id) >= lim then
    raise exception 'wanted: limit %', lim using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists wanted_guard on public.wanted;
create trigger wanted_guard before insert on public.wanted for each row execute function public.guard_wanted();

-- Accent- and case-insensitive text, like the page's search ("pokemon" finds "Pokémon").
create or replace function public.norm_text(p text) returns text
  language sql immutable as $$
  select lower(translate(coalesce(p, ''), 'áàâäãéèêëíìîïóòôöõúùûüñçÁÀÂÄÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÑÇ',
                                          'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC'))
$$;
-- Every word of the search (2+ letters or digits) must appear in the listing.
create or replace function public.wanted_matches(p_query text, p_hay text) returns boolean
  language sql immutable as $$
  select coalesce(bool_and(position(t in public.norm_text(p_hay)) > 0), false)
  from unnest(regexp_split_to_array(public.norm_text(p_query), '[^a-z0-9]+')) t
  where char_length(t) >= 2
$$;

create or replace function public.notify_wanted() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  w record;
  -- Sealed product also answers to its usual short names ("ETB 151", "booster box").
  hay text := concat_ws(' ', new.title, new.subject, new.set_name, new.number, new.variant,
    case new.sealed_kind when 'etb' then 'etb elite trainer box' when 'booster_box' then 'booster box caja de sobres'
      when 'booster_bundle' then 'booster bundle' when 'booster_pack' then 'sobre booster pack' when 'tin' then 'lata tin'
      when 'hobby_box' then 'hobby box' when 'blaster' then 'blaster box' else null end);
  l_kind text := case when new.product_type = 'sealed' then 'sealed' when new.grading_company is not null then 'graded' else 'raw' end;
begin
  if new.status <> 'active' or (tg_op = 'UPDATE' and old.status = 'active') then return null; end if;
  for w in
    select * from public.wanted
     where user_id <> new.seller_id
       and (category is null or category = new.category)
       and (wanted.kind = 'any' or wanted.kind = l_kind)
       and (max_price_cents is null or new.price_cents <= max_price_cents)
       and public.wanted_matches(query, hay)
  loop
    insert into public.wanted_hits (wanted_id, listing_id) values (w.id, new.id) on conflict do nothing;
    if found then
      perform public.notify(w.user_id, 'wanted_match', 'Publicaron algo que buscas: ' || new.title,
        public.usd(new.price_cents) || ' · ' || new.neighborhood || '. Tu búsqueda: “' || w.query || '”.', '#/carta/' || new.id);
    end if;
  end loop;
  return null;
end $$;
drop trigger if exists listings_wanted on public.listings;
create trigger listings_wanted after insert or update of status on public.listings
  for each row execute function public.notify_wanted();

-- Staff: what people look for (and how many listings matched), for the shops.
create or replace function public.wanted_summary() returns table (query text, people int, hits int, last_added timestamptz)
  language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  return query
  select min(w.query), count(distinct w.user_id)::int, count(h.listing_id)::int, max(w.created_at)
    from public.wanted w left join public.wanted_hits h on h.wanted_id = w.id
   group by public.norm_text(w.query)
   order by count(distinct w.user_id) desc, max(w.created_at) desc
   limit 50;
end $$;

revoke all on function public.guard_wanted() from public, anon, authenticated;
revoke all on function public.notify_wanted() from public, anon, authenticated;
revoke all on function public.wanted_summary() from public, anon;
grant execute on function public.wanted_summary() to authenticated;
