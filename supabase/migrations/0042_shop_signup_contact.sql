-- 0042: A shop that signs up with the signed PDF also gives its phone and the store address where we pick up
-- the cards it sells (decisions, 2026-10-20). Run once in Supabase ▸ SQL Editor after 0041 (safe to re-run).
-- 0031's sign-up trigger saved that data only for account_type 'seller'; now also for 'shop', so it is
-- saved even when the e-mail must be confirmed first (no session yet). holo.html works before and after it:
-- until it runs, the page saves the data itself on the first session.

create or replace function public.seller_account_from_meta(p_user uuid, p_meta jsonb) returns boolean
  language plpgsql security definer set search_path = public as $$
declare
  ph text := public.pa_phone(p_meta->>'seller_phone');
  addr text := public.clean_pickup_address(p_meta->>'pickup_address');
begin
  if coalesce(p_meta->>'account_type', '') not in ('seller', 'shop') or ph is null or char_length(addr) not between 10 and 240 then
    return false;
  end if;
  insert into public.seller_accounts (user_id, phone, pickup_address) values (p_user, ph, addr)
  on conflict (user_id) do nothing;
  return true;
end $$;

revoke all on function public.seller_account_from_meta(uuid, jsonb) from public, anon, authenticated;
