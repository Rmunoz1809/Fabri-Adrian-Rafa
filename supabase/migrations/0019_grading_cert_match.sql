-- 0019: graded listings keep their own certificate number. Run once in Supabase ▸ SQL Editor after
-- 0018 (safe to re-run). holo.html works before and after it.
--
-- The 0009/0010 trigger took the seller's most recent label read with the same company and grade.
-- A shop that uploads several slabs with the same grade (e.g. three PSA 10s, from #/vender/graduadas)
-- would get the same certificate number on all of them. Now the read whose certificate matches the
-- one sent is used first; the rule is unchanged otherwise: the company, the grade and the certificate
-- always come from a label the AI read in a photo in the last 24 hours, never typed by the seller.
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
  -- Staff, the SQL editor and internal processes can correct a grade.
  if public.is_admin_context() then
    return new;
  end if;
  select * into d from public.grading_detections
   where user_id = new.seller_id
     and grading_company = new.grading_company
     and grade = new.grade
     and detected_at > now() - interval '24 hours'
   order by (cert_number is not distinct from new.cert_number) desc, detected_at desc
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
