-- 0002: let admins (SQL editor / service role) set privileged flags, and make
-- "tienda" a staff-controlled flag.
--
-- Bug fixed: the guard triggers from 0001 only allowed changes when
-- public.is_staff() was true. is_staff() looks up auth.uid(), which is NULL in
-- the Supabase SQL editor and for the service role, so admins could not mark a
-- shop as verified or enable Compra Protegida on a listing.
-- Requests from the app always carry a user JWT (anon visitors cannot update
-- these tables under RLS), so auth.uid() IS NULL means a trusted admin context.

create or replace function public.is_admin_context() returns boolean
  language sql stable as $$
  select auth.uid() is null or public.is_staff()
$$;

create or replace function public.guard_profile_flags() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin_context() then return new; end if;
  if tg_op = 'INSERT' then
    new.is_staff := false;
    new.verified := false;
    new.is_shop := false;
  elsif new.is_staff is distinct from old.is_staff
     or new.verified is distinct from old.verified
     or new.is_shop is distinct from old.is_shop then
    raise exception 'only staff can change is_staff/verified/is_shop';
  end if;
  return new;
end $$;

create or replace function public.guard_listing_flags() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin_context() then
    if tg_op = 'INSERT' then
      new.protected_eligible := false;
    elsif new.protected_eligible is distinct from old.protected_eligible
       or new.seller_id is distinct from old.seller_id then
      raise exception 'only staff can change protected_eligible/seller_id';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

-- Verified shops, for the "Tiendas verificadas" section.
create or replace view public.verified_shops as
  select id, display_name, avatar_url, created_at
  from public.profiles
  where is_shop and verified;
grant select on public.verified_shops to anon, authenticated;

-- How to verify a shop (run in the SQL editor, replacing the email):
--   update public.profiles set is_shop = true, verified = true
--   where id = (select id from auth.users where email = 'tienda@ejemplo.com');
