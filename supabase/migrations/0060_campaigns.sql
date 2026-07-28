-- Marketing Campaign framework. A campaign is a per-client run that
-- generates a length-bounded batch of posts (7/30/N days, K posts/day)
-- from the brand bible + specials + standout selling points + auto
-- holidays + a mix of content types. The generated posts are ordinary
-- content_scripts rows (so they flow through the existing approval
-- swipe queue → schedule → Upload-Post), tagged back to their campaign.
--
-- Phase 1 (this migration) creates the data model only. Media
-- generation (images/carousels/videos) lands in later phases and reads
-- content_scripts.media_brief written here at plan time.

CREATE TABLE IF NOT EXISTS campaigns (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name           TEXT NOT NULL DEFAULT 'Untitled campaign',
  -- draft     — created, not yet generated
  -- planning  — plan generation in progress (chunked)
  -- ready     — posts generated, awaiting approval
  -- scheduled — some/all posts approved + scheduled
  -- complete  — campaign window has passed
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'planning', 'ready', 'scheduled', 'complete')),
  duration_days  INTEGER NOT NULL DEFAULT 7 CHECK (duration_days BETWEEN 1 AND 90),
  posts_per_day  INTEGER NOT NULL DEFAULT 1 CHECK (posts_per_day BETWEEN 1 AND 10),
  start_date     DATE,
  timezone       TEXT NOT NULL DEFAULT 'America/Chicago',
  region         TEXT NOT NULL DEFAULT 'US',
  goal           TEXT,
  -- Recurring or dated specials the campaign should build promo posts
  -- around. Shape: [{ title, cadence: 'weekly'|'once', days: ['wed'],
  -- date: '2026-08-14', discount_pct: 15, note }]. days uses lowercase
  -- 3-letter weekday codes; date is an ISO day for one-off specials.
  specials       JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Standout selling points the model should weave in. Plain strings,
  -- e.g. ["$15 hookah","great wifi for coworking","indoor/outdoor","quiet"].
  standouts      JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Relative desired mix of content types. Non-negative weights; the
  -- planner normalizes. Keys: carousel,image,video,promo,mood,text.
  content_mix    JSONB NOT NULL DEFAULT '{"carousel":1,"image":2,"video":1,"promo":1,"mood":1,"text":1}'::jsonb,
  -- Holidays/observances chosen for this campaign window (auto-computed
  -- then user-toggled). Shape: [{ date, name, kind }].
  holidays       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaigns_profile_idx
  ON campaigns (profile_id, created_at DESC);

COMMENT ON TABLE campaigns IS
  'Per-client marketing campaigns: a length-bounded batch of generated posts built from brand bible + specials + standouts + auto holidays + a content-type mix. Generated posts are content_scripts rows tagged via content_scripts.campaign_id.';

-- Tag content_scripts back to their originating campaign, and carry the
-- per-post media generation brief written at plan time.
ALTER TABLE content_scripts
  ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  -- { content_type: 'carousel'|'image'|'video'|'promo'|'mood'|'text',
  --   prompt, reference_asset_ids: [uuid], exact_lock: bool,
  --   slides: int, holiday: string|null, special: string|null }
  ADD COLUMN IF NOT EXISTS media_brief JSONB;

CREATE INDEX IF NOT EXISTS content_scripts_campaign_idx
  ON content_scripts (campaign_id) WHERE campaign_id IS NOT NULL;

COMMENT ON COLUMN content_scripts.campaign_id IS
  'Originating campaign (campaigns.id). NULL for one-off / month-generator posts.';
COMMENT ON COLUMN content_scripts.media_brief IS
  'Per-post media generation brief written at campaign plan time and consumed by later media-generation phases. Includes content_type, generation prompt, reference_asset_ids (brand_assets to lock as exact references), slide count for carousels, and holiday/special tags.';

-- The client's REAL photos and videos — the fidelity source of truth.
-- Distinct from brand_visual_references (which holds style-only
-- screenshots/exemplars). Anything showing the actual product is
-- generated FROM these as locked references so the product never drifts.
CREATE TABLE IF NOT EXISTS brand_assets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  media_type    TEXT NOT NULL DEFAULT 'image' CHECK (media_type IN ('image', 'video')),
  category      TEXT NOT NULL DEFAULT 'other'
                CHECK (category IN ('food', 'product', 'interior', 'exterior', 'lifestyle', 'other')),
  storage_path  TEXT NOT NULL,
  public_url    TEXT NOT NULL,
  -- Short human label the planner references, e.g. "cheeseburger hero".
  label         TEXT,
  -- Claude vision read of the asset: { description, subject,
  -- key_details: [], dominant_colors: [], do_not_alter: [] }. NULL until
  -- the analysis pass runs (images only in Phase 1).
  vision_json   JSONB,
  -- When true, generation must treat this asset as an exact reference
  -- (no restyling of the product/food itself). Default on.
  lock_exact    BOOLEAN NOT NULL DEFAULT true,
  width_px      INTEGER,
  height_px     INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brand_assets_profile_idx
  ON brand_assets (profile_id, category, created_at DESC);

COMMENT ON TABLE brand_assets IS
  'The client''s real product/food/venue photos and videos — the fidelity source of truth for campaign media generation. AI never re-invents the product; it conditions on these as locked references (Kie image-to-image + OBJECT exact-lock). Vision-analyzed on upload so the planner can reference assets by id.';
