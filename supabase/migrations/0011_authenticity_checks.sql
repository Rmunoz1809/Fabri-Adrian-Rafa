-- 0011: authenticity check at a partner shop ("Revisión en tienda"). Run once in Supabase ▸ SQL Editor
-- after 0010 (safe to re-run). holo.html works before and after it: without this table the request
-- button explains that the service opens soon.
--
-- Flow: the seller requests a check for their own active listing → pays by Yappy (staff marks it paid)
-- → takes the card to the partner shop themselves → staff records the shop and the result.
-- Holo never holds the card. A passed check shows "Revisada por <tienda>" on the listing; it is the
-- shop's opinion, not a guarantee (see Términos).

create table if not exists public.authenticity_checks (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references public.listings on delete set null,
  requester_id uuid not null references public.profiles on delete cascade,
  listing_title text not null check (char_length(listing_title) <= 200), -- kept if the listing is deleted
  contact text not null check (char_length(contact) between 7 and 120), -- seller's WhatsApp, staff only
  shop_id uuid references public.profiles on delete set null,          -- the verified shop that checked it
  status text not null default 'requested'
    check (status in ('requested', 'paid', 'authentic', 'not_authentic', 'inconclusive', 'cancelled')),
  notes text check (char_length(notes) <= 500),                         -- staff only: payment ref, date…
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  checked_at timestamptz
);
create index if not exists authenticity_checks_listing_idx on public.authenticity_checks (listing_id);
create unique index if not exists authenticity_checks_one_open
  on public.authenticity_checks (listing_id) where status in ('requested', 'paid');
alter table public.authenticity_checks enable row level security;

-- Sellers request checks only for their own active listing, and can't pre-fill staff fields.
drop policy if exists "sellers request checks" on public.authenticity_checks;
create policy "sellers request checks" on public.authenticity_checks for insert to authenticated
  with check (
    requester_id = auth.uid() and status = 'requested'
    and shop_id is null and notes is null and checked_at is null
    and exists (select 1 from public.listings l
                where l.id = listing_id and l.seller_id = auth.uid() and l.status = 'active')
  );
drop policy if exists "requester and staff read checks" on public.authenticity_checks;
create policy "requester and staff read checks" on public.authenticity_checks for select
  using (requester_id = auth.uid() or public.is_staff());
drop policy if exists "staff update checks" on public.authenticity_checks;
create policy "staff update checks" on public.authenticity_checks for update
  using (public.is_staff()) with check (public.is_staff());

drop trigger if exists authenticity_checks_touch on public.authenticity_checks;
create trigger authenticity_checks_touch before update on public.authenticity_checks
  for each row execute function public.touch_updated_at();

-- Public badge: only passed checks of active listings, with the shop's public name.
-- Runs with the owner's rights (like public_profiles) and is read-only for everyone (see 0010).
create or replace view public.listing_authenticity as
  select distinct on (c.listing_id) c.listing_id, p.display_name as shop_name, c.checked_at
  from public.authenticity_checks c
  join public.listings l on l.id = c.listing_id and l.status in ('active', 'reserved')
  left join public.profiles p on p.id = c.shop_id
  where c.status = 'authentic'
  order by c.listing_id, c.checked_at desc nulls last;
revoke all on public.listing_authenticity from anon, authenticated;
grant select on public.listing_authenticity to anon, authenticated;
