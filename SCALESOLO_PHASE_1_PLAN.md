# ScaleSolo Phase 1 Build Plan

**Companion to:** `SCALESOLO_AUDIT.md`.
**Format:** ordered milestones with concrete acceptance criteria. No calendar weeks. Ray says "continue" between milestones once each one ships.
**Working assumption:** Ray is the engineer. Claude Code is the partner. ~20-30 hours per work session, but milestones are sized by *deliverable*, not by hours.

Each milestone has:
- **Goal** — one sentence.
- **Deliverables** — concrete artifacts.
- **Done when** — observable acceptance criteria.
- **Files touched** — pointers so we can resume after a break.
- **Risks for this milestone** — pulled from the audit risk register.

---

## Milestone 0 — Stand up ScaleSolo as its own app

**Goal:** ScaleSolo exists as a fully independent app — own folder, own git repo, own Supabase project, own Vercel project, own env vars. VTM code is **reference only**, copied selectively, with zero runtime dependencies on VTM.

**Architectural rule for the whole project:** ScaleSolo never imports from VTM, never queries VTM's database, never calls VTM's API endpoints, never shares env vars or auth tokens. If we want a VTM pattern, we copy and adapt it into ScaleSolo. Past this milestone, VTM doesn't exist as far as ScaleSolo is concerned.

**Deliverables:**
1. New folder `/Users/raysmacbook/Desktop/Vernon Tech And Media/Client Projects/scalesolo/` (sibling to `VTM/`).
2. New git repo (separate from VTM), initial commit on `main`.
3. Project skeleton inside `scalesolo/`:
   - `client/` — React + Vite SPA, fresh `package.json` (matched to VTM deps for compatibility but a clean install)
   - `api/` — Vercel serverless functions root
   - `api/_lib/` — shared modules (clean copies of the helpers we want: a fresh `supabase.js`, a fresh `mailerlite.js`, etc.)
   - `public/` — marketing site HTML
   - `supabase/migrations/` — fresh migration directory
   - `vercel.json` — fresh routing/cron/timeout config
   - `build.sh` — fresh build script
   - `.env.example` — every env var ScaleSolo needs (from audit §7)
   - `README.md` — pointing at the two SCALESOLO_*.md docs (which themselves can be copied into the new repo)
4. Selective code copy from VTM as a **starting reference** (not a dependency):
   - SPA bones: `App.jsx`, router, the contexts we want (`AuthContext`, `ClientContext` → renamed `ProfileContext`, `RefreshContext`, `UiContext`)
   - Components we want to start from: `GlobalAgent.jsx`, `RenderComposer.jsx`, `Sidebar.jsx`, `Header.jsx`, `Modal.jsx`, `Toast.jsx`, `ErrorBoundary.jsx`, `BulkImport.jsx`
   - Pages we want to start from: `Dashboard.jsx`, `Avatars.jsx`, `Settings.jsx`, `AdminUsers.jsx`, `EmailMarketing.jsx`, `ContentScheduler.jsx`, `Login.jsx`, `Notifications.jsx`
   - API endpoints we want to start from: the brand-bible / avatars / content / email / agents / scheduling / publishing groups (see audit §3 — anything tagged "Port" or "Port+")
   - Helpers: a clean copy of `_lib/supabase.js`, `_lib/mailerlite.js`, `_lib/email-html.js`, `_lib/agent-attachments.js`
   - **Excluded** (do not copy): all Academy code, Gmail integration, Vernon-agency CRM (Leads/Deals/Contacts/Accounts/Projects/Meetings/QuickNotes/Subscriptions/Invoices), Blog, Portfolio, Resources, Training, recordings, the Resend leftovers
