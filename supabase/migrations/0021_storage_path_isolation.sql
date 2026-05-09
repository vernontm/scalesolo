-- Storage INSERT path isolation. Pre-existing INSERT policies allowed
-- any authenticated user to upload to any path inside the landing-media
-- and avatar-media buckets. Tighten so the first path segment must be:
--   * a profile UUID the user has access to via profile_access, OR
--   * the user's own auth.uid (used by server-mediated previews etc), OR
--   * a small whitelist of shared prefixes server endpoints use.
--
-- The UUID cast is regex-guarded — naked ::uuid throws on non-UUID
-- segments and would break the policy for legitimate uploads under
-- 'previews/...' and 'shared/...'.
--
-- Doesn't touch existing rows; only future INSERTs are gated.

drop policy if exists landing_media_auth_insert on storage.objects;
create policy landing_media_auth_insert on storage.objects
  for insert
  with check (
    bucket_id = 'landing-media'
    and auth.uid() is not null
    and (
      split_part(name, '/', 1) in ('previews', 'shared')
      or split_part(name, '/', 1) = auth.uid()::text
      or (
        split_part(name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and split_part(name, '/', 1)::uuid in (
          select profile_id from public.profile_access where user_id = auth.uid()
        )
      )
    )
  );

drop policy if exists avatar_media_auth_insert on storage.objects;
create policy avatar_media_auth_insert on storage.objects
  for insert
  with check (
    bucket_id = 'avatar-media'
    and auth.uid() is not null
    and (
      split_part(name, '/', 1) = auth.uid()::text
      or (
        split_part(name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and split_part(name, '/', 1)::uuid in (
          select profile_id from public.profile_access where user_id = auth.uid()
        )
      )
    )
  );
