-- 0017: only the seller pays. Run once in Supabase ▸ SQL Editor after 0016 (safe to re-run).
-- holo.html works before and after it.
--
-- Rule: the buyer pays the card price and nothing else. When a sale goes through, Holo keeps 5% of
-- the price plus 7% ITBMS on that commission, taken from what the seller is paid. No minimum, no cap.
-- Replaces the 3% + 3% of 0016. The columns stay as 0016 left them: fee_cents / itbms_cents are the
-- buyer's commission (now 0 on new orders) and seller_fee_cents / seller_itbms_cents the seller's.
-- start_checkout() and new_payment_attempt() already read everything from protected_quote(), so this
-- is the only function that changes. Orders created before this keep the amounts they were made with.

-- Same numbers as quoteProtected() in holo.html and src/lib/fees.ts (half-up rounding, cents).
create or replace function public.protected_quote(p_price int) returns jsonb
  language sql immutable set search_path = public as $$
  with f as (select floor(p_price * 500 / 10000.0 + 0.5)::int as seller_fee),
       t as (select seller_fee, floor(seller_fee * 700 / 10000.0 + 0.5)::int as seller_itbms from f)
  select jsonb_build_object('price', p_price,
                            'fee', 0, 'itbms', 0, 'total', p_price,
                            'seller_fee', seller_fee, 'seller_itbms', seller_itbms,
                            'payout', p_price - seller_fee - seller_itbms)
  from t
$$;
