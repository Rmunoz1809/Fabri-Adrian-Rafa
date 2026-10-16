-- 0031: Seller accounts. Run once in Supabase ▸ SQL Editor after 0030 (safe to re-run). It only builds on
-- 0001-0010, so it also works while 0028-0030 are still pending.
-- holo.html works before and after it: until it runs, the seller's phone and pickup address stay in the
-- account's metadata (auth user_metadata), and this migration copies them over (backfill at the end).
--
-- Accounts are normal (buy and consult) or seller accounts (pedido de Rafa, 2026-10-16). To sell, an account
-- needs a phone and the exact residence address where MarketZlab picks up the cards it sells. People sign
-- up as sellers with both, or turn a normal account into a seller account from "Vender" or Mi cuenta.
-- Both fields are private: only the person and staff read them; they never reach public_profiles or a
-- listing. This is a deliberate exception to 0001's "we never store addresses": the address is only
-- for picking up cards (Ley 81: the privacy policy says so).

create table if not exists public.seller_accounts (
  user_id uuid primary key references public.profiles on delete cascade,
  phone text not null check (phone ~ '^\+507(6[0-9]{7}|[2-57-9][0-9]{6})$'),
  pickup_address text not null check (char_length(pickup_address) between 10 and 240),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.seller_accounts enable row level security;
drop policy if exists "own or staff read seller account" on public.seller_accounts;
create policy "own or staff read seller account" on public.seller_accounts for select using (user_id = auth.uid() or public.is_staff());
-- No insert/update/delete policies: save_seller_account() and the sign-up trigger below write it.

-- A Panamanian phone as +507 and its digits, or null: a mobile (8 digits, starts with 6) or a landline
-- (7 digits). Accepts '6123-4567', '+507 6123 4567', '(507) 212-3456', '00507 61234567'.
create or replace function public.pa_phone(p text) returns text
  language sql immutable set search_path = public as $$
  select case when d ~ '^(6[0-9]{7}|[2-57-9][0-9]{6})$' then '+507' || d end
    from (select regexp_replace(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), '^(00)?507(?=[0-9]{7,8}$)', '') as d) x
$$;
create or replace function public.clean_pickup_address(p text) returns text
  language sql immutable set search_path = public as $$
  select trim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'))
$$;

create or replace function public.is_seller(p_user uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.seller_accounts where user_id = p_user)
$$;

-- Become a seller, or change the phone or address. Returns the saved row.
create or replace function public.save_seller_account(p_phone text, p_pickup_address text) returns public.seller_accounts
  language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  ph text := public.pa_phone(p_phone);
  addr text := public.clean_pickup_address(p_pickup_address);
  r public.seller_accounts;
begin
  if me is null then raise exception 'seller: sign in' using errcode = '42501'; end if;
  if ph is null then raise exception 'seller: phone' using errcode = '22023'; end if;
  if char_length(addr) not between 10 and 240 then raise exception 'seller: address' using errcode = '22023'; end if;
  insert into public.seller_accounts (user_id, phone, pickup_address) values (me, ph, addr)
  on conflict (user_id) do update set phone = excluded.phone, pickup_address = excluded.pickup_address, updated_at = now()
  returning * into r;
  return r;
end $$;

-- Seller data that came in the account's metadata: from the sign-up form, or saved there by the page
-- before this migration ran. Invalid data is skipped, never an error (the person completes it later).
create or replace function public.seller_account_from_meta(p_user uuid, p_meta jsonb) returns boolean
  language plpgsql security definer set search_path = public as $$
declare
  ph text := public.pa_phone(p_meta->>'seller_phone');
  addr text := public.clean_pickup_address(p_meta->>'pickup_address');
begin
  if coalesce(p_meta->>'account_type', '') <> 'seller' or ph is null or char_length(addr) not between 10 and 240 then
    return false;
  end if;
  insert into public.seller_accounts (user_id, phone, pickup_address) values (p_user, ph, addr)
  on conflict (user_id) do nothing;
  return true;
end $$;

-- 0010's sign-up trigger, plus the seller account of someone who signs up as a seller.
-- Seller data can never make a sign-up fail.
create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_name text := left(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), 40);
begin
  if char_length(coalesce(v_name, '')) < 2 then v_name := 'Coleccionista'; end if;
  insert into public.profiles (id, display_name) values (new.id, v_name);
  begin
    perform public.seller_account_from_meta(new.id, new.raw_user_meta_data);
  exception when others then
    raise warning 'seller account at sign-up skipped for %: %', new.id, sqlerrm;
  end;
  return new;
end $$;

-- Only seller accounts publish (staff and the SQL editor are exempt). Checked when a listing is created
-- and when one goes back on sale, so cards already on sale from before 0031 keep working.
create or replace function public.guard_listing_seller_account() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin_context() then return new; end if;
  if (tg_op = 'INSERT' or (new.status = 'active' and old.status is distinct from 'active'))
     and not public.is_seller(new.seller_id) then
    raise exception 'seller_account_required: add a phone and a pickup address to sell' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists listings_seller_account_guard on public.listings;
create trigger listings_seller_account_guard before insert or update of status on public.listings
  for each row execute function public.guard_listing_seller_account();

-- Staff panel ▸ Vendedores: who sells, how to reach them and where to pick up their cards. Also lists
-- people with cards on sale who never gave that data (accounts from before 0031), with phone null.
create or replace function public.staff_seller_accounts(p_query text default null)
returns table (user_id uuid, display_name text, email text, is_shop boolean, verified boolean, phone text,
               pickup_address text, seller_since timestamptz, updated_at timestamptz, cards_on_sale int)
  language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  q text := nullif(trim(coalesce(p_query, '')), '');
  q_digits text := nullif(regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g'), '');
begin
  if not public.is_staff() then raise exception 'sellers: staff only' using errcode = '42501'; end if;
  return query
    select p.id, p.display_name, u.email::text, p.is_shop, p.verified, s.phone, s.pickup_address, s.created_at, s.updated_at,
           (select count(*)::int from public.listings l where l.seller_id = p.id and l.status in ('active', 'reserved'))
      from public.profiles p
      join auth.users u on u.id = p.id
      left join public.seller_accounts s on s.user_id = p.id
     where (s.user_id is not null
            or exists (select 1 from public.listings l where l.seller_id = p.id and l.status in ('active', 'reserved')))
       and (q is null
            or p.display_name ilike '%' || q || '%' or u.email ilike '%' || q || '%' or s.pickup_address ilike '%' || q || '%'
            or (q_digits is not null and char_length(q_digits) >= 4 and s.phone like '%' || q_digits || '%'))
     order by s.created_at desc nulls last, p.display_name
     limit 300;
end $$;

-- People who signed up as sellers, or became sellers, before this migration ran.
select public.seller_account_from_meta(u.id, u.raw_user_meta_data)
  from auth.users u
  join public.profiles p on p.id = u.id
 where u.raw_user_meta_data->>'account_type' = 'seller';

revoke all on function public.pa_phone(text) from public, anon, authenticated;
revoke all on function public.clean_pickup_address(text) from public, anon, authenticated;
revoke all on function public.is_seller(uuid) from public, anon, authenticated;
revoke all on function public.seller_account_from_meta(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.guard_listing_seller_account() from public, anon, authenticated;
revoke all on function public.save_seller_account(text, text) from public, anon;
revoke all on function public.staff_seller_accounts(text) from public, anon;
grant execute on function public.save_seller_account(text, text) to authenticated;
grant execute on function public.staff_seller_accounts(text) to authenticated;
