-- Admin uploads to avatar-media bucket under defaults/ prefix. The
-- /admin/default-avatars editor uploads preview + look images via
-- supabase.storage.from('avatar-media').upload('defaults/…') and the
-- existing avatar_media_auth_insert policy only allows paths that
-- start with the user's auth.uid() or a profile_id they own. These
-- three policies let admins write/update/delete under defaults/ so
-- the bucket stays usable for both users (their own paths) and
-- admins (the shared defaults/ folder).

create policy avatar_media_admin_defaults_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatar-media'
    and split_part(name, '/', 1) = 'defaults'
    and exists (
      select 1 from public.user_profiles up
      where up.id = auth.uid() and up.is_admin = true
    )
  );

create policy avatar_media_admin_defaults_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatar-media'
    and split_part(name, '/', 1) = 'defaults'
    and exists (
      select 1 from public.user_profiles up
      where up.id = auth.uid() and up.is_admin = true
    )
  )
  with check (
    bucket_id = 'avatar-media'
    and split_part(name, '/', 1) = 'defaults'
    and exists (
      select 1 from public.user_profiles up
      where up.id = auth.uid() and up.is_admin = true
    )
  );

create policy avatar_media_admin_defaults_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatar-media'
    and split_part(name, '/', 1) = 'defaults'
    and exists (
      select 1 from public.user_profiles up
      where up.id = auth.uid() and up.is_admin = true
    )
  );
