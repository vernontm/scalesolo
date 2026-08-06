-- Hosted per-brand "Brand Intake" questionnaire.
--
-- A client opens a private link (no login), answers 13 questions by voice
-- or typing, and their answers land in a staging table for the operator to
-- review BEFORE anything touches the live brand profile. Nothing here ever
-- auto-writes to profiles; the human reviews a submission and saves the
-- brand editor normally.
--
-- Two pieces:
--   1. profiles.intake_token, a per-brand secret the operator generates
--      on demand. The public link is /intake/<intake_token>. Nullable and
--      unique so it can be rotated (a new uuid) or cleared. NOT backfilled;
--      a brand has no token until the operator asks for one.
--   2. brand_intake_submissions, one row per completed questionnaire,
--      status 'pending' until the operator reviews it.

-- 1. Per-brand intake token. Nullable + unique. Postgres allows many NULLs
--    under a UNIQUE constraint, so leaving most brands with no token is fine
--    and needs no backfill.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS intake_token UUID UNIQUE;

COMMENT ON COLUMN profiles.intake_token IS
  'Per-brand secret for the public Brand Intake link (/intake/<intake_token>). Operator-generated on demand, rotatable, nullable. NULL = no active intake link for this brand.';

-- 2. Staging table for questionnaire responses.
CREATE TABLE IF NOT EXISTS brand_intake_submissions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- Full structured answer state from the questionnaire:
  -- { answers: {question_id: text}, chips: {question_id: [..]},
  --   rank: {question_id: [..]}, meta: {..} }.
  answers     JSONB NOT NULL,
  -- Pre-compiled human-readable markdown summary of the answers, shown to
  -- the operator in the review list.
  summary_md  TEXT,
  -- pending  (submitted, awaiting operator review)
  -- reviewed (operator has looked at it or prefilled the editor)
  -- archived (dismissed)
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brand_intake_submissions_profile_idx
  ON brand_intake_submissions (profile_id, created_at DESC);

COMMENT ON TABLE brand_intake_submissions IS
  'Staging table for hosted Brand Intake questionnaire responses. One row per completed questionnaire, default status pending. Reviewed by the operator before any brand profile edit; never auto-applied to profiles.';

-- Row Level Security.
--
-- Enabled so no anon / authenticated client can read another brand's
-- responses directly. The public intake endpoint (api/intake.js) uses the
-- Supabase SERVICE ROLE and enforces the intake_token check in code, and the
-- service role bypasses RLS, so submissions still insert and the operator
-- endpoints (api/intake/submissions.js) still read via the service role
-- after an assertProfileAccess() ownership check.
--
-- Note on project convention: as of this migration NO existing table in
-- supabase/migrations/ ships CREATE POLICY statements. The whole app reaches
-- Postgres through the service role in api/_lib/supabase.js and enforces
-- ownership in application code (assertProfileAccess). We keep RLS ENABLED
-- here (deny-by-default for anon/authenticated) and deliberately add no
-- public/anon policy. If the project later adopts client-side RLS, add an
-- operator-read policy mirroring the profile_access ownership check, e.g.:
--
--   CREATE POLICY brand_intake_owner_read ON brand_intake_submissions
--     FOR SELECT TO authenticated
--     USING (EXISTS (
--       SELECT 1 FROM profile_access pa
--       WHERE pa.profile_id = brand_intake_submissions.profile_id
--         AND pa.user_id = auth.uid()
--     ));
ALTER TABLE brand_intake_submissions ENABLE ROW LEVEL SECURITY;
