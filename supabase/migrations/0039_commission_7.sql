-- 0039: The seller's commission goes from 5% to 7% of the price, for every seller (shops and individuals),
-- plus 7% ITBMS on the commission as before (decisions, 2026-10-20). Run once in Supabase ▸ SQL Editor
-- (safe to re-run). protected_quote() and order_quote() (0029) read commission_bps, so new orders use it
-- right away; orders already created keep the amounts they were created with.
-- Mirrors DEFAULT_FEES.rateBps in src/lib/fees.ts.

update public.holo_settings
   set value = 700, updated_at = now(),
       description = 'Comisión de MarketZlab sobre el precio, en puntos básicos (700 = 7%), la paga el vendedor'
 where key = 'commission_bps';