5. Brand new Supabase project provisioned for ScaleSolo. Empty database. Project ID + URL + keys recorded in `scalesolo/.env.example`.
6. `scalesolo/supabase/migrations/0000_baseline.sql` written from scratch — defines `profiles`, `profile_access`, `avatars`, `avatar_outfits`, `avatar_looks`, `avatar_renders`, `content_scripts`, `auto_schedule_config`, `email_config` (no `resend_api_key NOT NULL`), `email_contacts`, `email_campaigns`, `email_templates`, `email_tag_context`, `mailerlite_groups`, `analytics_snapshots`. Strict RLS via `profile_access` join from line one. Indexes included. No data copied — fresh empty tables.
7. New Vercel project linked to the new folder + new repo. Staging URL configured (e.g. `scalesolo-staging.vercel.app`). Env vars set from `.env.example` values.
8. Stripe account (or Stripe project) for ScaleSolo — separate from any VTM Stripe products. New products + prices created for the 3 tiers + founding-100 (used in M1).

**Done when:**
- The VTM folder is **untouched** by this milestone (other than the two `SCALESOLO_*.md` docs that already exist there). `git status` in VTM clean.
- The new ScaleSolo repo exists, has its initial commit, and can be cloned independently.
- Hitting the new Vercel staging URL returns a working SPA bound to the new Supabase project.
- Sign up on the new app → `auth.users` row appears in the **new** Supabase, **not** VTM's. Zero cross-contamination.
- `grep -r "vernontm\|VTM\|crm_content_clients\|vtm.crm" scalesolo/` returns zero hits (everything renamed during the copy).
- The audit + plan docs are copied into the new repo so context lives with the project.

**Files touched:** all inside `scalesolo/`. Zero edits inside `VTM/`.

**Risks:** scope creep on what to copy. Rule: when in doubt, don't copy — re-author from scratch in the relevant later milestone. A clean baseline is faster than a tangled one.

**Open question for Ray:** confirming the new folder lives at `/Users/raysmacbook/Desktop/Vernon Tech And Media/Client Projects/scalesolo/` (sibling to `VTM/`). If you want it elsewhere — say so before M0 starts.

---

## Milestone 1 — Brand polish + native billing live

**Goal:** ScaleSolo looks like ScaleSolo end-to-end, and a real user can sign up + pay through Stripe + land in a working workspace.

