-- La graduación de un anuncio sale solo de la foto, nunca de lo que escriba el vendedor.
--
-- La Edge Function identificar-carta lee la etiqueta del slab (empresa, nota y certificado)
-- y guarda aquí cada lectura con la service role. El trigger de abajo rechaza cualquier
-- anuncio graduado cuya empresa y nota no coincidan con una lectura del mismo vendedor en
-- las últimas 24 horas, y el certificado se toma siempre de esa lectura. Así nadie puede
-- publicar como "PSA 10" una carta que no mostró en un slab, ni cambiar la nota después
-- (ni desde la página, ni llamando a la API directamente).
--
-- Orden: primero desplegar la función (supabase functions deploy identificar-carta ...),
-- luego correr esta migración. Al revés, las cartas graduadas no se podrían publicar hasta
-- desplegar. Los anuncios que ya existen no se tocan.

create table if not exists public.grading_detections (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  grading_company text not null check (grading_company in ('PSA', 'BGS', 'CGC', 'SGC', 'TAG')),
  grade numeric(3, 1) not null check (grade between 1 and 10),
  cert_number text check (char_length(cert_number) <= 30),
  detected_at timestamptz not null default now()
);
create index if not exists grading_detections_user_idx on public.grading_detections (user_id, detected_at desc);

-- Solo la service role escribe o lee: sin políticas, nadie más puede.
alter table public.grading_detections enable row level security;

create or replace function public.enforce_grading_from_photo() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  d public.grading_detections;
begin
  if new.grading_company is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.grading_company is not distinct from old.grading_company
     and new.grade is not distinct from old.grade
     and new.cert_number is not distinct from old.cert_number then
    return new;
  end if;
  -- El panel de staff y los procesos internos pueden corregir.
  if coalesce(auth.role(), '') = 'service_role' or public.is_staff() then
    return new;
  end if;
  select * into d from public.grading_detections
   where user_id = new.seller_id
     and grading_company = new.grading_company
     and grade = new.grade
     and detected_at > now() - interval '24 hours'
   order by detected_at desc
   limit 1;
  if not found then
    raise exception 'grading_from_photo: la graduación tiene que verse en la foto del slab'
      using errcode = 'P0001';
  end if;
  new.cert_number := d.cert_number;
  return new;
end;
$$;
revoke all on function public.enforce_grading_from_photo() from public, anon, authenticated;

drop trigger if exists listings_grading_from_photo on public.listings;
create trigger listings_grading_from_photo
  before insert or update of grading_company, grade, cert_number on public.listings
  for each row execute function public.enforce_grading_from_photo();
