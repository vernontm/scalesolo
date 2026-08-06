-- Brand Intake hardening (adversarial-review follow-up to migration 0066,
-- which is ALREADY APPLIED to the live scalesolo project).
--
-- WHY: 0066 put the per-brand intake secret on the profiles row as
-- profiles.intake_token. That row is readable by EVERY collaborator role:
-- the baseline profiles_select RLS policy (0000_baseline.sql) grants
-- SELECT on the whole row to any authenticated user with viewer+ access
-- via anon-key PostgREST, and GET /api/profiles selects profiles(*). A
-- viewer-level collaborator could therefore lift the token, open the
-- public /intake/<token> page, and forge submissions the operator would
-- treat as the client's own answers. The token is a bearer secret, so it
-- moves into its own service-role-only table and the profiles column is
-- dropped.
--
-- DEPLOY SEQUENCING (important, the feature is live):
--   1. Apply this migration.
--   2. Deploy the code that reads/writes brand_intake_tokens promptly
--      (api/intake.js, api/intake/token.js).
-- Between the two steps the OLD deployed code still queries the dropped
-- profiles.intake_token column, so the intake feature errors temporarily:
-- the operator's "Get intake link" button fails and already-sent client
-- links show "link not valid" until step 2 finishes. No data is lost:
-- existing tokens are copied into brand_intake_tokens below, so every
-- previously sent client link works again as soon as the new code is
-- live, with nothing to re-send. Keep the gap between the two steps short.

-- 1. Service-role-only token table. One row per brand; rotating a link
--    upserts a fresh uuid over the old one.
CREATE TABLE IF NOT EXISTS public.brand_intake_tokens (
  profile_id  UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  token       UUID NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.brand_intake_tokens IS
  'Per-brand bearer secret for the public Brand Intake link (/intake/<token>). Service-role-only: RLS is enabled with NO policies on purpose, so neither anon nor authenticated clients can ever read a token via PostgREST. Written by api/intake/token.js (owner/admin only, upsert = rotate) and read by api/intake.js (public endpoint, service role, token checked in code).';

-- RLS enabled with deliberately NO policies. This deviates from the
-- sibling convention for profile-scoped tables (RLS plus
-- has_profile_access() policies, see 0000_baseline.sql): those policies
-- exist to give collaborators client-side reads, which is exactly what a
-- bearer secret must never have. Any client-readable policy here, even
-- owner-scoped, would re-open a PostgREST read path for the token; the
-- only legitimate readers are the service-role endpoints, and the service
-- role bypasses RLS.
ALTER TABLE public.brand_intake_tokens ENABLE ROW LEVEL SECURITY;

-- 2. Preserve existing tokens. The operator may have already generated
--    and sent intake links (e.g. the Emanthewheelman brand); those links
--    must keep working after the column moves.
INSERT INTO public.brand_intake_tokens (profile_id, token)
SELECT id, intake_token
FROM public.profiles
WHERE intake_token IS NOT NULL
ON CONFLICT DO NOTHING;

-- 3. Drop the leaking column. This closes the direct PostgREST read path
--    (profiles_select lets any viewer+ collaborator read the full row) and
--    the GET /api/profiles path (which selects profiles(*)) in one move.
ALTER TABLE public.profiles DROP COLUMN IF EXISTS intake_token;

-- 4. Enforce the status enum 0066 documented (pending / reviewed /
--    archived) but shipped without a CHECK. 0066 is already applied, so
--    this lands as an ALTER; the DROP first keeps a re-run idempotent.
--    Mirrors the 0060_campaigns.sql precedent for text status columns.
ALTER TABLE public.brand_intake_submissions
  DROP CONSTRAINT IF EXISTS brand_intake_submissions_status_check;
ALTER TABLE public.brand_intake_submissions
  ADD CONSTRAINT brand_intake_submissions_status_check
  CHECK (status IN ('pending', 'reviewed', 'archived'));