(Note: the `client → profile` rename and the dropping of `resend_api_key NOT NULL` already happened during M0's selective copy + fresh baseline. Nothing carried over from VTM that still uses the old names or constraints.)

**Deliverables:**
1. Brand polish across the copied codebase:
   - Final logo + favicon (or placeholder mark if not yet designed)
   - Tailwind color tokens locked in for ScaleSolo's palette
   - Marketing site copy rewritten (no remaining VTM language)
   - Sidebar / Header polish for the locked-in navigation
2. ScaleSolo platform billing live:
   - Tables: `billing_customers`, `billing_subscriptions` (migration `0001_billing.sql`)
   - Endpoints: `POST /api/stripe-checkout`, `POST /api/stripe-portal`, `POST /api/stripe-webhook` — written fresh (referencing the academy/stripe-webhook.js shape from VTM as inspiration only)
   - Stripe products + prices already exist in the new ScaleSolo Stripe account (created in M0); webhook handler wired to them
   - Public pricing page (`scalesolo/public/pricing.html`) with 3 tier cards + founding-100 CTA → checkout
   - Sign-up tier preselect: `?tier=solo_pro` query param → form persists → linked to created sub
   - 14-day free trial on all tiers (`trial_period_days: 14` on Checkout)
   - Stripe webhook idempotency: every event written to a `stripe_events` table keyed on `stripe_event_id` before any state change (re-deliveries are no-ops)
3. Confirm v1 sidebar shows only what's planned for ship: Dashboard, Content, Email, Contacts, Pipeline (placeholder), Forms (placeholder), Landing Pages (placeholder), Avatars, Analytics, AI CEO, Settings, Profiles. Anything else copied over from VTM stays on disk but is unrouted.

**Done when:**
- Open the staging URL, see ScaleSolo branding end-to-end.
- New user signs up at `scalesolo-staging.vercel.app/pricing?tier=solo_pro`, completes Stripe Checkout, lands in onboarding, `billing_subscriptions` row exists with `tier='solo_pro'`, `status='trialing'`, `trial_end` 14 days out.
- Brand profile switching, "View as" admin impersonation, and admin user grants all work in the new project (independently of VTM).
- Re-delivering a Stripe webhook event in test mode results in no duplicate state changes.

**Files touched:** brand asset files, marketing pages, ~5 new endpoints, 1 new migration.

**Risks:** R3 (Resend NN — already gone from baseline), R11 (Stripe webhook idempotency — built in from day 1).

---

## Milestone 2 — Credit system

**Goal:** Every AI call is metered. Users can see balances, top up, and run out gracefully.

**Deliverables:**
1. DB: migration `0004_credits.sql` (tables `credit_pools`, `credit_transactions`).
2. Lib: `scalesolo/api/_lib/credits.js` with `checkAndConsume({profileId, poolType, amount, action, refTable, refId, metadata})` and `grant({profileId, poolType, amount, action})`. Uses `SELECT FOR UPDATE` for atomic decrement.
3. Wrap every AI endpoint with the middleware:
   - `bulk-upload`, `bulk-agent`, `content-ai`, `email-template-ai`, `email-edit-ai`, `personalize-script`, `process-brand-bible`, `agent/chat` (when built) → debit `ai_tokens` (token count from Anthropic response usage)
   - `avatar-renders`, `carousel-generator` → debit `video_units` (per-clip flat cost)
4. Endpoints:
   - `GET /api/credits` — current balances
   - `GET /api/credits/transactions` — paginated audit log
   - `POST /api/credits/topup` — creates Stripe one-off Checkout (top-up packs defined in code)
   - Stripe webhook extension: handle `checkout.session.completed` with `metadata.kind='credit_topup'` to grant credits idempotently
5. Monthly grant cron (`/api/cron/credit-monthly-reset`, daily at 06:00 UTC, registered in `vercel.json`). Resets pools whose `last_reset_at < date_trunc('month', now())` based on the user's tier (`profile_limit` and pool grants live in a code constant, not DB, for now).
6. Frontend:
   - Credit balance widget in `Dashboard.jsx` and `Header.jsx` (always visible, like the spec mockup)
   - `/billing` page shows balances, usage chart, top-up packs, recent transactions
   - "Insufficient credits" 402 error surfaces a modal: "You're out of [pool]. Top up?" with the right pack pre-selected
7. Tier → grant mapping (in code):
   - Solo Starter: 100K AI tokens, 10 video units, 0 voice min
   - Solo Pro: 500K AI tokens, 30 video units, 0 voice min
   - Solo Studio: 2M AI tokens, 100 video units, 0 voice min
   - Founding: same as Pro

**Done when:**
- Generate a piece of content → `credit_transactions` row appears with the right `delta` and `balance_after`.
- Drain a balance to 0 → next generate call returns 402 → top-up modal opens → click pack → Stripe Checkout → webhook fires → balance restored, content generation resumes.
- New trial user has full Pro grants visible from minute 1.
- 1st of the month: cron fires, all active subs get fresh grants, transaction log shows the grants.
- Bug regression test: re-deliver the same Stripe webhook event twice → only one grant lands (idempotency works).

**Risks:** R11 (idempotency — built in from start). R10 (function timeouts — credit middleware is microsecond-fast, no impact).

---

## Milestone 3 — AI CEO upgrades (memory, persistent conversations, behavior dial)

**Goal:** The AI CEO remembers across sessions, respects pinned facts, and the user can tune how proactive it is.

**Deliverables:**
1. DB: migration `0005_agent_memory.sql` — `vector` extension, `agent_conversations`, `agent_messages`, `agent_pinned_facts`, `agent_knowledge_chunks`.
2. Embedding pipeline:
   - Job in `_lib/embeddings.js`: `embedBrandBible(profileId)` → chunks brand bible at ~500 tokens → `text-embedding-3-small` → upserts to `agent_knowledge_chunks`. Triggered after brand bible save.
   - Same pipeline available for ad-hoc text via `POST /api/agent/knowledge` (let user pin a custom note).
3. Refactored agent endpoint: `POST /api/agent/chat` (replaces `global-agent.js` for the new flow):
   - SSE streaming response
   - System prompt = brand bible summary + ALL pinned facts + top-5 retrieved chunks for the message
   - Persists user + assistant messages to `agent_messages`
   - Honors `agent_aggressiveness` setting (Quiet / Balanced / Aggressive — added as a column on `profiles` in this migration)
4. Conversation management endpoints:
   - `GET /api/agent/conversations`
   - `GET /api/agent/conversations/:id/messages`
   - `DELETE /api/agent/conversations/:id`
   - Pinned facts: `GET /POST /DELETE /api/agent/pinned-facts`
5. Frontend `GlobalAgent.jsx` upgrades:
   - Conversation history sidebar (collapsible)
   - "+ New chat" button
   - Pin button on any assistant message → adds to pinned facts (with confirm)
   - Settings tab in agent panel: behavior dial (Quiet/Balanced/Aggressive)
   - Streaming token-by-token render (replace the current waterfall)
6. Daily briefing card on Dashboard (already a spec feature) now reads from agent memory: "Yesterday I drafted 3 emails. The carousel about [pinned: brand pillar X] performed best."

**Done when:**
- Save a brand bible → 30 seconds later, embeddings exist for it (`select count(*) from agent_knowledge_chunks where profile_id = ?`).
- Open AI CEO → ask a question → response cites brand details (you can verify by toggling pinned facts off and seeing the difference).
- Reload the page → conversation history is preserved.
- Pin a fact → start a new conversation → ask a related question → fact is referenced.
- Toggle behavior dial → notice difference in proactive suggestions on the dashboard.

**Risks:** R9 (no persistent agent today — solved here). pgvector index tuning may need iteration past 10K chunks (irrelevant at v1 scale).

---

## Milestone 4 — Native email sending (Postmark) + deliverability

**Goal:** ScaleSolo owns email delivery for transactional + early marketing volume. MailerLite stays available for users who want it but is no longer required.

**Deliverables:**
1. DB: migration `0006_postmark.sql` — `email_domains`, `email_suppressions`, add `email_provider text default 'postmark'` on the email config table.
2. Lib: `scalesolo/api/_lib/postmark.js` — `sendBatch`, `sendOne`, `getDeliveryStatus`, server token + Message Stream config.
3. Endpoints:
   - `POST /api/email/send` — unified send (routes to Postmark by default, MailerLite if user opted in). Checks suppressions before send. Debits `ai_tokens` if generated.
   - `GET / POST /api/email/domains`, `POST /api/email/domains/:id/verify` — DNS check helper that pulls the live SPF/DKIM/DMARC records and reports status. Bake in Postmark's signature ID + DKIM record generation.
   - `POST /api/email/postmark-webhook` (signature-verified) — handles bounce, complaint, delivery, open, click events.
4. Migrate the Composer: `EmailEditor.jsx` + the campaign send path now hits `/api/email/send` instead of MailerLite directly. Existing campaigns can still re-send through MailerLite via a "legacy provider" toggle.
5. Deliverability dashboard (new sub-page in Email): bounce rate, complaint rate, open rate, click rate, suppression list view + remove, domain auth status.
6. Domain warmup helper (just guidance + a checklist UI to start; actual warmup automation is v2).

**Done when:**
- New user adds their domain → they see SPF/DKIM/DMARC records to add to DNS → after adding, "Verify" turns the status green within 60 seconds.
- Send a test email through the composer → arrives in inbox via Postmark, headers show DKIM pass.
- Trigger a bounce → suppression appears in the dashboard, future sends to that address are blocked.
- Existing MailerLite users can keep sending through MailerLite by leaving `email_provider='mailerlite'` set.

**Risks:** R8 (single-vendor lock-in — solved). New risk: SPF/DKIM/DMARC setup is the #1 user-facing friction point — make the UI patient and the error messages specific.

---

## Milestone 5 — CRM expansion: pipeline + forms + CSV import + activity timeline

**Goal:** ScaleSolo's CRM matches the spec for v1: kanban deals, drag-drop forms, CSV import, full activity timeline per contact.

**Deliverables:**
1. DB migrations `0005_pipeline.sql`, `0006_forms.sql`, `0007_imports.sql`, `0008_activity.sql`.
2. **Pipeline** (3.7):
   - `Pipeline.jsx` page with kanban via `@dnd-kit/core`
   - CRUD endpoints for `pipelines` and `deals`
   - Drag-to-move stage transition fires `PATCH /api/pipeline-deals/:id/move`
   - Deal detail modal: linked contact, value, expected close, age, notes
   - Per-pipeline metrics widget: total value, conversion %, avg deal size
3. **Forms** (3.8):
   - `Forms.jsx` builder page using `@dnd-kit/core` for section reordering
   - Field types: text, email, phone, dropdown, multi-choice, file (Supabase Storage), signature (canvas → base64), payment (Stripe Element)
   - Layout toggle: standard or conversational (Typeform-style)
   - Logic & branching: simple show/hide based on prior answers
   - Embed snippets (inline iframe + popup script)
   - Public submission page at `/f/:slug` reads the form schema
   - `POST /api/forms/submit` (public, rate-limited via simple in-memory bucket then formal middleware later) → upserts contact, applies tags, runs confirmation action
   - AI form generation: `POST /api/forms/:id/generate` body `{description}` → Claude returns a sections array
4. **CSV import** (3.6 secondary):
   - `Contacts.jsx` gets an "Import" button → modal with drag-drop CSV
   - Preview shows first 10 rows + auto-detected column mapping (name, email, phone, tags, etc.)
   - User confirms mapping → `POST /api/contacts/import` → background job processes in 5K-row batches
   - Status drawer shows progress, errors, completion
5. **Activity timeline** (3.6 core):
   - Writes added at every touchpoint:
     - `POST /api/email/send` after successful send → `event_type='email_sent'`
     - Postmark webhook open/click/bounce → corresponding events
     - Form submission → `event_type='form_submitted'` with payload
     - Pipeline deal move → `event_type='deal_moved'` with from/to stage
     - Tag add/remove → `event_type='tag_changed'`
     - Note add → `event_type='note_added'`
     - CSV import → bulk `event_type='imported'`
   - Contact detail page (new) shows reverse-chronological timeline with filters

**Done when:**
- Build a pipeline with custom stages → drag a deal between columns → activity timeline on the linked contact reflects the stage move.
- Build a form with conditional logic → submit it on the public URL → contact appears in CRM with the right tags + the submission is on the timeline.
- Import a CSV of 5K contacts → see progress drawer → all 5K appear with `imported` activity events.
- Email send + open + click all show on the contact's timeline within 60s of the events firing.

**Risks:** R10 (timeouts on huge imports — chunking handles this).

---

## Milestone 6 — Content engine polish + approval queue + ContentScheduler decomposition

**Goal:** The content engine is no longer a 3,744-line monolith, the approval workflow ships, and the dashboard's Pending Approvals widget is wired.

**Deliverables:**
1. DB: migration `0009_approvals.sql` — extend `content_scripts` with approval columns + index.
2. Decompose `ContentScheduler.jsx` into:
   - `Content/Library.jsx` — searchable library of all generated content (the existing list view)
   - `Content/Calendar.jsx` — month / week / day calendar with drag-to-reschedule
   - `Content/Drafts.jsx` — drafts in progress
   - `Content/Approvals.jsx` — items where `approval_status='pending'`
   - Shared `<ContentRow>` component
3. Approval workflow plumbing:
   - AI-generated content sets `needs_approval=true, approval_status='pending'`
   - Approve / Reject buttons in `Approvals.jsx` → updates row, fires activity timeline event, on approve schedules the post
   - Dashboard widget: count of pending approvals, click → /content/approvals
4. AI CEO behavior tie-in: when behavior dial is "Aggressive," the CEO auto-approves obvious content (e.g. captions for already-approved videos); "Quiet" requires manual approval for everything; "Balanced" is the default 50/50.
5. Content recycling: mark a high-performer as recyclable, set period (30/60/90 days) → cron re-queues it. Schema: add `recycle_period_days int` to `crm_content_scripts`.
6. Hashtag library: per-platform set per profile. Schema: add `hashtag_sets jsonb` to profiles. AI auto-applies based on content topic.

**Done when:**
- ContentScheduler.jsx no longer exists; routes hit the four new sub-pages.
- AI generates a carousel → it lands in Approvals → clicking Approve schedules and the activity timeline + calendar both update.
- A recycling-marked post auto-republishes after the configured period.
- Each sub-page is under 1,000 lines.

**Risks:** R4 (decomposition risk during heavy refactor) — strict regression checklist before merging: every existing flow tested in staging.

---

## Milestone 7 — Landing page builder

**Goal:** Users can drag-build branded landing pages on a `*.scalesolo.app` subdomain or their own custom domain.

**Deliverables:**
1. DB: migration `0010_landing.sql` — `landing_pages`, `landing_page_views`.
2. Section library in `lib/landing-sections.js` — definitions + React renderers for: hero, features, testimonials, pricing, faq, cta, about, contact, stats, logos, video, gallery, form, embed.
3. Builder page `LandingPages.jsx`:
   - Left rail: section library (click to add)
   - Center: page preview with drag-to-reorder
   - Right rail: section property editor (text, image upload, button labels, color overrides)
   - Mobile preview toggle
   - "Generate full page" button → `POST /api/landing-pages/:id/generate` body `{description}` → Claude returns full sections array
4. Public renderer at `/p/:slug` reads sections array, renders. Optimized for paint speed (no client JS unless a section needs it; the form section has its own bundle).
5. Custom domain support:
   - User adds CNAME → record stored on `landing_pages.custom_domain`
   - `vercel.json` updated to handle wildcard + custom domains via Vercel's domains API (server-side check + redirect)
   - SSL is automatic via Vercel
6. Page analytics via beacon `POST /api/landing-pages/track` (visitors, source, scroll depth, time on page).
7. Form integration: section type `form` reads from `forms` and embeds the form on the page.

**Done when:**
- Build a 5-section landing page in under 5 minutes (ergonomic test).
- Generate a full page from a description in one click.
- Publish → page is live on the staging subdomain.
- Add a custom domain → after CNAME propagates, page is live on the user's domain.
- Submit the embedded form → contact appears in CRM with `source` set to the page slug.

**Risks:** custom domain SSL automation depends on Vercel's domains API rate limits; document a manual fallback.

---

## Milestone 8 — Polish + RLS hardening + AI CEO behavior settings + beta gate

**Goal:** Lock the doors before opening to founding members. RLS becomes real. AI CEO behavior dial is fully wired. Settings page has every v1 toggle.

**Deliverables:**
1. DB: migration `0013_rls_strict.sql` — replace every permissive `auth_all_*` policy with proper `client_id`/`profile_id`-scoped policies via the `crm_user_access` join.
2. Cross-tenant audit:
   - Walk every endpoint, confirm the `profile_id` it operates on comes from validated user input or from the user's grant set, never from the request body alone.
   - Add `assertProfileAccess(req, profileId)` helper used by every endpoint.
3. Roles formalized: `owner | admin | editor | viewer`. UI gates:
   - Viewer: read-only on most pages, no AI CEO actions
   - Editor: can create/edit content, cannot manage billing or team
   - Admin: everything except transferring ownership
   - Owner: everything + delete workspace
4. Settings page completes:
   - Appearance (light/dark, accent)
   - AI CEO behavior dial (already in M3, surfaces here too)
   - Default content rules (auto-disclaimer in emails, default platform set, default hashtags)
   - Data export / data deletion
   - 2FA (Supabase Auth supports TOTP)
   - Account deletion with grace period
5. Founding member gate:
   - Counter row in DB (`founding_member_count`)
   - Founding price ID is only valid until counter < 100
   - Public "spots remaining" widget on the pricing page
6. Onboarding wow-moment final pass:
   - Streaming generation actually streams (SSE on the chosen first-content endpoint)
   - Confetti animation on save
   - "Next steps" prompt is wired to navigate the user

**Done when:**
- A QA pass with two test accounts confirms zero cross-tenant data leakage (try every endpoint with a profile you don't own — every call returns 403).
- `select * from pg_policies where schemaname='public' and qual = 'true'` returns zero rows.
- All four roles produce the correct UI behavior.
- Founding spot 100 is sold → spot 101 attempt redirects to standard pricing.
- A new user can complete onboarding (welcome → brand bible → avatar → first content) without help.

**Risks:** R2 (permissive RLS — solved here, but the audit may surface endpoints that were silently relying on `service_role`. Each must be fixed before strict policies turn on).

---

## Milestone 9 — Beta launch with founding members

**Goal:** First 50 founding members onboarded, monitored, and producing content.

**Deliverables:**
1. Status page (`status.scalesolo.app`) showing uptime + active incident banner.
2. Error monitoring: Sentry or equivalent wired into both frontend + backend.
3. Analytics: PostHog (or similar) for product analytics — funnel from signup → first content.
4. In-app feedback widget (simple form → routes to a Slack channel or shared inbox).
5. Daily ops dashboard (admin-only): new signups, trial-to-paid conversion, credit pool spend per tenant, top errors.
6. Founder waitlist email sequence (5 emails) auto-enrolling new founding members.
7. Pre-launch QA checklist run end-to-end. Document any known issues with severity, ship the rest.

**Done when:**
- 50 founding members signed up, completed onboarding, and produced at least one piece of content each.
- Daily ops dashboard shows green for 5 consecutive days.
- Top 3 reported issues are triaged into next milestone or quick-fixed.

---

## Beyond v1 (v2 candidates, do NOT build now)

For reference and to avoid accidental scope creep:

- **Calendar / bookings** (3.9 in spec) — public scheduling page, Outlook/iCloud sync, round-robin, payment-on-booking, reminder cadence.
- **Voice agents** (3.10) — Bland.ai or Vapi integration, inbound + outbound, voice-minute pool wired to credits.
- **Per-tenant Stripe Connect** (3.12) — Express onboarding, scoped Checkout/Invoice/Subscription, affiliate auto-payout.
- **Native HubSpot/GHL/Mailchimp/Thryv/Kit imports** (4.5).
- **Zapier app + public REST API** (4.5).
- **A/B testing framework for landing pages and emails**.
- **Cohort analysis + funnel analytics** (3.13 secondary).
- **CEO voice mode** (3.2 secondary) — Whisper STT + ElevenLabs TTS, WebSocket streaming.
- **Lead scoring** (3.6 secondary).
- **LinkedIn enrichment** (3.6 secondary).

---

## How we work between milestones

After each milestone is "done":
1. Ray reviews against the acceptance criteria.
2. We do a short retro: what's worth memorizing for next time, what should change about how we sequence work.
3. Ray says "continue" → next milestone starts.
4. If priorities shift, we re-order remaining milestones (no calendar pressure).

If a milestone is too big once we're inside it, we split it. If too small, we pull from the next one. The numbered order is the default, not a contract.

---

*Companion: `SCALESOLO_AUDIT.md`. Both docs are the source of truth for the build until they diverge from reality, at which point we update them.*
