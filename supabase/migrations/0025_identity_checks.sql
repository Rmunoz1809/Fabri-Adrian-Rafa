-- 0025: "Identidad verificada" for individual sellers. Run once in Supabase ▸ SQL Editor after 0024
-- (safe to re-run). holo.html works before and after it: until it runs, the request form says it opens soon.
--
-- An individual (not a shop: shops have their own verification) sends their full name, a photo of
-- their cédula and a selfie holding it. Staff compare them and approve or reject. Approval sets the
-- existing profiles.verified flag, shown as "Identidad verificada". The photos live in the private
-- identity-docs bucket, only the person and staff can open them, and the staff panel deletes them
-- right after the decision (Ley 81: keep personal data only while needed). The cédula number is never stored.

create table if not exists public.identity_checks (
  user_id uuid primary key references public.profiles on delete cascade,
  full_name text not null check (char_length(full_name) between 4 and 80),
  doc_path text check (char_length(doc_path) <= 200),
  selfie_path text check (char_length(selfie_path) <= 200),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  note text check (char_length(note) <= 300),
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz
);
alter table public.identity_checks enable row level security;
drop policy if exists "own or staff read identity" on public.identity_checks;
create policy "own or staff read identity" on public.identity_checks for select using (user_id = auth.uid() or public.is_staff());
-- No write policies: submit_identity() and review_identity() below.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('identity-docs', 'identity-docs', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
drop policy if exists "users upload identity docs" on storage.objects;
create policy "users upload identity docs" on storage.objects for insert to authenticated
  with check (bucket_id = 'identity-docs' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "users and staff read identity docs" on storage.objects;
create policy "users and staff read identity docs" on storage.objects for select to authenticated
  using (bucket_id = 'identity-docs' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_staff()));
drop policy if exists "users and staff delete identity docs" on storage.objects;
create policy "users and staff delete identity docs" on storage.objects for delete to authenticated
  using (bucket_id = 'identity-docs' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_staff()));

create or replace function public.submit_identity(p_full_name text, p_doc_path text, p_selfie_path text) returns void
  language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  p public.profiles;
  name text := trim(regexp_replace(coalesce(p_full_name, ''), '\s+', ' ', 'g'));
begin
  select * into p from public.profiles where id = uid;
  if uid is null or not found then raise exception 'login required' using errcode = '42501'; end if;
  if p.is_shop then raise exception 'identity: shops use shop verification' using errcode = '22023'; end if;
  if p.verified then raise exception 'identity: already verified' using errcode = '22023'; end if;
  if exists (select 1 from public.identity_checks where user_id = uid and status = 'pending') then
    raise exception 'identity: already pending' using errcode = '22023';
  end if;
  if char_length(name) < 4 or char_length(name) > 80 then raise exception 'identity: name' using errcode = '22023'; end if;
  if p_doc_path not like uid::text || '/%' or p_selfie_path not like uid::text || '/%'
     or p_doc_path like '%..%' or p_selfie_path like '%..%' then
    raise exception 'identity: bad path' using errcode = '22023';
  end if;
  insert into public.identity_checks (user_id, full_name, doc_path, selfie_path, status, note, submitted_at, reviewed_at)
  values (uid, name, p_doc_path, p_selfie_path, 'pending', null, now(), null)
  on conflict (user_id) do update set full_name = excluded.full_name, doc_path = excluded.doc_path,
    selfie_path = excluded.selfie_path, status = 'pending', note = null, submitted_at = now(), reviewed_at = null;
  perform public.notify_staff('staff_identity', 'Verificación de identidad nueva', name, '#/admin?tab=identidad');
end $$;

-- Staff decision. Returns the photo paths so the panel deletes the files right away.
create or replace function public.review_identity(p_user uuid, p_approve boolean, p_note text default null)
  returns text[] language plpgsql security definer set search_path = public as $$
declare c public.identity_checks;
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  select * into c from public.identity_checks where user_id = p_user for update;
  if not found or c.status <> 'pending' then raise exception 'identity: not pending' using errcode = '22023'; end if;
  update public.identity_checks
     set status = case when p_approve then 'approved' else 'rejected' end, reviewed_at = now(),
         note = left(nullif(trim(coalesce(p_note, '')), ''), 300), doc_path = null, selfie_path = null
   where user_id = p_user;
  if p_approve then
    update public.profiles set verified = true where id = p_user and not is_shop;
  else
    perform public.notify(p_user, 'identity_rejected', 'No pudimos verificar tu identidad',
      coalesce(left(p_note, 300), 'Revisa que las fotos se vean claras y que el nombre sea el de tu cédula, y envíalas de nuevo.'), '#/cuenta');
  end if;
  return array_remove(array[c.doc_path, c.selfie_path], null);
end $$;

-- The 0021 notification said "tienda" for every verified profile: individuals get their own text.
create or replace function public.notify_profile() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.verified and not old.verified then
    if new.is_shop then
      perform public.notify(new.id, 'shop_verified', '¡Tu tienda está verificada!',
        'Tus anuncios ya llevan el sello de tienda verificada.', '#/vendedor/' || new.id);
    else
      perform public.notify(new.id, 'identity_verified', '¡Tu identidad está verificada!',
        'Tus anuncios ya llevan el sello de identidad verificada.', '#/vendedor/' || new.id);
    end if;
  end if;
  return null;
end $$;

revoke all on function public.submit_identity(text, text, text) from public, anon;
revoke all on function public.review_identity(uuid, boolean, text) from public, anon;
grant execute on function public.submit_identity(text, text, text) to authenticated;
grant execute on function public.review_identity(uuid, boolean, text) to authenticated;
revoke all on function public.notify_profile() from public, anon, authenticated;
