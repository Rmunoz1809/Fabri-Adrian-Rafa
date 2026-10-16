-- 0030: Consultas. Run once in Supabase ▸ SQL Editor (safe to re-run; it only needs 0001's profiles,
-- listings and is_staff, so it can go in before 0029).
-- holo.html works before and after it: until it runs, "Consultar" still opens WhatsApp (when
-- CONFIG.WHATSAPP is set) but nothing is recorded, and the staff "Consultas" tab says it is missing.
--
-- Replaces offers and Compra Protegida on the page (2026-10-16): a signed-in person asks MarketZlab
-- about a card (or anything else) and continues the conversation on MarketZlab's WhatsApp. Each
-- consulta gets a short code (e.g. MZ-7K2M9Q) that goes in the WhatsApp message, so staff can find
-- it in the panel. The tables of 0013 (offers) and 0014-0029 (orders) stay untouched, unused.

create table if not exists public.inquiries (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  user_id uuid references public.profiles on delete set null,
  source text not null default 'carta' check (source in ('carta', 'watchlist', 'general')),
  listing_id uuid references public.listings on delete set null,
  subject text not null check (char_length(subject) between 2 and 160),
  price_cents int check (price_cents between 1 and 100000000),
  catalog_ref text check (char_length(catalog_ref) <= 64),
  message text check (char_length(message) <= 500),
  contact_phone text check (char_length(contact_phone) <= 30),
  status text not null default 'nueva' check (status in ('nueva', 'en_curso', 'cerrada')),
  staff_note text check (char_length(staff_note) <= 1000),
  handled_by uuid references public.profiles on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists inquiries_user_idx on public.inquiries (user_id, created_at desc);
create index if not exists inquiries_status_idx on public.inquiries (status, created_at desc);
alter table public.inquiries enable row level security;
drop policy if exists "own inquiries read" on public.inquiries;
create policy "own inquiries read" on public.inquiries for select using (user_id = auth.uid() or public.is_staff());
-- No insert/update/delete policies: everything goes through the functions below.

-- A new consulta. The listing's title and price are copied from the database (not trusted from the
-- page); for a card that is not on sale (the watchlist) the page sends its name, reference price and
-- catalog id. Returns the code to put in the WhatsApp message.
create or replace function public.create_inquiry(
  p_source text default 'carta',
  p_listing_id uuid default null,
  p_subject text default null,
  p_price_cents int default null,
  p_catalog_ref text default null,
  p_message text default null,
  p_contact_phone text default null
) returns text
  language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  l public.listings;
  subj text := left(trim(regexp_replace(coalesce(p_subject, ''), '\s+', ' ', 'g')), 160);
  price int := p_price_cents;
  msg text := nullif(left(trim(regexp_replace(coalesce(p_message, ''), '\s+', ' ', 'g')), 500), '');
  phone text := nullif(trim(coalesce(p_contact_phone, '')), '');
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  new_code text;
begin
  if me is null then raise exception 'inquiry: sign in' using errcode = '42501'; end if;
  if p_source not in ('carta', 'watchlist', 'general') then raise exception 'inquiry: source' using errcode = '22023'; end if;
  if p_listing_id is not null then
    select * into l from public.listings where id = p_listing_id;
    if not found then raise exception 'inquiry: listing not available' using errcode = '22023'; end if;
    subj := left(l.title, 160);
    price := l.price_cents;
  end if;
  if char_length(subj) < 2 then raise exception 'inquiry: subject' using errcode = '22023'; end if;
  if price is not null and not (price between 1 and 100000000) then price := null; end if;
  if phone is not null and (phone !~ '^\+?[0-9 ()-]{7,30}$' or char_length(regexp_replace(phone, '\D', '', 'g')) not between 7 and 15) then
    raise exception 'inquiry: phone' using errcode = '22023';
  end if;
  if (select count(*) from public.inquiries where user_id = me and created_at > now() - interval '1 day') >= 30 then
    raise exception 'inquiry: too many' using errcode = '22023';
  end if;
  loop
    new_code := 'MZ-' || (select string_agg(substr(alphabet, 1 + floor(random() * 32)::int, 1), '') from generate_series(1, 6));
    exit when not exists (select 1 from public.inquiries where code = new_code);
  end loop;
  insert into public.inquiries (code, user_id, source, listing_id, subject, price_cents, catalog_ref, message, contact_phone)
  values (new_code, me, p_source, p_listing_id, subj, price, nullif(left(trim(coalesce(p_catalog_ref, '')), 64), ''), msg, phone);
  return new_code;
end $$;

-- Staff move a consulta along (nueva → en curso → cerrada) and keep a private note.
create or replace function public.staff_update_inquiry(p_id uuid, p_status text, p_note text default null) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'inquiry: staff only' using errcode = '42501'; end if;
  if p_status not in ('nueva', 'en_curso', 'cerrada') then raise exception 'inquiry: status' using errcode = '22023'; end if;
  update public.inquiries
     set status = p_status, staff_note = nullif(left(trim(coalesce(p_note, '')), 1000), ''), handled_by = auth.uid(), updated_at = now()
   where id = p_id;
  if not found then raise exception 'inquiry: not found' using errcode = '22023'; end if;
end $$;

revoke all on function public.create_inquiry(text, uuid, text, int, text, text, text) from public, anon;
revoke all on function public.staff_update_inquiry(uuid, text, text) from public, anon;
grant execute on function public.create_inquiry(text, uuid, text, int, text, text, text) to authenticated;
grant execute on function public.staff_update_inquiry(uuid, text, text) to authenticated;
