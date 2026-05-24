-- Storage bucket Studio mirrors its generated assets into.
--
-- Kie.ai and HeyGen both return URLs on their own CDNs that eventually
-- expire (HeyGen's CDN signs URLs that 404 after ~24h). We mirror the
-- bytes into Supabase storage so the rendered video + every preview
-- thumbnail stays accessible for the life of the user's project.
--
-- Public bucket — generated videos and thumbnails are served directly
-- to <video> and <img> tags without signed URLs. The studio_videos /
-- studio_segments RLS already restricts who can DISCOVER these URLs
-- through the API; the bucket itself just doesn't need additional
-- access control on read.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'studio-media',
  'studio-media',
  true,
  524288000,  -- 500 MB per file (final long-form renders push the upper bound)
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'video/mp4',
    'video/webm',
    'audio/mpeg'
  ]
)
on conflict (id) do nothing;
