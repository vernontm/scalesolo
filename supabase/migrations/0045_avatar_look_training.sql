-- Training status for avatar_looks rows.
--
-- A look is "trained" when its cover image has been sent to HeyGen
-- and we have a heygen_look_id back. Without this, the studio render
-- path can't use the look — it would silently fall back to the
-- avatar's default talking_photo_id and produce orientation mismatches.
--
-- The UI's Train button POSTs to /api/avatars/looks/train which flips
-- training_status as it works:
--   'pending'  — created locally, never sent to HeyGen
--   'training' — request in flight (rare; HeyGen V3 photo avatars are
--                effectively synchronous, but the row sits in this state
--                briefly while the API call is mid-flight)
--   'ready'    — heygen_look_id populated, look is render-ready
--   'failed'   — HeyGen rejected the image; see training_error

alter table public.avatar_looks
  add column if not exists training_status text not null default 'pending'
    check (training_status in ('pending', 'training', 'ready', 'failed'));

alter table public.avatar_looks
  add column if not exists training_error text;

alter table public.avatar_looks
  add column if not exists trained_at timestamptz;

-- Backfill: any look that already has a heygen_look_id is implicitly
-- ready (the admin/default-avatars endpoint creates these). Saves a
-- manual UI pass for the curated default looks.
update public.avatar_looks
  set training_status = 'ready', trained_at = coalesce(trained_at, now())
  where heygen_look_id is not null and training_status = 'pending';
