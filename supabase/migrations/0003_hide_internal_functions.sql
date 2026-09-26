-- 0003: internal helpers are only meant for triggers and RLS, not the public API.
-- (is_admin_context() returns true for anonymous callers because auth.uid() is
-- NULL; harmless since RLS blocks anon writes, but it should not be callable.)
-- Trigger functions are SECURITY DEFINER, so they keep calling these helpers.
revoke execute on function public.is_admin_context() from public, anon, authenticated;
