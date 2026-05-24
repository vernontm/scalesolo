-- Orientation tagging for avatar looks.
-- Users train separate looks for portrait vs landscape framing on the
-- same underlying avatar identity. Tagging the look explicitly lets
-- Studio show a clear picker + warn when a chosen look doesn't match
-- the video's aspect ratio (e.g. picking a portrait look for a 16:9
-- video will produce HeyGen's white pillarbox).
--
-- Nullable; existing rows stay null until the user tags them. Studio
-- shows "Unspecified" + the matching warning for null looks.

alter table public.avatar_looks
  add column if not exists orientation text
    check (orientation is null or orientation in ('portrait','landscape','square'));

-- Studio_videos: track which look_id the user chose so generate-assets
-- can pass the correct heygen_look_id (overrides avatar.talking_photo_id).
alter table public.studio_videos
  add column if not exists look_id uuid references public.avatar_looks(id) on delete set null;

create index if not exists studio_videos_look_idx on public.studio_videos (look_id);
