-- Let sellers delete their own listing photos from Storage.
-- Run once in Supabase ▸ SQL Editor (safe to re-run).
--
-- storage.remove() needs SELECT *and* DELETE on storage.objects. 0001 only
-- granted INSERT and DELETE, so remove() returned success while deleting
-- nothing: photos of deleted listings (and of failed publishes) stayed in the
-- bucket forever. Public URLs are unaffected: the bucket is public.

drop policy if exists "users read own photos" on storage.objects;
create policy "users read own photos" on storage.objects for select to authenticated
  using (bucket_id = 'listing-photos' and (storage.foldername(name))[1] = auth.uid()::text);
