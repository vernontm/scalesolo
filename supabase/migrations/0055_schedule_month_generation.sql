-- Monthly content generation + per-platform tags + brand visual refs.
--
-- Adds three pieces of state:
--
--   1. profiles.monthly_content_goal  — free-text goal that pre-fills
--      the "Generate Content for the Month" modal each month. The
--      modal lets the user edit before generating; saving the modal
--      updates this column so next month is pre-filled.
--
--   2. profiles.social_platform_tags  — jsonb map of platform → tag.
--      Used when publishing via upload-post so e.g. Threads posts
--      always carry the brand's hashtag/handle tag without the user
--      having to type it. Shape: {"threads":"VTM","instagram":"vtm"}.
--
--   3. brand_visual_references         — table of reference images the
--      brand wants Claude/image-gen to condition on when creating
--      posts. kind tags what they're for (threads / carousel /
--      graphic), notes is a freeform description ("we love this
--      headline treatment", etc). The brand-context loader pulls
--      these so prompts can cite them.

BEGIN;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS monthly_content_goal TEXT,
  ADD COLUMN IF NOT EXISTS social_platform_tags JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN profiles.monthly_content_goal IS
  'Free-text goal for the brand''s monthly content (e.g., "Drive Threads followers to VTM Community via the BTM tutorial drops"). Pre-fills the Generate-Content-for-the-Month modal.';
COMMENT ON COLUMN profiles.social_platform_tags IS
  'Per-platform tag map injected into upload-post payloads. Keys: threads, instagram, twitter, facebook, tiktok, youtube. Values are the literal tag strings the brand wants attached. Example: {"threads":"VTM"}.';

CREATE TABLE IF NOT EXISTS brand_visual_references (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- Bucket: which surface this reference is meant to guide. Keeps the
  -- brand context loader from mixing carousel-design refs into a
  -- single-image Threads prompt.
  kind            TEXT NOT NULL CHECK (kind IN ('threads', 'carousel', 'graphic', 'thumbnail', 'other')),
  storage_path    TEXT NOT NULL,
  public_url      TEXT NOT NULL,
  notes           TEXT,
  -- Optional OCR / vision-captioned text so Claude can read what the
  -- reference says without re-running vision on every prompt. Filled
  -- in by a background job (or manually) — leave NULL on insert and
  -- the loader falls back to notes.
  caption         TEXT,
  width_px        INTEGER,
  height_px       INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brand_visual_references_profile_kind_idx
  ON brand_visual_references (profile_id, kind, created_at DESC);

COMMENT ON TABLE brand_visual_references IS
  'Visual references for brand training: Threads post screenshots, carousel slide examples, branded graphics. Fed into Claude prompts via brand-context loader so generated content matches the brand''s visual + copy patterns.';

-- Storage bucket for brand reference uploads. Public-read so Claude
-- (and the UI) can fetch images by URL; writes still go through
-- signed-upload URLs gated by the API.
INSERT INTO storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
VALUES ('brand-references', 'brand-references', true,
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
        20971520)  -- 20 MB cap; references are screenshots, not raw assets
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    allowed_mime_types = EXCLUDED.allowed_mime_types,
    file_size_limit = EXCLUDED.file_size_limit;

COMMIT;
