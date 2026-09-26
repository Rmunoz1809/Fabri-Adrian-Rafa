-- Seller profiles: profile photo for everyone; shops (is_shop, staff-only since
-- 0002) also get a description and a photo of the store.
-- Run once in Supabase ▸ SQL Editor (safe to re-run).
--
-- Photos live in the public "profile-photos" bucket under "<user id>/...".
-- Profiles store the storage path (never a free URL), and a check constraint
-- keeps each path inside the owner's folder, so nobody can point their profile
-- at someone else's file or at an external tracker image.

alter table public.profiles
  add column if not exists avatar_path text,
  add column if not exists shop_description text,
  add column if not exists shop_photo_path text;

alter table public.profiles drop constraint if exists profiles_shop_description_len;
alter table public.profiles add constraint profiles_shop_description_len
  check (shop_description is null or char_length(shop_description) <= 280);

alter table public.profiles drop constraint if exists profiles_photo_paths_own_folder;
alter table public.profiles add constraint profiles_photo_paths_own_folder check (
  (avatar_path is null or (avatar_path like id::text || '/%' and avatar_path not like '%..%'))
  and (shop_photo_path is null or (shop_photo_path like id::text || '/%' and shop_photo_path not like '%..%'))
);

-- New columns go at the end so CREATE OR REPLACE keeps the view (and its grants).
create or replace view public.public_profiles as
  select id, display_name, avatar_url, is_shop, verified, created_at,
         avatar_path, shop_description, shop_photo_path
  from public.profiles;

-- ----------------------------------------------------------------- storage
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-photos', 'profile-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "users upload own profile photos" on storage.objects;
create policy "users upload own profile photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text);
-- remove() needs SELECT as well as DELETE (see 0002).
drop policy if exists "users read own profile photos" on storage.objects;
create policy "users read own profile photos" on storage.objects for select to authenticated
  using (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "users delete own profile photos" on storage.objects;
create policy "users delete own profile photos" on storage.objects for delete to authenticated
  using (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text);
