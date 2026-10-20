-- 0036: Shop sign-up with the signed store agreement. Run once in Supabase ▸ SQL Editor after 0035
-- (safe to re-run). holo.html works before and after it: until it runs, the form sends the old short
-- request (name, contact, location) and the staff panel approves it the old way.
--
-- A shop fills in the same data as the paper form (docs/material/tiendas-acuerdo.pdf): shop name, owner
-- and cédula, store address, phone/WhatsApp, Instagram, Yappy for payouts and pickup hours. It reads the
-- Términos y condiciones para tiendas and signs them on screen. The request keeps the drawn signature,
-- the terms version, the server time of signing, the browser and a SHA-256 of all of it, as evidence of
-- the electronic signature (Ley 51 de 2008). Staff approve in Panel ▸ Tiendas: that is MarketZlab's
-- signature (reviewer and date), and in one step the account becomes a verified shop, its store page
-- gets the address and hours, and it gets a seller account (0031) with pickup at the store.
--
-- Unlike the identity photos (0025), the agreement is a contract: it is kept while the shop sells with
-- us. The cédula, phone and Yappy number are private: only the shop and staff read the request (0005).

alter table public.shop_requests
  add column if not exists owner_name text check (owner_name is null or char_length(owner_name) between 4 and 80),
  add column if not exists owner_id_doc text check (owner_id_doc is null or owner_id_doc ~ '^[A-Z0-9-]{5,20}$'),
  add column if not exists address text check (address is null or char_length(address) between 10 and 240),
  add column if not exists province text check (province is null or char_length(province) <= 40),
  add column if not exists phone text check (phone is null or phone ~ '^\+507(6[0-9]{7}|[2-57-9][0-9]{6})$'),
  add column if not exists instagram text check (instagram is null or instagram ~ '^[a-z0-9._]{1,30}$'),
  add column if not exists yappy_phone text check (yappy_phone is null or yappy_phone ~ '^\+5076[0-9]{7}$'),
  add column if not exists pickup_hours text check (pickup_hours is null or char_length(pickup_hours) between 3 and 200),
  add column if not exists terms_version text check (terms_version is null or terms_version ~ '^tiendas-[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  add column if not exists signature_png text check (signature_png is null
    or (char_length(signature_png) between 500 and 200000 and signature_png ~ '^data:image/png;base64,[A-Za-z0-9+/=]+$')),
  add column if not exists signed_at timestamptz,
  add column if not exists signer_agent text check (signer_agent is null or char_length(signer_agent) <= 300),
  add column if not exists sign_hash text check (sign_hash is null or sign_hash ~ '^[0-9a-f]{64}$'),
  add column if not exists reviewer_id uuid references public.profiles on delete set null,
  add column if not exists reviewer_name text check (reviewer_name is null or char_length(reviewer_name) <= 80),
  add column if not exists review_note text check (review_note is null or char_length(review_note) <= 300);

-- From now on requests are written only by submit_shop_request() and review_shop_request(): a person
-- could otherwise insert a "signed" request without the checks, and staff approval must also verify
-- the profile in the same transaction. Reading stays as in 0005 (the person and staff).
drop policy if exists "users request verification" on public.shop_requests;
drop policy if exists "staff review requests" on public.shop_requests;

-- '@mitienda', 'instagram.com/MiTienda/', 'https://www.instagram.com/mitienda?igsh=x' -> 'mitienda'.
create or replace function public.ig_handle(p text) returns text
  language sql immutable set search_path = public as $$
  select case when h ~ '^[a-z0-9._]{1,30}$' then h end
    from (select regexp_replace(regexp_replace(lower(trim(coalesce(p, ''))),
                 '^(https?://)?(www\.)?(instagram\.com/)?@?', ''), '[/?#].*$', '') as h) x
$$;

-- The evidence hash: everything the shop signed, in a fixed order.
create or replace function public.shop_request_hash(r public.shop_requests) returns text
  language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(concat_ws(E'\n', r.id::text, r.user_id::text, r.shop_name, r.owner_name, r.owner_id_doc,
           r.address, r.province, r.phone, r.instagram, r.yappy_phone, r.pickup_hours, r.terms_version,
           to_char(r.signed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), r.signer_agent, r.signature_png), 'UTF8')), 'hex')
$$;

create or replace function public.submit_shop_request(
  p_shop_name text, p_owner_name text, p_owner_id_doc text, p_address text, p_province text, p_phone text,
  p_instagram text, p_yappy_phone text, p_pickup_hours text, p_terms_version text, p_signature_png text,
  p_signer_agent text default null) returns uuid
  language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  clean_space text := '\s+';
  v_shop text := trim(regexp_replace(coalesce(p_shop_name, ''), clean_space, ' ', 'g'));
  v_owner text := trim(regexp_replace(coalesce(p_owner_name, ''), clean_space, ' ', 'g'));
  v_doc text := upper(regexp_replace(coalesce(p_owner_id_doc, ''), clean_space, '', 'g'));
  v_addr text := public.clean_pickup_address(p_address);
  v_prov text := nullif(trim(coalesce(p_province, '')), '');
  v_phone text := public.pa_phone(p_phone);
  v_ig text := public.ig_handle(p_instagram);
  v_yappy text := public.pa_phone(coalesce(nullif(trim(p_yappy_phone), ''), p_phone));
  v_hours text := trim(regexp_replace(coalesce(p_pickup_hours, ''), clean_space, ' ', 'g'));
  r public.shop_requests;
