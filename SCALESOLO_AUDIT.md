# ScaleSolo Audit

**Source codebase:** Vernon Tech & Media CRM (this repo).
**Target product:** ScaleSolo, the AI-native operating system for solopreneurs.
**Audit date:** 2026-05-03.
**Author:** Claude Code, working from `ScaleSolo_App_Pages_and_Features.pdf` (v1) and `ScaleSolo_VTM_Implementation_Reference.md`, against the live VTM repo and live Supabase project `ssllepovajmohdhvhzsa`.

This audit is the foundation for the fork. No code has been moved or modified yet. After Ray reviews this and the companion `SCALESOLO_PHASE_1_PLAN.md`, work begins on Milestone 0.

---

## Table of contents
1. [Codebase structure](#1-codebase-structure)
2. [Database schema (live)](#2-database-schema-live)
3. [API endpoint inventory](#3-api-endpoint-inventory)
4. [Frontend page inventory](#4-frontend-page-inventory)
5. [Production gotchas (verified)](#5-production-gotchas-verified)
6. [Third-party APIs in active use](#6-third-party-apis-in-active-use)
7. [Environment variables](#7-environment-variables)
8. [Feature mapping: ScaleSolo spec ↔ VTM](#8-feature-mapping-scalesolo-spec--vtm)
9. [Greenfield builds (DDL + endpoint signatures)](#9-greenfield-builds-ddl--endpoint-signatures)
10. [Out of scope for v1](#10-out-of-scope-for-v1)
11. [Risk register](#11-risk-register)
12. [Database migration plan](#12-database-migration-plan)

---

## 1. Codebase structure

### 1a. Directory tree (top 3 levels, condensed)
```
VTM/
├── Academy/                       # TGFX Academy static assets (separate product)
├── CRM/                           # React SPA (admin app)
│   ├── client/
│   │   ├── src/
│   │   │   ├── pages/             # 35 route components
│   │   │   ├── components/        # 25 shared components
│   │   │   ├── context/           # 7 React contexts
│   │   │   └── ...
│   │   ├── dist/                  # built bundle copied into New/admin/
│   │   └── package.json
│   ├── server/                    # legacy local Express server (superseded; not deployed)
│   └── supabase/migrations/       # 6 incremental SQL files
├── New/                           # the deployed Vercel project root
│   ├── api/
│   │   ├── crm/                   # 70 serverless functions
│   │   ├── academy/               # 24 serverless functions
│   │   ├── _lib/                  # 6 shared modules (supabase, mailerlite, gmail, ...)
│   │   └── *.js                   # 9 root endpoints (auth, chat, lead, posts, ...)
│   ├── admin/                     # built CRM SPA bundle (committed)
│   ├── academy/                   # built Academy SPA bundle (committed)
│   ├── *.html                     # public marketing pages
│   ├── sql/                       # one-off SQL snippets
│   └── vercel.json                # routing, cron, function timeouts
├── Email Marketing/               # legacy
├── migrations/                    # 3 root-level SQL migrations (early CRM bootstrap)
└── build-crm.sh                   # CRM/client build → New/admin/ + commit reminder
```

### 1b. Stack baseline
| Layer | Tech | Confirmed |
|---|---|---|
| Frontend | React 18 + Vite + Tailwind, react-router-dom 6, lucide-react, recharts, papaparse, xlsx, dompurify | `CRM/client/package.json` |
| Backend | Vercel Serverless Functions, Node 20 | `New/vercel.json`, `package.json` |
| Database | Supabase Postgres 17.6.1 | live project `ssllepovajmohdhvhzsa` |
| Auth | Supabase Auth (email + Google OAuth) | `_lib/supabase.js`, `Login.jsx` |
| Storage | Supabase Storage (`content-media`, `avatar-media`, `blog-media`) | various endpoints |
| Cron | Vercel Cron, every 15 min for `email-cron` and `publish-cron` | `vercel.json` |
| Build | `bash build-crm.sh` runs `vite build` then copies `CRM/client/dist/` into `New/admin/` for deploy | feedback memory `feedback_crm_build.md` |

Function timeout config (notable):
- 300s: `recordings`, `bulk-upload`, `carousel-generator`, `bulk-agent`, `transcribe`
- 120s: `email-edit-ai`
- 60s: agents, content-ai, brand-bible, email-campaigns, uploadpost, publish-cron
- 30s: personalize-script, mailerlite-groups, billing, stripe-webhook

---

## 2. Database schema (live)

Snapshot from live Supabase (78 tables in public schema). Key tables grouped by purpose.

### 2a. Multi-tenant foundation (port directly to ScaleSolo)

**`crm_content_clients`** (36 cols) — the brand profile. **This becomes ScaleSolo's `profiles` table.**
Key cols: `id uuid pk`, `business_name text NN`, `owner_name`, `industry`, `brand_bible text`, `target_audience`, `preferred_tone`, `instagram_handle`, `tiktok_handle`, `facebook_handle`, `threads_handle`, `youtube_handle`, `linkedin_handle`, `x_handle`, plus matching `*_id` cols, `uploadpost_user`, `uploadpost_platforms text[]` (default `{tiktok,instagram}`), `autodm_reply_message`, `enabled_pages text[]` (per-tenant feature flags), `carousel_templates jsonb`, `threads_style jsonb`, `logo_url`, `brand_primary_color`, `brand_secondary_color`, `core_hashtags`, `location`, `is_active bool`, `created_at`, `updated_at`. 4 rows currently.

**`crm_user_access`** (6 cols) — multi-tenant grants. Composite PK `(user_id, client_id)`.
Cols: `user_id uuid NN`, `client_id uuid NN`, `role text NN default 'viewer'`, `allowed_pages text[] NN` (whitelist of route slugs), `created_at`, `updated_at`. 2 rows.

**`crm_team_members`** (10 cols) — overlapping grants table (TECH DEBT: dedupe with `crm_user_access`).
Cols: `id`, `email NN`, `name`, `role NN default 'admin'`, `permissions jsonb default '[]'`, `invite_status text default 'pending'`, `user_id`, `allowed_client_ids uuid[]`, `default_client_id uuid`, `created_at`. RLS DISABLED. 2 rows.

### 2b. Content engine

**`crm_content_scripts`** (24 cols) — unified post record (video / image / carousel / text).
Cols: `id`, `client_id`, `title`, `hook`, `full_script`, `series_name`, `caption`, `hashtags`, `first_comment`, `tags`, `media_urls text[]`, `media_type text default 'video'` (video/image/photo/carousel), `scheduled_datetime`, `status text default 'draft'` (draft / caption_ready / scheduled / posted / failed), `sort_order`, `post_type text default 'post'`, `location`, `uploadpost_request_id text`, `publish_status text` (publishing / posted / failed), `cover_timestamp int`, `platforms text[]` (per-post override), `publish_error text`, `created_at`, `updated_at`. 87 rows.

**`crm_auto_schedule_config`** (6 cols) — per-tenant publish slots.
Cols: `id`, `client_id`, `time_slots text[] NN` (e.g. `{10:00,14:00,18:00,22:00}`), `timezone text default 'America/Chicago'`, `is_active bool`, `created_at`. 4 rows.

### 2c. Avatars (ported as multi-tenant via `client_id` on renders)

**`crm_avatars`** (15 cols) — one row per AI character (HeyGen group + ElevenLabs voice). Has `client_id` col but mostly null currently. Caption styling defaults baked in via `caption_style jsonb` and `title_style jsonb`. 1 row.

**`crm_avatar_outfits`** (6 cols) — outfit groups. Has `client_id` col. 10 rows.

**`crm_avatar_looks`** (8 cols) — per-angle still images. `image_url text NN`, `heygen_look_id`, `angle_order`. Has `client_id` col. 126 rows.

**`crm_avatar_renders`** (22 cols) — render jobs. `script text NN`, `sentences jsonb` (per-sentence work plan with audio_url, heygen_video_id, clip_url, status), `final_video_url`, `status` enum (`draft / pending / generating_audio / generating_clips / stitching / done / failed`), `logs jsonb`, music + caption + logo styling cols, `client_id`. 8 rows.

### 2d. Email (MailerLite-backed)

**`crm_email_config`** (9 cols) — per-tenant credentials. `resend_api_key text NN` (LEGACY: still required NOT NULL but Resend is ripped out — needs nullable migration), `mailerlite_api_key text`, `from_email NN`, `from_name`, `daily_limit int default 100`. 2 rows.

**`crm_email_contacts`** (20 cols) — subscriber list. `email NN`, `name`, `tags jsonb default '[]'`, `status text default 'active'` (active/unsubscribed/bounced), `mailerlite_subscriber_id text`, `mailerlite_synced_at`, `birthday_month`, `birthday_day`, `signed_up_at`, `discount_code`, `phone`, `city`, `state`, `country`, `source`, `welcomed_at`. UNIQUE (`client_id`, `email`). GIN index on tags. 259 rows.

**`crm_email_campaigns`** (20 cols) — broadcast metadata. `subject NN`, `html_body NN`, `tag_filter jsonb`, `status` (draft/scheduled/sending/sent/partial), `mailerlite_campaign_id`, counters (`total_recipients`, `sent_count`, `failed_count`, `opened_count`, `clicked_count`), `trigger_on_tag`, `auto_trigger_enabled`, `trigger_type` (tag/broadcast), `preview_text`. 6 rows.

**`crm_email_templates`** (10 cols) — reusable templates. `name NN`, `subject NN`, `html_body NN`, `template_type text default 'blast'` (welcome/blast), `preview_text`, `is_default bool`. 4 rows.

**`crm_email_tag_context`** (6 cols) — per-tag descriptions used by the email AI agent for segmentation reasoning. `tag NN`, `description`. 3 rows.

**`crm_mailerlite_groups`** (6 cols) — tag → ML group cache. `tag NN`, `group_id NN`, `group_name`, `synced_at`. RLS DISABLED. 8 rows.

**`crm_email_sends`** (14 cols), **`crm_email_daily_usage`** (4 cols), **`crm_email_birthday_sends`** (5 cols) — Resend-era leftovers, currently 0–3 rows. Candidates for archival in ScaleSolo.

**`crm_email_labels`** (10 cols), **`crm_email_queue`** (legacy outbound draft queue, 91 rows) — legacy outbound flows, partially superseded.

### 2e. CRM core (Vernon's single-tenant agency CRM — see name collision warning below)

**`crm_leads`** (51 rows), **`crm_contacts`** (9), **`crm_deals`** (11), **`crm_accounts`** (3), **`crm_projects`** (5), **`crm_project_items`** (1), **`crm_activities`** (0), **`crm_quick_notes`** (0), **`crm_meetings`** (1), **`crm_meeting_lead_links`**, **`crm_meeting_summaries`**, **`crm_meeting_chat_history`**.

**No collision risk:** ScaleSolo runs on a **completely separate Supabase project** from VTM. Nothing in VTM's prod DB is touched or migrated. ScaleSolo's pipeline starts clean — table can simply be named `crm_deals` in the new project. None of Vernon's `crm_deals`, `crm_leads`, `crm_contacts`, `crm_activities` data ports over.

ScaleSolo's CRM (spec 3.6) starts from `crm_email_contacts` (the multi-tenant table that has the right shape) plus a new `crm_contact_activity` table — built fresh in the new project.

### 2f. Subscriptions (MISLABELED in reference doc)

**`crm_subscriptions`** (11 cols, 14 rows) — this tracks **Ray's personal SaaS subscriptions parsed from Gmail receipts**, not platform billing. Cols: `service`, `amount`, `billing_cycle`, `next_renewal`, `gmail_message_id`, `category`, `status`. **NOT** Stripe customer subscriptions. ScaleSolo will need a brand-new `subscriptions` (or re-use Stripe API directly) for its own billing.

### 2g. Other multi-tenant tables

**`crm_clients`** (30 cols, 6 rows) — older "Vernon's agency clients" table (different from `crm_content_clients`). Used by `clients.js`. May be repurposed or dropped in ScaleSolo.

**`crm_client_leads`** (19 cols, 36 rows) — outreach prospects per agency client. Out of scope for ScaleSolo v1.

**`crm_client_social_accounts`** (7 cols, 0 rows), **`crm_outreach_queue`** (13 cols, 18 rows), **`crm_autodm_monitors`** (10 cols, 1 row) — agency tooling, partial overlap.

**`crm_analytics_snapshots`** (9 cols, 5 rows) — per-tenant daily metrics. `client_id NN`, `snapshot_date`, `period text default 'last_7_days'`, `platforms text default 'instagram,tiktok'`, `analytics_data jsonb`, `impressions_data jsonb`. Direct port.

**`crm_portfolio`** (12 cols, 3 rows), **`crm_lead_recordings`** (40 rows, RLS DISABLED), **`crm_training_videos`** + **`crm_training_progress`** (RLS DISABLED), **`crm_app_settings`** (18 rows, key-value config) — agency-only, exclude from ScaleSolo.

### 2h. YouTube tooling
**`crm_yt_competitor_videos`**, **`crm_yt_knowledge_base`** (9 rows), **`crm_yt_scripts`**, **`crm_yt_thumbnails`** (10 rows), **`crm_yt_assets`** — Ray's TechnicalGods/longform tooling. Useful inspiration for ScaleSolo's content engine but separate scope.

### 2i. Academy (separate product, hard exclude)
13 `academy_*` tables. Skip for the fork.

### 2j. RLS state summary
- Most CRM tables: RLS enabled with permissive `auth_all_*` policies (`USING (true) WITH CHECK (true)`) — these are application-level multi-tenant scoping today, not database-enforced. **For ScaleSolo, must be replaced with proper `client_id = auth.uid()`-style policies via the `crm_user_access` join.**
- RLS DISABLED on: `crm_lead_recordings`, `crm_team_members`, `crm_training_videos`, `crm_training_progress`, `crm_scripts`, `crm_mailerlite_groups`. Risk if any of these get ported.

---

## 3. API endpoint inventory

70 endpoints in `New/api/crm/`, 9 in `New/api/`, 6 in `New/api/_lib/`, 24 in `New/api/academy/`. Format: `endpoint — methods | auth | tables | 3rd-party — purpose`.

### 3a. Auth, user, admin
| Endpoint | Methods | Auth | Tables | 3rd-party | Purpose |
|---|---|---|---|---|---|
| `_lib/supabase.js` | — | — | — | — | Core auth: `setCors`, `requireAuth`, `requireCrmUser`, `assertClientAccess`, `supaFetch`. CRM_ALLOWED_ORIGINS whitelist. |
| `crm/me.js` | GET | Bearer JWT | — | — | Current user profile. |
| `crm/admin-users.js` | GET/POST/PUT/DELETE | CRM admin | `crm_content_clients`, `crm_user_access` | Supabase admin API | RBAC user + grant management, "View as" impersonation backend. |
| `crm/auth-gmail.js` | GET/POST | public→token | `crm_app_settings` | googleapis | Gmail OAuth flow + refresh token storage. |
| `auth.js` | POST | public | — | — | HMAC token generator (24h, admin password). |

### 3b. Brand profile / multi-tenant
| Endpoint | Methods | Auth | Tables | 3rd-party | Purpose |
|---|---|---|---|---|---|
| `crm/content-clients.js` | GET/POST/PUT/DELETE | CRM user | `crm_content_clients`, `crm_user_access` | — | Brand profile CRUD scoped by user access. **PORT TO `profiles`.** |
| `crm/clients.js` | GET/POST/PUT/DELETE | CRM user | `crm_clients` | — | Older agency client table. Out of scope for ScaleSolo. |
| `crm/social-accounts.js` | GET/POST/PUT/DELETE | CRM user | `crm_client_social_accounts` | — | OAuth social profile links. |

### 3c. Avatars + render pipeline (HeyGen + ElevenLabs)
| Endpoint | Methods | Auth | Tables | 3rd-party | Purpose |
|---|---|---|---|---|---|
| `crm/avatars.js` | CRUD | CRM user | `crm_avatars` | — | Avatar master records. |
| `crm/avatar-heygen.js` | GET, POST | Bearer JWT | `crm_avatars`, `crm_avatar_looks` | api.heygen.com | List groups, list looks, **`refresh-looks` action re-fetches and patches expired image URLs (line 79–111)**. |
| `crm/avatar-outfits.js` | CRUD | CRM user | `crm_avatar_outfits` | — | Wardrobe groupings. |
| `crm/avatar-looks.js` | CRUD | CRM user | `crm_avatar_looks` | — | Per-angle still CRUD. |
| `crm/avatar-renders.js` | CRUD | CRM user | `crm_avatar_renders`, `crm_content_scripts` | api.anthropic.com | Render job orchestration + Claude title generation. |
| `crm/recordings.js` | GET/POST/DELETE | CRM user | `crm_lead_recordings`, `crm_communication_log`, `crm_leads` | api.elevenlabs.io, api.anthropic.com | Recording + transcription + AI isolation (300s timeout). |

### 3d. Content engine
| Endpoint | Methods | Auth | Tables | 3rd-party | Purpose |
|---|---|---|---|---|---|
| `crm/content-scripts.js` | CRUD | CRM user | `crm_content_scripts` | — | Script template CRUD. |
| `crm/scripts.js` | CRUD | CRM user | `crm_scripts` | — | Older script table (likely deprecate). |
| `crm/content-ai.js` | POST (multi-action) | CRM user | `crm_content_clients`, `crm_content_scripts`, `crm_auto_schedule_config` | api.anthropic.com | Multi-action: parse-scripts, generate-captions, auto-schedule, generate-content, edit-posts, edit-client, approve-and-schedule. |
| `crm/bulk-upload.js` | POST | CRM user | `crm_content_clients`, `crm_content_scripts` | api.elevenlabs.io (Scribe), api.anthropic.com | Drop-zone pipeline: video/audio → ElevenLabs Scribe transcription → Claude caption gen; image → Claude vision. 300s. |
| `crm/bulk-agent.js` | POST | CRM user | `crm_content_clients`, `crm_content_scripts`, `crm_auto_schedule_config` | api.anthropic.com | 4-step agentic bulk script generation (plan → generate → rewrite → review). 300s. |
| `crm/carousel-generator.js` | POST | CRM user | `crm_content_clients`, `crm_content_scripts` | **api.kie.ai** | Carousel image rendering. **Note:** ref doc says "Nano Banana via OpenArt" but the actual code calls `api.kie.ai/api/v1/jobs`. Env vars: `KIE_API_KEY`, `NANOBANANA_API_KEY`. 300s. |
| `crm/process-brand-bible.js` | POST | CRM user | `crm_content_clients` | api.anthropic.com (multimodal) | Parse uploaded PDF / image of brand guide → structured brand bible. |
| `crm/personalize-script.js` | POST | CRM user | — | api.anthropic.com | Personalize a script (insert names, etc). 30s. |

### 3e. Scheduling and publishing
| Endpoint | Methods | Auth | Tables | 3rd-party | Purpose |
|---|---|---|---|---|---|
| `crm/uploadpost.js` | GET/POST (multipart) | CRM user | `crm_content_scripts`, `crm_analytics_snapshots`, `crm_autodm_monitors` | api.upload-post.com | Manual publish, AutoDM, analytics fetch. **Photo flow uses multipart binary on `/api/upload_photos`**. |
| `crm/publish-cron.js` | POST | Bearer / cron secret | `crm_content_clients`, `crm_content_scripts` | api.upload-post.com | Every 15 min: fire scheduled posts, poll in-flight, mark posted/failed. |
| `crm/schedule-config.js` | GET/POST/DELETE | CRM user | `crm_auto_schedule_config` | — | Per-client time slots + timezone config. |

### 3f. Email (MailerLite stack)
| Endpoint | Methods | Auth | Tables | 3rd-party | Purpose |
|---|---|---|---|---|---|
| `_lib/mailerlite.js` | — | — | — | connect.mailerlite.com | SDK: upsert subscribers, group CRUD, campaigns, stats, **`convertMergeTags`, `sanitizeMlText`, `sanitizeMlCampaignName`, `resolveUtcTimezoneId`, preview_text strip**. |
| `_lib/email-html.js` | — | — | — | — | HTML wrapper + responsive boilerplate. |
| `_lib/enroll-sequences.js` | — | — | — | — | **DEPRECATED** — drips replaced by MailerLite Automations. |
| `crm/email-config.js` | GET/POST | CRM user | `crm_email_config` | mailerlite | Per-client credentials. |
| `crm/email-contacts.js` | GET/POST/DELETE | CRM user | `crm_email_contacts` | — | Subscriber CRUD + tag mgmt + ML sync trigger. |
| `crm/email-campaigns.js` | CRUD + send/schedule/cancel/refresh-stats | CRM user | `crm_email_campaigns`, `crm_email_config`, `crm_email_sends` | mailerlite | Campaign lifecycle. 60s. |
| `crm/email-templates.js` | CRUD | CRM user | `crm_email_templates` | — | Template library. |
| `crm/email-tag-context.js` | GET/POST/DELETE | CRM user | `crm_email_contacts`, `crm_email_tag_context` | — | Per-tag descriptions for AI agent. |
| `crm/email-template-ai.js` | POST | CRM user | `crm_content_clients`, `crm_email_config` | api.anthropic.com | Generate template body from brand bible. 60s. |
| `crm/email-edit-ai.js` | POST | CRM user | `crm_content_clients` | api.anthropic.com | AI copyedit + YouTube link embed detection. 120s. |
| `crm/email-stats.js` | GET | CRM user | `crm_email_campaigns`, `crm_email_config`, `crm_email_contacts`, `crm_email_sends` | mailerlite | Aggregated send/open/click stats. |
| `crm/mailerlite-groups.js` | GET | CRM user | `crm_email_config` | mailerlite | List ML groups for a tenant. 30s. |
| `crm/mailerlite-backfill.js` | POST | CRM user | `crm_email_contacts`, `crm_mailerlite_groups` | mailerlite | One-shot reconciliation. |
| `crm/email-labels.js` | GET/POST/DELETE | CRM user | `crm_email_labels` | — | Label/tag definitions. |
| `crm/email-upload-image.js` | POST | CRM user | — | Supabase Storage | Inline image upload. |
| `crm/email-cron.js` | POST | Bearer / cron secret | `crm_email_campaigns`, `crm_email_sends` | mailerlite | Every 15 min: send scheduled campaigns. |
| `crm/email-queue.js` | CRUD + send/draft | CRM user | `crm_email_queue` | — | Legacy outbound draft queue (Vernon agency). Out of scope. |
| `crm/email-generate.js` | POST | CRM user | `crm_email_queue`, `crm_leads`, `crm_app_settings`, `crm_communication_log` | — | Legacy AI email draft. Out of scope. |
| `crm/resend-webhook.js` | GET/POST (Svix) | public | `crm_email_campaigns`, `crm_email_contacts`, `crm_email_sends` | — | **DEPRECATED** Resend webhook handler. |

### 3g. Gmail integration (agency tooling — out of scope for ScaleSolo v1)
| Endpoint | Methods | Auth | Tables | 3rd-party | Purpose |
|---|---|---|---|---|---|
| `_lib/gmail.js` | — | — | `crm_app_settings` | gmail.googleapis.com | Gmail OAuth + REST + token refresh + MIME decode. |
| `crm/gmail-inbox.js` | GET | Bearer | `crm_email_labels`, `crm_gmail_cache` | gmail | Threadlist with pagination + label filter. |
| `crm/gmail-thread.js` | GET | Bearer | — | gmail | Single thread + message decode. |
| `crm/gmail-contacts.js` | GET | Bearer | — | people.googleapis.com | Contacts search. |
| `crm/gmail-trash.js` | POST | Bearer | `crm_gmail_cache` | gmail | Move to trash. |
| `crm/ai-followups.js` | GET | Bearer | — | gmail | Auto-generate Gmail thread follow-ups. |

### 3h. AI agents (Anthropic)
| Endpoint | Methods | Auth | Tables | 3rd-party | Purpose |
|---|---|---|---|---|---|
| `_lib/agent-attachments.js` | — | — | — | — | Convert image/pdf/text attachments → Claude multimodal blocks. |
| `crm/global-agent.js` | POST | CRM user | `crm_app_settings`, `crm_contacts`, `crm_deals`, `crm_leads`, `crm_todos` | api.anthropic.com | General CRM agent with tool-use. Routes from `GlobalAgent.jsx` keyword classifier. 60s. |
| `crm/email-agent.js` | POST | CRM user | `crm_app_settings`, `crm_contacts`, `crm_leads` | api.anthropic.com | Email-focused agent: draft / send / categorize. Returns `{action: 'draft_email', ...}` payload for client-side approval card. 60s. |
| `crm/bulk-agent.js` | POST | CRM user | `crm_content_clients`, `crm_content_scripts`, `crm_auto_schedule_config` | api.anthropic.com | 4-step bulk content gen. 300s. |

### 3i. Stripe / subscriptions / invoices
| Endpoint | Methods | Auth | Tables | 3rd-party | Purpose |
|---|---|---|---|---|---|
| `crm/subscriptions.js` | CRUD + subscribe | CRM user | `crm_subscriptions` | api.anthropic.com, gmail | Tracks Ray's personal SaaS subs (parsed from receipts). **Mislabeled in ref doc** — NOT customer billing. |
| `crm/invoices.js` | CRUD + refresh/void | CRM user | `crm_invoices` | api.stripe.com | Vernon agency Stripe invoices. |
| `crm/manual-invoices.js` | CRUD | CRM user | `crm_manual_invoices` | — | Non-Stripe invoices. |
| `crm/dashboard.js` | GET | CRM user | `crm_contacts`, `crm_deals`, `crm_invoices`, `crm_leads`, `crm_projects` | api.stripe.com | 12-month metrics, lead velocity, MRR. |
| `academy/billing.js`, `academy/stripe-webhook.js` | various | various | academy_* | api.stripe.com | Academy subscription billing — **good reference for ScaleSolo platform billing**. |
| (no ScaleSolo platform-billing endpoint exists yet) | — | — | — | — | **Greenfield: needs `stripe-checkout.js`, `stripe-webhook.js`, `stripe-portal.js` for ScaleSolo's own subscriptions.** |

### 3j. CRM core data (Vernon agency single-tenant — mostly out of scope)
| Endpoint | Methods | Auth | Tables | Purpose |
|---|---|---|---|---|
| `crm/leads.js` | CRUD + bulk + convert | CRM user | `crm_leads`, `crm_contacts` | Vernon's lead pipeline. |
| `crm/contacts.js` | CRUD | CRM user | `crm_contacts` | Vernon contacts. |
| `crm/deals.js` | CRUD | CRM user | `crm_deals` | Vernon deals (NOT the ScaleSolo pipeline). |
| `crm/accounts.js` | CRUD | CRM user | `crm_accounts` | Vernon accounts. |
| `crm/projects.js`, `project-items.js` | CRUD | CRM user | `crm_projects`, `crm_project_items` | Vernon project mgmt. |
| `crm/quick-notes.js` | CRUD | CRM user | `crm_quick_notes` | Sticky notes. |
| `crm/activities.js` | GET/POST/DELETE | CRM user | `crm_activities`, `crm_contacts`, `crm_leads` | Activity log. |
| `crm/communication-log.js` | GET/POST/PUT | CRM user | `crm_communication_log` | Threaded comms. |
| `crm/search.js` | GET | CRM user | `crm_accounts`, `crm_contacts`, `crm_deals`, `crm_leads`, `crm_projects` | Cross-entity search. |

### 3k. Meetings + analytics + misc
| Endpoint | Methods | Auth | Tables | 3rd-party | Purpose |
|---|---|---|---|---|---|
| `crm/meetings.js` | CRUD + notes | CRM user | `crm_meetings`, `crm_meeting_chat_history`, `crm_meeting_lead_links`, `crm_meeting_summaries` | calendar.googleapis.com | Google Calendar sync. |
| `crm/notifications.js` | GET/POST/DELETE | CRM user | many | — | Aggregated notification feed. |
| `crm/settings.js` | GET/PUT/POST | CRM user | `crm_app_settings` | — | App-level config. |
| `crm/label-defs.js` | GET/POST/DELETE | CRM user | `crm_label_defs` | — | Label taxonomy. |
| `crm/portfolio.js` | various | mixed | `crm_portfolio` | — | Public case studies. Out of scope. |
| `crm/training.js` | GET/POST/PATCH/DELETE | CRM user | `crm_training_*` | — | Internal training. Out of scope. |
| `crm/blog-posts.js`, `crm/lead-magnet.js`, `crm/client-logo-upload.js`, `crm/resources.js`, `crm/resource-categories.js` | various | various | various | Supabase Storage | Agency website tooling. Mostly out of scope; `lead-magnet.js` is the form-submission backend that ScaleSolo's form builder will reuse. |

### 3l. Root + Academy (one-liners)
- `New/api/auth.js`, `chat.js`, `lead.js`, `posts.js`, `transcribe.js`, `upload.js`, `admin-leads.js`, `admin-posts.js`, `resources.js` — public marketing site backends. `chat.js` is a Claude lead-capture chatbot (good reference for AI CEO public-facing demo). `lead.js` is the public lead intake (form submission backend, reusable).
- `New/api/academy/*` — 24 endpoints for the TGFX Academy product. **Out of scope.** Worth referencing `academy/stripe-webhook.js` and `academy/billing.js` when building ScaleSolo platform billing.

---

## 4. Frontend page inventory

35 pages in `CRM/client/src/pages/`. Sorted by line count (heaviest first), with ScaleSolo relevance.

| Page | Lines | Status for ScaleSolo |
|---|---:|---|
| `ContentScheduler.jsx` | 3744 | **Core ScaleSolo content engine.** Heaviest page in repo. Will need decomposition into `Content/` subroutes (Library / Calendar / Drafts / Approvals) before adding more features. |
| `Leads.jsx` | 2517 | Vernon agency lead management. **Out of scope** for ScaleSolo v1, but the smart-tagging and sortable-table patterns are reusable. |
| `EmailMarketing.jsx` | 2353 | **Core ScaleSolo email engine.** Composer + campaign list + contacts table. Needs the new sequence builder UI bolted on. |
| `Deals.jsx` | 1020 | Vernon's flat deal list. **Greenfield kanban replaces this** for ScaleSolo. |
| `Email.jsx` | 993 | Gmail inbox (agency tooling). Out of scope. |
| `Avatars.jsx` | 918 | **Core ScaleSolo avatar setup + render.** HeyGen URL refresh pattern verified at line 459. |
| `MeetingDetail.jsx` | 848 | Out of scope. |
| `GlobalAgent.jsx` (component) | 843 | **Core ScaleSolo AI CEO sidebar.** Battle-tested keyword router + approval workflow. Will get pgvector memory layer added. |
| `Products.jsx` | 793 | Stripe products admin (likely for VTM Academy / shop). Out of scope but partial reference. |
| `Meetings.jsx` | 779 | Out of scope. |
| `Training.jsx` | 773 | Out of scope. |
| `Invoices.jsx` | 660 | Vernon invoicing. Out of scope for v1. |
| `Resources.jsx` | 612 | Agency resource library. Out of scope. |
| `AdminUsers.jsx` | 546 | **Direct port** — multi-tenant grants + "View as" impersonation. |
| `Projects.jsx` | 545 | Out of scope. |
| `Portfolio.jsx` | 483 | Out of scope. |
| `Blog.jsx` | 470 | Out of scope. |
| `AcademyLessonEdit.jsx` | 679 | Academy product, exclude. |
| `AcademyCourseEdit.jsx` | 438 | Academy, exclude. |
| `Dashboard.jsx` | 425 | **Direct port + extend** with credit balance widget, approval queue, AI CEO daily briefing. |
| `Subscriptions.jsx` | 339 | Personal SaaS tracker. Out of scope. |
| `QuickNotes.jsx` | 374 | Out of scope. |
| `Scripts.jsx` | 365 | Older content. Likely subsumed by ContentScheduler. |
| `Settings.jsx` | 362 | **Direct port + extend** with credit balance, AI CEO behavior dial, billing tab. |
| `Contacts.jsx` | 312 | Likely deprecated (overlaps with EmailMarketing's contact tab). |
| `Notifications.jsx` | (small) | Port. |
| `Accounts.jsx` | 260 | Out of scope. |
| `AcademyMessages.jsx` and other Academy* | 263–438 | Academy product, exclude. |
| `Login.jsx` | (small) | Port + rebrand. |

**Component highlights:**
- `RenderComposer.jsx` (332 lines) — **avatar render UI, contains the lookbehind-safe `splitSentences` (line 12 — comment confirms the Safari fix).**
- `BulkImport.jsx` (394 lines) — partial CSV import (legacy). The form-builder/CSV-import UI in ScaleSolo greenfield can borrow from this.
- `EmailEditor.jsx` (685 lines) — heavy email composer with merge tags.
- `ComposeModal.jsx` (571 lines) — Gmail compose. Out of scope.
- `Sidebar.jsx`, `Header.jsx` — full reskin needed for ScaleSolo.

**Contexts (`CRM/client/src/context/`):**
- `AuthContext.jsx` — Supabase Auth wrapper. Direct port.
- `ClientContext.jsx` — **Active-brand selector + impersonation.** Stores `vtm.crm.selectedClientId` and `vtm.crm.viewingAs` in localStorage. Direct port → rename to `ProfileContext`, key prefix `scalesolo.profile.*`.
- `RefreshContext.jsx`, `RecorderContext.jsx`, `PrivacyContext.jsx`, `TeamContext.jsx`, `UiContext.jsx` — port as needed.

---

## 5. Production gotchas (verified)

All confirmed against current code on 2026-05-03.

1. **HeyGen image URLs expire (24–48h).**
   - Backend fix: `New/api/crm/avatar-heygen.js:79–111` exposes `?action=refresh-looks` which re-fetches from HeyGen and patches each row's `image_url`.
   - Client check: `CRM/client/src/pages/Avatars.jsx:459` parses `?Expires=` from the cached URL on mount and silently triggers the refresh endpoint if expired.
   - For ScaleSolo: keep this pattern, OR proxy on first load into Supabase Storage for permanent URLs (one-time storage cost vs ongoing refresh round-trip).

2. **Lookbehind regex breaks Safari < 16.4.**
   - Verified at `CRM/client/src/components/RenderComposer.jsx:9–12` — the comment block explicitly says `(?<=[.!?])\s+` was crashing the page with "Invalid regular expression: invalid group specifier name". Replaced with char-by-char `splitSentences()`.
   - For ScaleSolo: do not use lookbehind anywhere in client-bundled code.

3. **MailerLite merge tag boundary.**
   - `_lib/mailerlite.js:174` — `convertMergeTags(s)` translates `{{name}}` → `{$name}` at the API boundary. Editor uses `{{...}}`, MailerLite expects `{$...}`.

4. **MailerLite text + name sanitizers.**
   - `_lib/mailerlite.js:188` — `sanitizeMlText(s, maxLen)` strips HTML angle brackets, ASCII control chars, null bytes, zero-width unicode.
   - `_lib/mailerlite.js:206` — `sanitizeMlCampaignName(s)` strips both `{{...}}` and `{$...}` (campaign name rejects all merge syntax).

5. **MailerLite `timezone_id: 1` is NOT UTC.**
   - `_lib/mailerlite.js:289` — `resolveUtcTimezoneId(apiKey)` looks up the real UTC id via `GET /api/timezones` and caches per-process. Without this, scheduled sends silently land in Drafts.

6. **MailerLite `preview_text` is not a documented sub-field.**
   - `_lib/mailerlite.js:254, 273` — stripped on updateCampaign. Sending it triggers misleading "emails.0 must be an array" error.

7. **UploadPost photo flow uses multipart binary.**
   - `New/api/crm/uploadpost.js` — `/api/upload_photos` endpoint requires `photos[]=<binary>`, NOT URLs. Took two iterations to discover.

8. **TikTok title cap = 90 chars (recently fixed).**
   - Recent commit `436a5a8` ("Cap TikTok photo title at 90 chars"). Use `tiktok_title=<short>` and let longer caption flow to `description` (which TikTok ignores anyway).

9. **`media_type='image'` vs `'photo'`.**
   - Recent commit `d6ead46` — internally we use `image`; UploadPost wants `photo`. Normalized at the boundary.

10. **Async job request_id + publish_error stored on the row.**
    - `crm_content_scripts.uploadpost_request_id`, `.publish_status`, `.publish_error` (added in migration `2026_05_01_publish_error.sql`). Lets you debug failures from the DB without Vercel logs.

11. **Multi-tenant from day one — but RLS is permissive today.**
    - Most tables have `auth_all_*` policies (`USING (true)`). Application-level scoping only. **For ScaleSolo this must become real `client_id`-scoped RLS via the `crm_user_access` join.**

---

## 6. Third-party APIs in active use

| Capability | Provider | Endpoints / Models | Auth header | Env var |
|---|---|---|---|---|
| LLM (chat, generation, vision, brand bible parsing) | Anthropic | `https://api.anthropic.com/v1/messages` — `claude-sonnet-4-5` | `x-api-key`, `anthropic-version: 2023-06-01` | `ANTHROPIC_API_KEY` |
| Voice cloning + TTS | ElevenLabs | `/v1/voices/add` (multipart), `/v1/text-to-speech/{id}` (`eleven_turbo_v2_5`) | `xi-api-key` | `ELEVENLABS_API_KEY` |
| Speech-to-text | ElevenLabs Scribe | `/v1/speech-to-text` (`scribe_v1`) | `xi-api-key` | `ELEVENLABS_API_KEY` |
| Avatar video gen | HeyGen | `/v2/avatar_group.list`, `/v2/avatar_group/{id}/avatars`, `/v2/video/generate`, `/v1/video_status.get` | `X-Api-Key` | `HEYGEN_API_KEY` |
| Image gen (carousels) | **kie.ai** (NOT OpenArt directly) | `https://api.kie.ai/api/v1/jobs/createTask`, `/recordInfo` | `Authorization: Bearer <key>` | `KIE_API_KEY`, `NANOBANANA_API_KEY` |
| Email delivery + automations | MailerLite Connect | `https://connect.mailerlite.com/api/*` | `Authorization: Bearer <key>` | per-tenant on `crm_email_config.mailerlite_api_key` |
| Multi-platform social publish | UploadPost | `https://api.upload-post.com/api/{upload, upload_photos, uploadposts/text, uploadposts/status, analytics/{user}}` | `Authorization: Apikey <key>` | `UPLOADPOST_API_KEY` |
| Payments | Stripe | Checkout, Customer Portal, Webhooks | `Authorization: Bearer <secret>` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| HTML/CSS → image (thumbnails) | HCTI | `https://hcti.io/v1/image` | basic auth | `HCTI_USER_ID`, `HCTI_API_KEY` |
| Google Calendar / Gmail / People | Google | `googleapis.com/{calendar/v3, gmail/v1, people/v1, oauth2/v2/userinfo}` | OAuth bearer per user | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` |
| Storage | Supabase Storage | `content-media`, `avatar-media`, `blog-media` | service key | `SUPABASE_SERVICE_KEY` |
| Database + Auth | Supabase | RLS-scoped multi-tenant | service or anon key | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` |
| Hosting | Vercel | SPA + serverless + cron | — | (Vercel env) |

**For ScaleSolo:** add **Postmark** (or SendGrid/Resend) for native transactional and early marketing send (replaces per-tenant MailerLite as the always-on provider) — env var `POSTMARK_API_KEY`. Add **pgvector** (Postgres extension, no new infra) for AI CEO memory.

---

## 7. Environment variables

Currently in use (grep'd from `New/api/`):
```
ADMIN_PASSWORD              # auth.js HMAC token gen
ANTHROPIC_API_KEY           # Claude calls everywhere
CRM_ALLOWED_ORIGINS         # CORS allowlist for CRM endpoints
CRM_SUPABASE_ANON_KEY       # CRM-side Supabase anon
CRM_SUPABASE_SERVICE_KEY    # CRM-side service role
CRM_SUPABASE_URL            # CRM-side project URL
CRON_SECRET                 # protects publish-cron, email-cron
ELEVENLABS_API_KEY          # voice + transcription
FRONTEND_URL                # OAuth redirect base
GOOGLE_CLIENT_ID            # OAuth
GOOGLE_CLIENT_SECRET        # OAuth
GOOGLE_REDIRECT_URI         # OAuth
HCTI_API_KEY, HCTI_USER_ID  # HTML→image
HEYGEN_API_KEY              # avatar video
KIE_API_KEY                 # carousel image gen
NANOBANANA_API_KEY          # alt carousel key
RESEND_WEBHOOK_SECRET       # legacy webhook signature
STRIPE_SECRET_KEY           # platform Stripe (subs + invoices)
STRIPE_WEBHOOK_SECRET       # webhook signature
SUPABASE_ANON_KEY           # Academy/site-wide
SUPABASE_SERVICE_KEY        # service role (site-wide)
SUPABASE_URL                # site-wide project URL
UPLOADPOST_API_KEY          # social publishing
VTM_EMAIL_CLIENT_ID         # legacy outreach
```

**ScaleSolo additions:**
```
POSTMARK_API_KEY            # native transactional + early marketing
SCALESOLO_DOMAIN            # placeholder for app domain (vs vernontm.com)
PGVECTOR_DIMS=1536          # if needed by AI CEO memory
OPENAI_API_KEY              # for text-embedding-3-small embeddings (cheaper than Voyage)
STRIPE_SCALESOLO_PRICE_*    # tier price IDs (starter / pro / studio / founding-100)
```

Drop / archive in the fork: `RESEND_WEBHOOK_SECRET`, `VTM_EMAIL_CLIENT_ID`, `ADMIN_PASSWORD`-based HMAC tokens (replace with Supabase JWT only).

---

## 8. Feature mapping: ScaleSolo spec ↔ VTM

Status legend:
- **Port** — works as-is, just rebrand and re-skin.
- **Port+** — solid foundation, needs upgrades or extensions.
- **Greenfield** — does not exist in VTM, build from scratch.
- **v2** — defer past v1 launch.
- Effort: S (≤ 1 day), M (2–5 days), L (1–2 weeks), XL (3+ weeks).

### Section 1 — Marketing and acquisition

| ScaleSolo feature | VTM equivalent | Status | Effort |
|---|---|---|---|
| 1.1 Public landing page | `vernontm.com/` static HTML, `New/*.html` | Port (rebrand, replace copy + screenshots) | M |
| 1.2 Pricing page (3 tiers + founding-100) | No dedicated tier page yet; Stripe Checkout via `academy/billing.js` is closest reference | Greenfield (small) — static page + Stripe | M |
| 1.3 Sign-up + login (tier preselect, 14-day trial) | `Login.jsx` + `AuthContext.jsx` (Supabase Auth) | Port+ (add `?tier=` param + trial activation) | S |

### Section 2 — Onboarding

| ScaleSolo feature | VTM equivalent | Status | Effort |
|---|---|---|---|
| 2.1 Welcome wizard | none (single-step today) | Greenfield | S |
| 2.2 Brand bible builder (guided form + AI assist + PDF/image upload) | `process-brand-bible.js` exists for upload→Claude extraction. Form UI does not exist. `crm_content_clients.brand_bible` is a single text col. | Port+ (extend with multi-screen guided form) | L |
| 2.3 Avatar + voice setup | `Avatars.jsx` (918 lines) + `RenderComposer.jsx` + `avatar-heygen.js` + ElevenLabs voice clone via `/v1/voices/add` | Port+ (bring HeyGen photo avatar training inline via `/v2/photo_avatar/photo/generate`) | L |
| 2.4 First content "wow moment" (5 choices, streaming generation, celebrate) | All 5 endpoints exist (`email-template-ai`, `bulk-agent`, `carousel-generator`, `avatar-renders`; landing builder is greenfield). No streaming yet. | Port+ (wire choice selector, add SSE streaming) | M |

### Section 3 — Core app

| ScaleSolo feature | VTM equivalent | Status | Effort |
|---|---|---|---|
| 3.1 Main dashboard | `Dashboard.jsx` (425 lines) + `dashboard.js` | Port+ (add credit balance widget, approval queue, streak) | M |
| 3.2 AI CEO chat sidebar | `GlobalAgent.jsx` (843 lines) + `global-agent.js` + `email-agent.js` + `bulk-agent.js`. Keyword routing, approval cards, multimodal attachments. | Port+ (add memory pinning, persistent history, voice mode, behavior dial) | L |
| 3.3 Content engine | `ContentScheduler.jsx` (3744 lines), `content-ai.js`, `bulk-upload.js`, `bulk-agent.js`, `carousel-generator.js`, `avatar-renders.js` | Port+ (decompose page, add approval status filter, repurposing engine) | XL |
| 3.4 Email engine (composer, sequences, AI assist) | `EmailMarketing.jsx` (2353 lines), `EmailEditor.jsx`, `email-campaigns.js`, MailerLite stack | Port+ for composer/list. Greenfield for: native sending (Postmark), node-based sequence editor (React Flow), deliverability dashboard, A/B testing, send-time optimization. | XL |
| 3.5 Social media scheduler | `ContentScheduler.jsx` calendar + `uploadpost.js` + `publish-cron.js` + `crm_auto_schedule_config` | Port+ (calendar drag-to-reschedule, content recycling, hashtag library) | L |
| 3.6 CRM and contacts | `crm_email_contacts` (the right table for ScaleSolo) + tags. NOT Vernon's `crm_leads`/`crm_contacts`. | Port+ (add detail view, activity timeline, lead source tracking, smart tagging, CSV import UI) | L |
| 3.7 Sales pipeline (kanban) | Vernon's `Deals.jsx` is flat. **Greenfield** kanban needed. | Greenfield | L |
| 3.8 Forms + lead capture | `lead-magnet.js` is the submission backend. Drag-and-drop builder UI does not exist. | Greenfield builder; port submit endpoint | L |
| 3.9 Calendar + bookings (Calendly replacement) | `Meetings.jsx` reads Google Calendar; no public booking page; no Outlook/iCloud. | **v2** — too big for v1 | XL |
| 3.10 Voice agents (inbound + outbound) | none | **v2** | XL |
| 3.11 Landing page builder | none | Greenfield (mirror carousel builder pattern: section JSON definitions + `landing_pages.sections jsonb`) | XL |
| 3.12 Payments + invoicing (per-tenant Stripe Connect) | Platform-level Stripe wired (`stripe-webhook.js`, `invoices.js`, `academy/billing.js`). **Per-tenant Connect not built.** | **v2** — Connect is meaningful but defer; v1 ScaleSolo charges its own subscriptions only via platform Stripe. | XL |
| 3.13 Analytics + reporting (cross-platform + AI narrative) | `crm/dashboard.js`, `crm_analytics_snapshots`, UploadPost analytics fetch | Port+ (add `narrative` text col, nightly Claude-generated insights, exports) | L |

### Section 4 — Account and settings

| ScaleSolo feature | VTM equivalent | Status | Effort |
|---|---|---|---|
| 4.1 Profile + account | Supabase Auth | Port (add 2FA, account deletion w/ export) | M |
| 4.2 Brand profiles (multi-brand, switcher, "View as") | `ClientContext.jsx`, `crm_content_clients`, `crm_user_access`, `AdminUsers.jsx` impersonation | **Direct port** (rename client→profile) | M |
| 4.3 Credits + billing (3 pools, top-ups) | none | Greenfield | L |
| 4.4 Team + collaborators (Owner/Admin/Editor/Viewer roles) | `crm_user_access` exists, `role` is unconstrained text. `crm_team_members` overlaps. | Port+ (constrain roles, dedupe with team_members) | M |
| 4.5 Integrations (social OAuth, calendar, payments, email infra, Zapier, public REST API) | Google OAuth, MailerLite per-client, UploadPost (single platform key), HeyGen, ElevenLabs, Stripe | Port+ for existing. Greenfield: Postmark, Zapier app, REST API for power users. | XL (split across milestones) |
| 4.6 Settings + preferences (appearance, AI CEO behavior dial) | `Settings.jsx` has light/dark + timezone | Port+ (add `agent_aggressiveness` col + UI dial) | M |

---

## 9. Greenfield builds (DDL + endpoint signatures)

Each greenfield section below is build-ready: tables, indexes, RLS, and endpoint contracts.

### 9.1 Credit system (Milestone 2)

The most important greenfield piece. Blocks revenue and shapes every AI endpoint.

**Tables:**
```sql
-- one row per (profile, pool_type) — 3 rows per profile
create table credit_pools (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  pool_type text not null check (pool_type in ('ai_tokens','video_units','voice_minutes')),
  balance numeric not null default 0,
  monthly_grant numeric not null default 0,
  last_reset_at timestamptz not null default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (profile_id, pool_type)
);
create index credit_pools_profile_idx on credit_pools(profile_id);

-- append-only audit log
create table credit_transactions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  pool_type text not null,
  delta numeric not null,                   -- negative for consumption, positive for grant/topup
  action text not null,                     -- 'monthly_grant', 'topup', 'consume:bulk-agent', etc.
  ref_table text,                           -- e.g. 'crm_avatar_renders'
  ref_id uuid,
  balance_after numeric not null,
  metadata jsonb default '{}',
  created_at timestamptz default now()
);
create index credit_tx_profile_created_idx on credit_transactions(profile_id, created_at desc);

-- RLS: only the profile's owner (via crm_user_access) can read; only service_role writes.
```

**Middleware contract** (`api/_lib/credits.js`):
```js
async function checkAndConsume({ profileId, poolType, amount, action, refTable, refId, metadata }) {
  // 1. SELECT balance FOR UPDATE
  // 2. if balance < amount → throw 402 InsufficientCredits
  // 3. UPDATE balance -= amount
  // 4. INSERT credit_transactions row
  // 5. return { newBalance, txId }
}
```

Wired into every AI endpoint:
- `bulk-upload.js`, `bulk-agent.js`, `content-ai.js`, `email-template-ai.js`, `email-edit-ai.js`, `personalize-script.js`, `process-brand-bible.js`, `chat`-style endpoints → `ai_tokens` pool
- `avatar-renders.js`, `carousel-generator.js` → `video_units`
- (v2) voice agents → `voice_minutes`

**Endpoints:**
- `GET  /api/credits` → `{ ai_tokens: {balance, monthly_grant, last_reset_at}, video_units: {...}, voice_minutes: {...} }`
- `GET  /api/credits/transactions?pool=ai_tokens&limit=50` → audit log
- `POST /api/credits/topup` body `{ pool_type, pack_id }` → creates Stripe one-off Checkout Session
- `POST /api/stripe-webhook` extension: on `checkout.session.completed` with `metadata.kind=='credit_topup'`, atomically grant credits

**Monthly reset:** Vercel Cron daily at 06:00 UTC checks `last_reset_at < date_trunc('month', now())` and grants `monthly_grant`. Creates `credit_transactions` row with `action='monthly_grant'`.

### 9.2 ScaleSolo platform billing (Milestone 1)

Needed before credits — credit grants are tied to subscription tier.

**Tables:**
```sql
-- platform-level subscription per workspace (one workspace = one billing customer)
create table billing_customers (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,                -- the auth.users.id who owns the workspace
  stripe_customer_id text unique,
  email text not null,
  created_at timestamptz default now()
);

create table billing_subscriptions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references billing_customers(id) on delete cascade,
  stripe_subscription_id text unique,
  stripe_price_id text not null,
  tier text not null check (tier in ('solo_starter','solo_pro','solo_studio','founding')),
  status text not null,                       -- trialing, active, past_due, canceled, ...
  trial_end timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean default false,
  profile_limit int not null,                 -- 1, 2, 5, etc.
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

**Endpoints:**
- `POST /api/stripe-checkout` body `{ tier, founding_code? }` → returns Checkout URL
- `POST /api/stripe-portal` → returns Customer Portal URL
- `POST /api/stripe-webhook` (already exists in academy/, generalize) → handles `customer.subscription.created`, `.updated`, `.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`, `checkout.session.completed`
- `GET  /api/billing` → returns current sub + usage projections + plan-change preview

### 9.3 AI CEO memory (Milestone 3)

```sql
create extension if not exists vector;

-- persistent conversation thread per profile (the user can have many conversations)
create table agent_conversations (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  title text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table agent_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references agent_conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant','tool','system')),
  content jsonb not null,                     -- multimodal blocks
  created_at timestamptz default now()
);
create index agent_messages_conv_created on agent_messages(conversation_id, created_at);

-- pinned facts: always included verbatim in system prompt
create table agent_pinned_facts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  fact text not null,
  created_at timestamptz default now()
);

-- embedded brand bible chunks for retrieval
create table agent_knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  source text not null,                       -- 'brand_bible', 'past_post', 'custom'
  source_ref uuid,
  chunk_text text not null,
  embedding vector(1536),
  created_at timestamptz default now()
);
create index on agent_knowledge_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);
```

**Endpoints:**
- `POST /api/agent/chat` body `{ conversation_id?, message, attachments? }` → SSE stream of Claude tokens. On first turn, creates conversation. Persists messages.
- `GET  /api/agent/conversations`, `GET /api/agent/conversations/:id/messages`, `DELETE /api/agent/conversations/:id`
- `POST /api/agent/pinned-facts` (CRUD)
- Internal: `embedBrandBible(profileId)` runs after brand-bible save; chunks at ~500 tokens, embeds with `text-embedding-3-small`, upserts.

**System prompt template:** brand bible summary + ALL pinned facts + retrieved top-k (k=5) knowledge chunks for the current message.

### 9.4 Native email sending (Milestone 4)

Replace MailerLite as the always-on for transactional + early marketing volume.

**Postmark wrapper** (`api/_lib/postmark.js`): `sendBatch(messages)`, `sendOne(msg)`, `getDeliveryStatus(messageId)`, suppression management.

**Tables:**
```sql
create table email_domains (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  domain text not null,
  spf_status text default 'pending',
  dkim_status text default 'pending',
  dmarc_status text default 'pending',
  postmark_signature_id text,
  verified_at timestamptz,
  unique (profile_id, domain)
);

create table email_suppressions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  email text not null,
  reason text not null check (reason in ('bounce','complaint','manual','unsubscribe')),
  created_at timestamptz default now(),
  unique (profile_id, email)
);
```

**Endpoints:**
- `POST /api/email/send` (replaces direct MailerLite call) → routes through Postmark, checks suppressions, debits `ai_tokens` if AI-generated
- `POST /api/email/domains` (add) + `GET /api/email/domains` + `POST /api/email/domains/:id/verify`
- `POST /api/email/postmark-webhook` (signature-verified) → updates `email_suppressions` on bounce/complaint, updates `crm_email_sends` on delivery/open/click

**Migration:** existing campaigns keep working through MailerLite during transition. New sends route to Postmark by default. Add a per-tenant `email_provider text default 'postmark'` column on the email config table.

### 9.5 Sales pipeline / kanban (Milestone 5)

```sql
-- profile-scoped pipelines (a profile can have multiple — e.g. coaching, courses, services)
create table crm_pipelines (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  stages jsonb not null default '["Lead","Qualified","Proposal","Negotiation","Won","Lost"]',
  is_default boolean default false,
  created_at timestamptz default now()
);

-- ScaleSolo runs on a separate Supabase project; no collision with the legacy VTM table
create table crm_deals (
  id uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null references crm_pipelines(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  contact_id uuid references crm_email_contacts(id) on delete set null,
  title text not null,
  stage text not null,
  value numeric default 0,
  expected_close_at date,
  age_started_at timestamptz default now(),
  closed_at timestamptz,
  win_loss_reason text,
  notes text,
  custom_fields jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index deals_pipeline_stage on crm_deals(pipeline_id, stage);
```

**Endpoints:** standard CRUD on `/api/pipelines` and `/api/deals`, plus `PATCH /api/deals/:id/move` body `{ stage }` for drag-drop.

**Frontend:** kanban using `@dnd-kit/core` (already React 18 compatible; lighter than `react-beautiful-dnd`).

### 9.6 Forms / lead capture builder (Milestone 5)

```sql
create table crm_forms (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  slug text not null,                   -- public URL: scalesolo.app/f/<slug>
  layout text not null default 'standard' check (layout in ('standard','conversational')),
  sections jsonb not null default '[]', -- [{type, label, fields, conditions, ...}]
  confirmation jsonb not null default '{}', -- { kind: 'message'|'redirect'|'email_sequence', ... }
  spam_protection jsonb default '{"honeypot":true,"recaptcha":false,"rate_limit":10}',
  is_published boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (profile_id, slug)
);

create table crm_form_submissions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references crm_forms(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  contact_id uuid,                     -- linked after upsert into crm_email_contacts
  payload jsonb not null,              -- raw answers
  source_url text,
  ip_address inet,
  user_agent text,
  created_at timestamptz default now()
);
create index form_submissions_form_idx on crm_form_submissions(form_id, created_at desc);
```

**Endpoints:**
- `GET/POST/PUT/DELETE /api/forms`
- `GET /api/forms/:id/submissions`
- `POST /api/forms/submit` (PUBLIC, rate-limited) — body `{ form_id, payload }` → upsert `crm_email_contacts` (dedup on email), insert submission, run confirmation action (send email, enroll in sequence, redirect).

**Builder UI:** `@dnd-kit/core` for section reordering. Field types: text, email, phone, dropdown, multi-choice, file upload (Supabase Storage), signature, payment (Stripe Element).

### 9.7 CSV import UI (Milestone 5)

```sql
create table crm_import_jobs (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  source_filename text not null,
  total_rows int not null,
  imported_count int default 0,
  skipped_count int default 0,
  failed_count int default 0,
  status text default 'pending',       -- pending, running, complete, failed
  field_mapping jsonb not null,        -- { csv_col: contact_field }
  error_log jsonb default '[]',
  created_at timestamptz default now(),
  completed_at timestamptz
);
```

**Endpoints:**
- `POST /api/contacts/import/preview` (multipart CSV upload) → returns first 10 rows + auto-detected column mapping
- `POST /api/contacts/import` body `{ csv_storage_key, mapping }` → inserts a job row, kicks off background processing (use a Vercel function with 300s timeout for ~10K rows per batch; for larger, queue the work).
- `GET /api/contacts/import/:id` → status

Use `papaparse` (already a dep) on the client for preview, server-side parse for the actual import.

### 9.8 Activity timeline (Milestone 5)

```sql
create table crm_contact_activity (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  contact_id uuid not null references crm_email_contacts(id) on delete cascade,
  event_type text not null,            -- 'email_sent', 'email_opened', 'form_submitted', 'deal_moved', 'note_added', 'tag_added', 'imported', ...
  payload jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  source text                          -- 'system', 'user', 'webhook'
);
create index activity_contact_time on crm_contact_activity(contact_id, occurred_at desc);
create index activity_profile_time on crm_contact_activity(profile_id, occurred_at desc);
```

Writes added at every touchpoint: email send/open/click webhook, form submission, deal stage change, tag mutation, import. UI: contact detail view sidebar.

### 9.9 Approval queue (Milestone 6 — small)

No new table — extend `crm_content_scripts`:
```sql
alter table crm_content_scripts
  add column needs_approval boolean default false,
  add column approval_status text check (approval_status in ('pending','approved','rejected')),
  add column approved_by uuid,
  add column approved_at timestamptz,
  add column rejected_reason text;

create index content_scripts_pending_approval
  on crm_content_scripts(profile_id) where approval_status = 'pending';
```

UI: dashboard "Pending Approvals" widget + dedicated `Approvals.jsx` route. AI-generated content sets `needs_approval=true, approval_status='pending'`.

### 9.10 Landing page builder (Milestone 7)

```sql
create table crm_landing_pages (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  slug text not null,
  custom_domain text,
  sections jsonb not null default '[]', -- ordered array of { type, props, content }
  meta jsonb not null default '{}',     -- { title, description, og_image, ... }
  is_published boolean default false,
  ab_variant_of uuid references crm_landing_pages(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (profile_id, slug)
);

create table crm_landing_page_views (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references crm_landing_pages(id) on delete cascade,
  occurred_at timestamptz default now(),
  referrer text,
  utm jsonb default '{}',
  scroll_depth_pct int,
  time_on_page_sec int
);
```

**Section library** — JSON definitions in `lib/landing-sections.js`: hero, features, testimonials, pricing, faq, cta, about, contact, stats, logos, video, gallery, form, embed.

**Renderer:** static React page at `/p/:slug` reads sections array, renders each via the registry. Sections are pure components reading their own props.

**Endpoints:**
- `GET/POST/PUT/DELETE /api/landing-pages`
- `POST /api/landing-pages/:id/generate` body `{ description }` → Claude generates a full sections array
- `POST /api/landing-pages/:id/publish` → flips `is_published`, deploys (no actual deploy needed if served from same Vercel app)
- `POST /api/landing-pages/track` (PUBLIC, beacon) — page view + scroll/time

---

## 10. Out of scope for v1

These are **not built in v1**; they are v2 candidates. Note them in the audit so we don't accidentally start them.

| Feature | Spec section | Reason |
|---|---|---|
| Public booking page (Calendly replacement) | 3.9 | Two-way Outlook + iCloud sync is the heavy lift. v1 ScaleSolo can link out to Cal.com or use the existing Google Calendar viewer. |
| Voice agents (inbound + outbound) | 3.10 | Bland.ai/Vapi integration + minute-billing infra is multi-week work, no foundation in VTM. |
| Per-tenant Stripe Connect | 3.12 | Meaningful add but not required for v1 monetization (ScaleSolo charges its own subscriptions only). |
| Native Outlook / iCloud calendar sync | 3.9 | Same as bookings. |
| Zapier app + public REST API | 4.5 | After v1 launch, when there's customer demand. |
| HubSpot/GHL/Mailchimp/Thryv/Kit one-click import | 4.5 | CSV import covers most migration cases for v1; per-platform OAuth is later. |
| LinkedIn enrichment | 3.6 | LinkedIn API access is hard. v1 does not include this. |
| Lead scoring (numeric) | 3.6 | Smart tagging covers the v1 use case. |
| QuickBooks / Notion / Slack / Drive native integrations | 4.5 | Phase 3 per the spec. |
| Crypto payments, ACH, dunning, affiliate auto-payout | 3.12 secondary | Phase 2+. |

---

## 11. Risk register

Prioritized highest to lowest risk.

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | ~~`crm_deals` name collision~~ — **resolved by separation.** ScaleSolo runs on its own Supabase project. No VTM tables port over. Pipeline starts clean as `crm_deals` in the new DB. | n/a | n/a |
| R2 | **Permissive RLS today.** Most tables use `USING (true)` policies; multi-tenancy is application-enforced only. A bug in `assertClientAccess` could leak data across tenants. | Severe — cross-tenant data leak. | Replace permissive policies in the fork with real `client_id`-scoped policies via `crm_user_access` join. Audit every endpoint to ensure `client_id` is always passed and validated. |
| R3 | **`crm_email_config.resend_api_key` is NOT NULL but Resend is dead.** Currently you must seed any Resend key (even fake) to insert a row. | Blocks net-new tenant onboarding. | Migration: `alter column drop not null` + remove all references in the codebase. |
| R4 | **`ContentScheduler.jsx` is 3744 lines.** Adding more features (approvals, recycling, hashtag library, repurposing) will compound. | Slow iteration, high regression risk. | Decompose into `Content/Library`, `Content/Calendar`, `Content/Drafts`, `Content/Approvals` subroutes BEFORE adding new features (Milestone 6 prep). |
| R5 | **`EmailMarketing.jsx` (2353) and `Leads.jsx` (2517) follow same pattern.** | Same as R4. | Decompose lazily — only when actively touching. |
| R6 | **Two grants tables** (`crm_user_access` + `crm_team_members`) plus two profile tables (`crm_clients` + `crm_content_clients`). | Confusion about source of truth. | Pick `crm_user_access` and `crm_content_clients` as the canonical pair; deprecate the others in the fork. Don't migrate `crm_team_members` data — re-grant via `crm_user_access`. |
| R7 | **HeyGen URL refresh tied to UI mount.** If a user never opens the Avatars page, broken URLs accumulate. | Cosmetic but reflects badly. | Move refresh to a daily cron OR proxy on first load into Supabase Storage. Storage approach kills the round-trip permanently. |
| R8 | **MailerLite single-vendor lock-in.** All campaign infra depends on MailerLite Connect API. | Outage / API change blocks all sends. | Postmark migration (Milestone 4) gives a fallback path. Keep ML for legacy campaigns through transition. |
| R9 | **No persistent agent conversations today.** If we ship the AI CEO with the existing in-memory pattern, every page reload wipes context. | Hurts the "always-on memory" pitch. | Build `agent_conversations` table in Milestone 3 before the AI CEO is heavily promoted. |
| R10 | **Vercel function timeout limits.** `bulk-upload` and `recordings` already at 300s ceiling. CSV imports of 50K+ rows will exceed this. | Large imports fail silently. | Chunk imports server-side: 5K rows per invocation, queue continuation. |
| R11 | **No idempotency on Stripe webhooks today.** Re-delivered events could double-grant credits. | Revenue / accounting bug. | Idempotency table keyed on `stripe_event_id` before any state change. |
| R12 | **Migrations are split across `migrations/` and `CRM/supabase/migrations/`** + many tables created via the SQL editor (no committed migration). | Schema drift, no replay path. | In the fork, baseline a single `scalesolo/supabase/migrations/0000_initial.sql` from the live schema dump (which we already pulled) and discipline new changes into incremental migrations from there. |
| R13 | **Carousel API is kie.ai, not OpenArt.** Reference doc had this wrong. | Minor — affects greenfield assumptions if we tried to "switch back." | Document corrected. Continue using kie.ai. |
| R14 | **RLS DISABLED on 6 tables today.** | Auth bypass risk if these are ported as-is. | Don't port `crm_lead_recordings`, `crm_team_members`, `crm_training_*`, `crm_scripts`, `crm_mailerlite_groups` into ScaleSolo without enabling RLS. |

---

## 12. Database migration plan

The fork starts from a baseline migration (live schema snapshot of relevant tables only), then applies incremental migrations per milestone.

### 12a. Baseline (Milestone 0)

ScaleSolo provisions its own clean Supabase project. **No data is ever migrated from VTM's database.** The baseline migration is hand-written DDL for ScaleSolo's table set, using VTM's schemas as a *reference for column shapes only*.

`scalesolo/supabase/migrations/0000_baseline.sql` defines (with `profile_id` from day one, no `crm_content_clients` rename gymnastics needed):

- `profiles` (the brand profile — shaped after VTM's `crm_content_clients` but cleanly named)
- `profile_access` (user grants — shaped after `crm_user_access`, cleanly named)
- `avatars`, `avatar_outfits`, `avatar_looks`, `avatar_renders`
- `content_scripts`, `auto_schedule_config`
- `email_config`, `email_contacts`, `email_campaigns`, `email_templates`, `email_tag_context`, `mailerlite_groups`
- `analytics_snapshots`

(Note: dropping the `crm_` prefix in the new project — these aren't "CRM tables" anymore, they're ScaleSolo's primary tables. Cleaner naming for the fork.)

**No data is copied from VTM. Existing customers are not migrated.** ScaleSolo opens with zero rows and grows from net-new signups.

### 12b. Rename happens at copy-time, not as a migration

Because there's no production ScaleSolo data and the new Supabase is empty, there's no view-swap dance. The "rename" is a one-time mechanical pass when copying source code into the new project:

- `selectedClient` / `selectedClientId` → `selectedProfile` / `selectedProfileId`
- `ClientContext.jsx` → `ProfileContext.jsx`
- localStorage key `vtm.crm.selectedClientId` → `scalesolo.profile.selectedId`
- API endpoint paths `/api/crm/content-clients` → `/api/profiles`
- Variable names: `clientId` → `profileId` everywhere
- Table refs in queries: `crm_content_clients` → `profiles`, `crm_user_access` → `profile_access`, etc.

Done as part of Milestone 1 (rebrand pass). One sweeping find-replace across the copied codebase, then thorough testing in the staging environment of the *new* Vercel/Supabase setup.

### 12c. New tables per milestone

| Migration file | Milestone | Tables |
|---|---|---|
| `0000_baseline.sql` | M0 | All ported tables: `profiles`, `profile_access`, `avatars`, `avatar_outfits`, `avatar_looks`, `avatar_renders`, `content_scripts`, `auto_schedule_config`, `email_config`, `email_contacts`, `email_campaigns`, `email_templates`, `email_tag_context`, `mailerlite_groups`, `analytics_snapshots` — clean DDL, no `resend_api_key NOT NULL`, no permissive RLS |
| `0001_billing.sql` | M1 | `billing_customers`, `billing_subscriptions` |
| `0002_credits.sql` | M2 | `credit_pools`, `credit_transactions` |
| `0003_agent_memory.sql` | M3 | `vector` extension, `agent_conversations`, `agent_messages`, `agent_pinned_facts`, `agent_knowledge_chunks` |
| `0004_postmark.sql` | M4 | `email_domains`, `email_suppressions`, `email_provider` col on `email_config` |
| `0005_pipeline.sql` | M5 | `pipelines`, `deals` |
| `0006_forms.sql` | M5 | `forms`, `form_submissions` |
| `0007_imports.sql` | M5 | `import_jobs` |
| `0008_activity.sql` | M5 | `contact_activity` |
| `0009_approvals.sql` | M6 | `content_scripts` extension |
| `0010_landing.sql` | M7 | `landing_pages`, `landing_page_views` |
| `0011_rls_strict.sql` | M8 (polish) | strict `profile_id`-scoped policies via `profile_access` join |

### 12d. RLS hardening (Milestone 8)

Strict RLS is **baked into M0's baseline** wherever practical, but a polish pass in M8 catches anything that slipped. Pattern for every multi-tenant table:

```sql
create policy "tenant_X_select" on X for select to authenticated
  using (exists (
    select 1 from profile_access pa
    where pa.user_id = auth.uid() and pa.profile_id = X.profile_id
  ));
create policy "tenant_X_modify" on X for all to authenticated
  using (exists (
    select 1 from profile_access pa
    where pa.user_id = auth.uid() and pa.profile_id = X.profile_id and pa.role in ('owner','admin','editor')
  ))
  with check (exists (
    select 1 from profile_access pa
    where pa.user_id = auth.uid() and pa.profile_id = X.profile_id and pa.role in ('owner','admin','editor')
  ));
```

Cron jobs and webhooks use `service_role` which bypasses RLS — each such endpoint validates `profile_id` from its own input.

---

*End of audit. Companion: `SCALESOLO_PHASE_1_PLAN.md`.*
