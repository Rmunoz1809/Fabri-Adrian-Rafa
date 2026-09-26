-- Historial de precios de mercado (TCGplayer) por carta del catálogo Pokémon.
-- Correr una vez en Supabase ▸ SQL Editor del proyecto de Holo.
-- La base de datos consulta el precio ella misma: el navegador no puede escribir precios.

create extension if not exists http with schema extensions;
create extension if not exists pg_cron;

-- 0001_init.sql used to create an older, unused price_snapshots (card_id/captured_at).
-- If that version is present, drop it so this schema is created. Refuses if it has rows.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'price_snapshots' and column_name = 'card_id') then
    if exists (select 1 from public.price_snapshots) then
      raise exception 'old price_snapshots has data; migrate it by hand before running this file';
    end if;
    drop table public.price_snapshots;
  end if;
end $$;

create table if not exists public.price_snapshots (
  catalog_id   text    not null,
  variant      text    not null,
  market_cents integer not null check (market_cents > 0),
  captured_on  date    not null default current_date,
  primary key (catalog_id, variant, captured_on)
);
alter table public.price_snapshots enable row level security;
drop policy if exists "price_snapshots lectura pública" on public.price_snapshots;
create policy "price_snapshots lectura pública" on public.price_snapshots for select using (true);
-- Sin políticas de insert/update/delete: sólo escriben las funciones de abajo.

-- Guarda el precio de hoy de una carta (una vez por día). Uso interno.
create or replace function public._snapshot_price(p_catalog_id text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  res  extensions.http_response;
  item record;
  val  numeric;
begin
  if p_catalog_id !~ '^[a-z0-9.]+-[a-z0-9]+$' then return; end if;
  if exists (select 1 from price_snapshots where catalog_id = p_catalog_id and captured_on = current_date) then return; end if;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '8');
  res := extensions.http_get('https://api.pokemontcg.io/v2/cards/' || p_catalog_id || '?select=tcgplayer');
  if res.status <> 200 then return; end if;
  for item in select key, value from jsonb_each(coalesce((res.content::jsonb) #> '{data,tcgplayer,prices}', '{}'::jsonb)) loop
    val := coalesce((item.value->>'market')::numeric, (item.value->>'mid')::numeric);
    if val > 0 then
      insert into price_snapshots (catalog_id, variant, market_cents)
      values (p_catalog_id, item.key, round(val * 100)) on conflict do nothing;
    end if;
  end loop;
end $$;
revoke all on function public._snapshot_price(text) from public, anon, authenticated;

-- Versión pública (la llama la página de detalle): sólo cartas con anuncio activo.
create or replace function public.snapshot_price(p_catalog_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from listings where catalog_id = p_catalog_id and status = 'active') then
    perform public._snapshot_price(p_catalog_id);
  end if;
end $$;
revoke all on function public.snapshot_price(text) from public;
grant execute on function public.snapshot_price(text) to anon, authenticated;

-- Foto diaria (6:15 UTC) de todas las cartas con anuncio activo + las de ejemplo.
select cron.unschedule('holo-precios-diarios') where exists (select 1 from cron.job where jobname = 'holo-precios-diarios');
select cron.schedule('holo-precios-diarios', '15 6 * * *', $cron$
  select public._snapshot_price(c) from (
    select distinct catalog_id c from public.listings where status = 'active' and catalog_id is not null
    union select unnest(array['sv3pt5-199', 'sv8-238', 'swsh7-215', 'sv3pt5-151', 'sv2-254'])
  ) t
$cron$);
