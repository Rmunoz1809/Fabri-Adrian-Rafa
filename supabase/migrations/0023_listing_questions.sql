-- 0023: public questions on a listing ("Preguntas"). Run once in Supabase ▸ SQL Editor after 0022
-- (safe to re-run). holo.html works before and after it: until it runs the section is not shown.
--
-- A signed-in buyer asks on the listing page; the seller answers there and everyone sees the answer.
-- Keeps the conversation (and the sale) inside Holo: questions and answers with phone numbers,
-- e-mails, links or "WhatsApp/Instagram" are refused here, in the database. Sellers and staff can hide
-- a question; the seller and the asker get notifications (0021).

create table if not exists public.listing_questions (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings on delete cascade,
  asker_id uuid not null references public.profiles on delete cascade,
  question text not null check (char_length(question) between 5 and 300),
  answer text check (char_length(answer) between 1 and 500),
  answered_at timestamptz,
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists listing_questions_listing_idx on public.listing_questions (listing_id, created_at);
create index if not exists listing_questions_asker_idx on public.listing_questions (asker_id, created_at desc);
alter table public.listing_questions enable row level security;
drop policy if exists "questions readable" on public.listing_questions;
create policy "questions readable" on public.listing_questions for select using (
  not hidden or asker_id = auth.uid() or public.is_staff()
  or exists (select 1 from public.listings l where l.id = listing_id and l.seller_id = auth.uid())
);
drop policy if exists "buyers ask" on public.listing_questions;
create policy "buyers ask" on public.listing_questions for insert to authenticated
  with check (asker_id = auth.uid() and answer is null and answered_at is null and hidden = false);
-- No update/delete policies: answers and hiding go through the functions below.

-- Contact details that would take the deal out of Holo.
create or replace function public.has_contact_info(p text) returns boolean
  language sql immutable as $$
  select coalesce(p, '') ~* '(\+?\m507\M|\m6[0-9]{3}[-. ]?[0-9]{4}\M|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|https?://|www\.|wa\.me|\.com\M|whats?app|wh?atsap|wasa+p|telegram|instagram|\minsta\M|\mig:)'
$$;

create or replace function public.guard_question() returns trigger
  language plpgsql security definer set search_path = public as $$
declare l public.listings;
begin
  select * into l from public.listings where id = new.listing_id;
  if not found or l.status <> 'active' then raise exception 'question: listing not available' using errcode = '22023'; end if;
  if l.seller_id = new.asker_id then raise exception 'question: own listing' using errcode = '22023'; end if;
  new.question := trim(regexp_replace(new.question, '\s+', ' ', 'g'));
  if char_length(new.question) < 5 then raise exception 'question: too short' using errcode = '22023'; end if;
  if public.has_contact_info(new.question) then raise exception 'question: contact info' using errcode = '22023'; end if;
  if (select count(*) from public.listing_questions where asker_id = new.asker_id and created_at > now() - interval '1 day') >= 20 then
    raise exception 'question: too many' using errcode = '22023';
  end if;
  new.created_at := now();
  return new;
end $$;
drop trigger if exists listing_questions_guard on public.listing_questions;
create trigger listing_questions_guard before insert on public.listing_questions
  for each row execute function public.guard_question();

create or replace function public.answer_question(p_question uuid, p_answer text) returns void
  language plpgsql security definer set search_path = public as $$
declare
  q public.listing_questions;
  a text := trim(regexp_replace(coalesce(p_answer, ''), '\s+', ' ', 'g'));
begin
  select * into q from public.listing_questions where id = p_question for update;
  if not found or not exists (select 1 from public.listings where id = q.listing_id and seller_id = auth.uid()) then
    raise exception 'question: not yours' using errcode = '42501';
  end if;
  if char_length(a) < 1 or char_length(a) > 500 then raise exception 'answer: length' using errcode = '22023'; end if;
  if public.has_contact_info(a) then raise exception 'answer: contact info' using errcode = '22023'; end if;
  update public.listing_questions set answer = a, answered_at = now() where id = q.id;
end $$;

-- The seller (on their listing) or staff hide a question; the asker can withdraw their own.
create or replace function public.hide_question(p_question uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare q public.listing_questions;
begin
  select * into q from public.listing_questions where id = p_question for update;
  if not found or not (public.is_staff() or q.asker_id = auth.uid()
      or exists (select 1 from public.listings where id = q.listing_id and seller_id = auth.uid())) then
    raise exception 'question: not yours' using errcode = '42501';
  end if;
  update public.listing_questions set hidden = true where id = q.id;
end $$;

create or replace function public.notify_question() returns trigger
  language plpgsql security definer set search_path = public as $$
declare l public.listings;
begin
  select * into l from public.listings where id = new.listing_id;
  if tg_op = 'INSERT' then
    perform public.notify(l.seller_id, 'question_new', 'Te preguntaron sobre ' || l.title,
      '“' || left(new.question, 200) || '”. Respóndela en la carta: todos verán la respuesta.', '#/carta/' || l.id);
  elsif new.answer is not null and old.answer is null then
    perform public.notify(new.asker_id, 'question_answered', 'Respondieron tu pregunta sobre ' || l.title,
      '“' || left(new.answer, 200) || '”', '#/carta/' || l.id);
  end if;
  return null;
end $$;
drop trigger if exists listing_questions_notify on public.listing_questions;
create trigger listing_questions_notify after insert or update of answer on public.listing_questions
  for each row execute function public.notify_question();

revoke all on function public.guard_question() from public, anon, authenticated;
revoke all on function public.notify_question() from public, anon, authenticated;
revoke all on function public.answer_question(uuid, text) from public, anon;
revoke all on function public.hide_question(uuid) from public, anon;
grant execute on function public.answer_question(uuid, text) to authenticated;
grant execute on function public.hide_question(uuid) to authenticated;