begin
  if me is null or not exists (select 1 from public.profiles where id = me) then
    raise exception 'shop request: sign in' using errcode = '42501';
  end if;
  if exists (select 1 from public.shop_requests where user_id = me and status = 'pending') then
    raise exception 'shop request: already pending' using errcode = '22023';
  end if;
  if char_length(v_shop) not between 2 and 80 then raise exception 'shop request: shop name' using errcode = '22023'; end if;
  if char_length(v_owner) not between 4 and 80 then raise exception 'shop request: owner name' using errcode = '22023'; end if;
  if v_doc !~ '^[A-Z0-9-]{5,20}$' or v_doc !~ '[0-9]' then raise exception 'shop request: cedula' using errcode = '22023'; end if;
  if char_length(v_addr) not between 10 and 240 then raise exception 'shop request: address' using errcode = '22023'; end if;
  if char_length(coalesce(v_prov, '')) > 40 then raise exception 'shop request: province' using errcode = '22023'; end if;
  if v_phone is null then raise exception 'shop request: phone' using errcode = '22023'; end if;
  if v_ig is null then raise exception 'shop request: instagram' using errcode = '22023'; end if;
  if v_yappy is null or v_yappy !~ '^\+5076' then raise exception 'shop request: yappy' using errcode = '22023'; end if;
  if char_length(v_hours) not between 3 and 200 then raise exception 'shop request: hours' using errcode = '22023'; end if;
  if coalesce(p_terms_version, '') !~ '^tiendas-[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'shop request: terms version' using errcode = '22023';
  end if;
  if char_length(coalesce(p_signature_png, '')) not between 500 and 200000
     or p_signature_png !~ '^data:image/png;base64,[A-Za-z0-9+/=]+$' then
    raise exception 'shop request: signature' using errcode = '22023';
  end if;

  insert into public.shop_requests (user_id, shop_name, contact, location, owner_name, owner_id_doc, address, province,
                                    phone, instagram, yappy_phone, pickup_hours, terms_version, signature_png,
                                    signed_at, signer_agent, status)
  values (me, v_shop, '@' || v_ig, v_addr, v_owner, v_doc, v_addr, v_prov, v_phone, v_ig, v_yappy, v_hours,
          p_terms_version, p_signature_png, now(), left(nullif(trim(coalesce(p_signer_agent, '')), ''), 300), 'pending')
  returning * into r;
  update public.shop_requests set sign_hash = public.shop_request_hash(r) where id = r.id;
  perform public.notify_staff('staff_shop', 'Solicitud de tienda nueva', v_shop || ' firmó el acuerdo para tiendas', '#/admin?tab=tiendas');
  return r.id;
end $$;

-- Staff decision. Approving is MarketZlab's signature of the agreement (reviewer and date) and turns the
-- account into a verified shop with its store page and a seller account, all in one transaction.
create or replace function public.review_shop_request(p_id uuid, p_approve boolean, p_note text default null) returns void
  language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  r public.shop_requests;
  v_note text := left(nullif(trim(coalesce(p_note, '')), ''), 300);
  was_verified boolean;
begin
  if not public.is_staff() then raise exception 'shop request: staff only' using errcode = '42501'; end if;
  select * into r from public.shop_requests where id = p_id for update;
  if not found or r.status <> 'pending' then raise exception 'shop request: not pending' using errcode = '22023'; end if;

  update public.shop_requests
     set status = case when p_approve then 'approved' else 'rejected' end, reviewed_at = now(), reviewer_id = me,
         reviewer_name = (select left(display_name, 80) from public.profiles where id = me), review_note = v_note
   where id = p_id;

  if p_approve then
    select is_shop and verified into was_verified from public.profiles where id = r.user_id;
    update public.profiles
       set is_shop = true, verified = true,
           shop_address = coalesce(shop_address, case when char_length(r.address) >= 5 then left(r.address, 160) end),
           shop_province = coalesce(shop_province, r.province),
           shop_hours = coalesce(shop_hours, r.pickup_hours)
     where id = r.user_id;
    if r.phone is not null and r.address is not null then
      insert into public.seller_accounts (user_id, phone, pickup_address) values (r.user_id, r.phone, r.address)
      on conflict (user_id) do nothing;
    end if;
    -- notify_profile() (0025) sends "¡Tu tienda está verificada!" when verified changes; a shop that
    -- was already verified (signing the agreement later) gets this one instead.
    if was_verified then
      perform public.notify(r.user_id, 'shop_agreement', 'Acuerdo para tiendas aprobado',
        'MarketZlab firmó tu acuerdo. Puedes descargar la copia firmada en Mi cuenta.', '#/acuerdo-tienda');
    end if;
  else
    perform public.notify(r.user_id, 'shop_rejected', 'No pudimos aprobar tu tienda',
      coalesce(v_note, 'Revisa los datos de tu tienda y vuelve a enviar la solicitud.'), '#/cuenta?tienda=1');
  end if;
end $$;

-- The signed copy shows whether the stored request still matches its hash (nobody changed it).
create or replace function public.shop_request_intact(p_id uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select r.sign_hash is not null and r.sign_hash = public.shop_request_hash(r)
    from public.shop_requests r
   where r.id = p_id and (r.user_id = auth.uid() or public.is_staff())
$$;

revoke all on function public.ig_handle(text) from public, anon, authenticated;
revoke all on function public.shop_request_hash(public.shop_requests) from public, anon, authenticated;
revoke all on function public.submit_shop_request(text, text, text, text, text, text, text, text, text, text, text, text) from public, anon;
revoke all on function public.review_shop_request(uuid, boolean, text) from public, anon;
grant execute on function public.submit_shop_request(text, text, text, text, text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.review_shop_request(uuid, boolean, text) to authenticated;
revoke all on function public.shop_request_intact(uuid) from public, anon;
grant execute on function public.shop_request_intact(uuid) to authenticated;
