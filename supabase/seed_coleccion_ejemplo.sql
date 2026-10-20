-- Ejemplo de colección pública con interesados (necesita las migraciones 0033, 0035 y 0036).
-- Pone 7 cartas de ejemplo en el portafolio de UNA cuenta, visibles en su perfil, y crea 8 cuentas de
-- ejemplo que marcan "Me interesa" en ellas (y en sus cartas en venta, si tiene). Así esa cuenta ve en
-- Mi portafolio cuántas personas quieren cada carta, y su perfil se ve como el de un coleccionista.
--
-- Correr en Supabase ▸ SQL Editor después de cambiar el correo en la línea marcada. Se puede correr de
-- nuevo: primero borra el ejemplo anterior. Para quitarlo todo, corre solo el bloque del final.
-- Las cuentas de ejemplo no pueden entrar (no tienen contraseña) y nadie ve quiénes son.

do $$
declare
  v_email text := 'TU_CORREO@ejemplo.com'; -- ← correo de la cuenta que verá el ejemplo
  v_note constant text := 'Carta de ejemplo (seed_coleccion_ejemplo.sql)';
  v_me uuid;
  v_item uuid;
  v_people uuid[];
  v_card record;
  v_listing record;
  v_n int;
begin
  select id into v_me from auth.users where lower(email) = lower(trim(v_email));
  if v_me is null then
    raise exception 'No hay ninguna cuenta con el correo %. Cambia v_email al principio del archivo.', v_email;
  end if;

  -- 1. Borra el ejemplo anterior (sus cartas y las cuentas de ejemplo; sus "Me interesa" se van con ellas).
  delete from public.portfolio_items where user_id = v_me and note = v_note;
  delete from auth.users where email like 'ejemplo-%@ejemplo.marketzlab.invalid';

  -- 2. Ocho cuentas de ejemplo (el perfil lo crea handle_new_user).
  for i in 1..8 loop
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change_token_new, email_change)
    values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            format('ejemplo-%s@ejemplo.marketzlab.invalid', i), '', now(),
            '{"provider": "email", "providers": ["email"]}', jsonb_build_object('display_name', format('Cuenta de ejemplo %s', i)),
            now(), now(), '', '', '', '');
  end loop;
  select array_agg(id order by email) into v_people from auth.users where email like 'ejemplo-%@ejemplo.marketzlab.invalid';

  -- 3. Las cartas, agregadas hace unas semanas para que "Rendimiento" tenga historia. Las Pokémon sin
  --    graduar no llevan valor de entrada: la página lo saca del historial de precios del día en que se
  --    agregaron. Los guardias se apagan solo dentro de esta transacción para poder poner esas fechas.
  alter table public.portfolio_items disable trigger portfolio_items_guard;
  alter table public.card_interests disable trigger card_interests_guard;
  for v_card in
    select * from (values
      -- subject, set, year, number, variant, catalog id, grader, grade, image, value today, entry value, days ago, people interested
      ('Umbreon VMAX', 'Evolving Skies', '2021', '215/203', 'Alternate Art', 'swsh7-215', null, null,
       'https://images.pokemontcg.io/swsh7/215_hires.png', 232450, null, 60, 8),
      ('Charizard ex', '151', '2023', '199/165', 'Special Illustration Rare', 'sv3pt5-199', null, null,
       'https://images.pokemontcg.io/sv3pt5/199_hires.png', 31336, null, 42, 6),
      ('Pikachu ex', 'Surging Sparks', '2024', '238/191', 'Special Illustration Rare', 'sv8-238', null, null,
       'https://images.pokemontcg.io/sv8/238_hires.png', 26868, null, 30, 5),
      ('Charizard ex', '151', '2023', '199/165', 'Special Illustration Rare', 'sv3pt5-199', 'PSA', 10,
       'https://images.pokemontcg.io/sv3pt5/199_hires.png', 78000, 80000, 14, 4),
      ('Wilt Chamberlain', 'Fleer', '1961', '#8', 'Rookie Card', null, null, null,
       'https://rmunoz1809.github.io/Fabri-Adrian-Rafa/img/gate/nba-wilt-chamberlain-1961-fleer.jpg', 240000, 220000, 25, 3),
      ('Iono', 'Paldea Evolved', '2023', '254/193', 'Special Illustration Rare', 'sv2-254', null, null,
       'https://images.pokemontcg.io/sv2/254_hires.png', 1024, null, 19, 2),
      ('Mew ex', '151', '2023', '151/165', 'Double Rare', 'sv3pt5-151', null, null,
       'https://images.pokemontcg.io/sv3pt5/151_hires.png', 627, null, 9, 1)
    ) as c(subject, set_name, year, number, variant, catalog_id, grader, grade, image_url, value_cents, entry_cents, days, people)
  loop
    insert into public.portfolio_items (user_id, category, subject, set_name, year, number, variant, catalog_id,
                                        grading_company, grade, condition, image_url, quantity, value_cents, value_at,
                                        added_value_cents, note, is_public, created_at, updated_at)
    values (v_me, case when v_card.catalog_id is null then 'nba' else 'pokemon' end, v_card.subject, v_card.set_name,
            v_card.year, v_card.number, v_card.variant, v_card.catalog_id, v_card.grader, v_card.grade,
            case when v_card.grader is null then (case when v_card.catalog_id is null then 'LP' else 'NM' end) end,
            v_card.image_url, 1, v_card.value_cents,
            -- Raw Pokémon cards look for today's price again (and their entry value) the first time they're seen.
            case when v_card.entry_cents is null then now() - interval '1 day' else now() end,
            v_card.entry_cents, v_note, true, now() - make_interval(days => v_card.days), now())
    returning id into v_item;
    for i in 1..v_card.people loop
      insert into public.card_interests (user_id, owner_id, portfolio_item_id, created_at)
      values (v_people[i], v_me, v_item, now() - make_interval(hours => (i * 37 + v_card.days * 5) % (v_card.days * 24)));
    end loop;
  end loop;

  -- 4. Si la cuenta tiene cartas en venta, también hay gente interesada en ellas.
  v_n := 0;
  for v_listing in select id from public.listings where seller_id = v_me and status = 'active' order by created_at desc limit 5 loop
    v_n := v_n + 1;
    for i in 1..(4 - least(v_n, 3)) loop
      insert into public.card_interests (user_id, owner_id, listing_id, created_at)
      values (v_people[i + 4], v_me, v_listing.id, now() - make_interval(hours => i * 11 + v_n * 3));
    end loop;
  end loop;
  alter table public.card_interests enable trigger card_interests_guard;
  alter table public.portfolio_items enable trigger portfolio_items_guard;

  raise notice 'Listo: 7 cartas de ejemplo en el perfil de % y 8 cuentas de ejemplo interesadas.', v_email;
end $$;

-- ------------------------------------------------------------------ Borrar el ejemplo
-- Corre solo esto (cambia el correo) para quitar las cartas y las cuentas de ejemplo:
--
-- delete from public.portfolio_items
--  where note = 'Carta de ejemplo (seed_coleccion_ejemplo.sql)'
--    and user_id = (select id from auth.users where lower(email) = lower('TU_CORREO@ejemplo.com'));
-- delete from auth.users where email like 'ejemplo-%@ejemplo.marketzlab.invalid';
