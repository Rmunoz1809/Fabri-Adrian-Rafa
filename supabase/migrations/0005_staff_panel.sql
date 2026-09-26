-- 0005: what the staff panel (#/admin in holo.html) needs.
-- Run once in Supabase ▸ SQL Editor after 0004 (safe to re-run).
--
-- To make someone staff (replace the email):
--   update public.profiles set is_staff = true
--   where id = (select id from auth.users where email = 'socio@ejemplo.com');

-- Staff can edit any profile (verify shops). 0001 only let users edit their own.
drop policy if exists "staff update profiles" on public.profiles;
create policy "staff update profiles" on public.profiles for update
  using (public.is_staff()) with check (public.is_staff());

-- ------------------------------------------------ shop verification requests
create table if not exists public.shop_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  shop_name text not null check (char_length(shop_name) between 2 and 80),
  contact text check (char_length(contact) <= 120),   -- Instagram or WhatsApp
  location text check (char_length(location) <= 120), -- where the store is
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create unique index if not exists shop_requests_one_pending
  on public.shop_requests (user_id) where status = 'pending';
alter table public.shop_requests enable row level security;

drop policy if exists "users request verification" on public.shop_requests;
create policy "users request verification" on public.shop_requests for insert
  with check (user_id = auth.uid() and status = 'pending' and reviewed_at is null);
drop policy if exists "users see own requests" on public.shop_requests;
create policy "users see own requests" on public.shop_requests for select
  using (user_id = auth.uid() or public.is_staff());
drop policy if exists "staff review requests" on public.shop_requests;
create policy "staff review requests" on public.shop_requests for update
  using (public.is_staff()) with check (public.is_staff());

-- ------------------------------------------------ protected orders
-- Buyers usually arrive by WhatsApp without an account: keep how to reach them.
alter table public.protected_orders
  add column if not exists buyer_contact text check (char_length(buyer_contact) <= 120);

create or replace function public.touch_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists protected_orders_touch on public.protected_orders;
create trigger protected_orders_touch before update on public.protected_orders
  for each row execute function public.touch_updated_at();

-- One sale row per listing, so releasing an order twice can't double-count prices.
create unique index if not exists sales_one_per_listing
  on public.sales (listing_id) where listing_id is not null;
