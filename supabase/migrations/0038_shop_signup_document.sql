-- 0038: Shop sign-up with the agreement uploaded as a file. Run once in Supabase ▸ SQL Editor after 0037
-- (safe to re-run). holo.html works before and after it: until it runs, a shop sign-up still creates the
-- account and a short request without the file, and the shop can upload the agreement later from Mi cuenta.
--
-- "Crear cuenta" offers Comprador (default), Vendedor and Tienda. A shop gives its name, e-mail and
-- password, downloads the agreement (docs/material/tiendas-acuerdo.pdf), fills it in, signs it and uploads
-- it (PDF or photo). The account stays "en revisión" until staff approve it in Panel ▸ Tiendas with
-- review_shop_request() (0037). Signing on screen (0037) is still the other way to send the agreement.
--
-- The file is a signed contract: it lives in the private shop-agreements bucket, only the shop and staff
-- open it, and nobody can replace or delete it from the app (Ley 81: kept while the shop sells with us).

alter table public.shop_requests
  add column if not exists document_path text;
alter table public.shop_requests drop constraint if exists shop_requests_document_own_folder;
alter table public.shop_requests add constraint shop_requests_document_own_folder check (
  document_path is null
  or (char_length(document_path) <= 200 and document_path like user_id::text || '/%' and document_path not like '%..%'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shop-agreements', 'shop-agreements', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
drop policy if exists "shops upload own agreement" on storage.objects;
create policy "shops upload own agreement" on storage.objects for insert to authenticated
  with check (bucket_id = 'shop-agreements' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "shops and staff read agreements" on storage.objects;
create policy "shops and staff read agreements" on storage.objects for select to authenticated
  using (bucket_id = 'shop-agreements' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_staff()));
-- No update or delete policies: an uploaded agreement stays as it was sent.

create or replace function public.submit_shop_document(p_shop_name text, p_document_path text) returns uuid
  language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_shop text := trim(regexp_replace(coalesce(p_shop_name, ''), '\s+', ' ', 'g'));
  v_id uuid;
begin
  if me is null or not exists (select 1 from public.profiles where id = me) then
    raise exception 'shop request: sign in' using errcode = '42501';
  end if;
  if exists (select 1 from public.shop_requests where user_id = me and status = 'pending') then
    raise exception 'shop request: already pending' using errcode = '22023';
  end if;
  if char_length(v_shop) not between 2 and 80 then raise exception 'shop request: shop name' using errcode = '22023'; end if;
  if coalesce(p_document_path, '') not like me::text || '/%' or p_document_path like '%..%'
     or char_length(p_document_path) > 200 or lower(p_document_path) !~ '\.(pdf|jpe?g|png|webp)$'
     or not exists (select 1 from storage.objects where bucket_id = 'shop-agreements' and name = p_document_path) then
    raise exception 'shop request: document' using errcode = '22023';
  end if;
  insert into public.shop_requests (user_id, shop_name, document_path, status)
  values (me, v_shop, p_document_path, 'pending')
  returning id into v_id;
  perform public.notify_staff('staff_shop', 'Solicitud de tienda nueva', v_shop || ' subió el acuerdo para tiendas firmado', '#/admin?tab=tiendas');
  return v_id;
end $$;

revoke all on function public.submit_shop_document(text, text) from public, anon;
grant execute on function public.submit_shop_document(text, text) to authenticated;
