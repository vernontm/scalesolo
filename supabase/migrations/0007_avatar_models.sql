-- ============================================================================
-- M6.5: HeyGen avatar model metadata
-- Adds the V3/V4/V5 model picker, talking-photo support, and cost-per-second
-- accounting on render rows.
-- ============================================================================

alter table public.avatars
  add column if not exists model_version    text default 'v4'
    check (model_version in ('v3','v4','v5')),
  add column if not exists talking_photo_id text,                 -- HeyGen talking_photo_id (for instant avatars)
  add column if not exists photo_url        text,                 -- the source image we uploaded
  add column if not exists thumbnail_url    text,                 -- HeyGen-provided preview thumbnail
  add column if not exists training_status  text default 'ready'
    check (training_status in ('uploading','training','ready','failed')),
  add column if not exists training_error   text;

-- Track which model was used per render (for cost/audit)
alter table public.avatar_renders
  add column if not exists model_version       text,
  add column if not exists video_units_charged numeric default 0,
  add column if not exists heygen_video_id     text,
  add column if not exists voice_id            text;

-- Allow looks without a heygen_look_id (user-uploaded photos that aren't HeyGen looks)
alter table public.avatar_looks
  add column if not exists kind text default 'heygen' check (kind in ('heygen','upload'));
