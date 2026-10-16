-- Test data for the order / escrow flow (migration 0029). For a local or staging database only:
-- never run it on production. Used by the tests and by `npm run demo:flujo`.
--   Fixed ids so tests and the demo can refer to them:
--   staff         00000000-0000-4000-a000-000000000001  Holo Staff
--   verified shop 00000000-0000-4000-a000-000000000002  Cartas Panamá (tienda verificada, retiro en tienda)
--   person seller 00000000-0000-4000-a000-000000000003  Ana Vendedora (particular, vendedora nueva)
--   buyer         00000000-0000-4000-a000-000000000004  Beto Comprador
--   listings      00000000-0000-4000-b000-00000000000N

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-a000-000000000001', 'staff@holo.test', '{"display_name": "Holo Staff"}'),
  ('00000000-0000-4000-a000-000000000002', 'tienda@holo.test', '{"display_name": "Cartas Panamá"}'),
  ('00000000-0000-4000-a000-000000000003', 'ana@holo.test', '{"display_name": "Ana Vendedora"}'),
  ('00000000-0000-4000-a000-000000000004', 'beto@holo.test', '{"display_name": "Beto Comprador"}')
on conflict (id) do nothing;

update public.profiles set is_staff = true where id = '00000000-0000-4000-a000-000000000001';
update public.profiles
   set is_shop = true, verified = true, shop_pickup = true,
       shop_address = 'Vía España, local 4', shop_province = 'Panamá', shop_hours = 'L-S 10:00-19:00'
 where id = '00000000-0000-4000-a000-000000000002';

insert into public.payout_accounts (user_id, yappy_phone, holder_name) values
  ('00000000-0000-4000-a000-000000000002', '61234567', 'Cartas Panamá S.A.'),
  ('00000000-0000-4000-a000-000000000003', '67654321', 'Ana Vendedora')
on conflict (user_id) do nothing;

-- Seller accounts (migration 0031): the shop and Ana sell, Beto only buys.
insert into public.seller_accounts (user_id, phone, pickup_address) values
  ('00000000-0000-4000-a000-000000000002', '+50761234567', 'Vía España, edificio Plaza, local 4'),
  ('00000000-0000-4000-a000-000000000003', '+50767654321', 'San Francisco, calle 74, PH Las Palmas, apto 3B')
on conflict (user_id) do nothing;

insert into public.listings (id, seller_id, category, title, subject, set_name, number, condition, grading_company, grade,
                             price_cents, province, district, neighborhood, status, protected_eligible) values
  ('00000000-0000-4000-b000-000000000001', '00000000-0000-4000-a000-000000000002', 'pokemon',
   'Charizard ex 199/165 SIR', 'Charizard ex', '151', '199', 'NM', null, null,
   12000, 'Panamá', 'Panamá', 'El Cangrejo', 'active', true),
  ('00000000-0000-4000-b000-000000000002', '00000000-0000-4000-a000-000000000002', 'pokemon',
   'Pikachu Illustrator PSA 9 (réplica de prueba)', 'Pikachu', 'Promo', '001', null, 'PSA', 9.0,
   45000, 'Panamá', 'Panamá', 'El Cangrejo', 'active', true),
  ('00000000-0000-4000-b000-000000000003', '00000000-0000-4000-a000-000000000003', 'pokemon',
   'Umbreon VMAX Alt Art 215/203', 'Umbreon VMAX', 'Evolving Skies', '215', 'LP', null, null,
   8000, 'Panamá', 'Panamá', 'San Francisco', 'active', true),
  ('00000000-0000-4000-b000-000000000004', '00000000-0000-4000-a000-000000000003', 'nba',
   'Victor Wembanyama Prizm RC', 'Victor Wembanyama', 'Prizm 2023', '136', 'NM', null, null,
   3500, 'Panamá', 'San Miguelito', 'Villa Lucre', 'active', true),
  ('00000000-0000-4000-b000-000000000005', '00000000-0000-4000-a000-000000000003', 'pokemon',
   'Gengar VMAX Alt Art 271/264', 'Gengar VMAX', 'Fusion Strike', '271', 'NM', null, null,
   6000, 'Panamá', 'Panamá', 'San Francisco', 'active', true)
on conflict (id) do nothing;
