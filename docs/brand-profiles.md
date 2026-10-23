# Brand Profiles

A "brand profile" is one row in the Supabase `profiles` table: a single brand identity (name,
voice, colors, handles, posting schedule, visual style, Upload-Post wiring). Everything the app
generates (scripts, captions, covers, b-roll, descriptions) is scoped to the currently selected
brand. This is the multi-tenant unit of the whole product.

Reference files:
- `src/pages/Profiles.jsx` : the Brand profiles page + editor
- `api/profiles.js` : create / update, the ALLOWED column sets, tier limits
- `api/cron/distill-brand-voice.js` : the auto-learned voice summary
- `api/_lib/brand-context.js` : how a brand is assembled into model context
- `src/context/ProfileContext.jsx` : app-wide brand selection

---

## 1. What the page does

The `/profiles` page (`Profiles()` component) lets a user:

- **Create a brand** two ways: "New profile" opens a blank editor, or "Quickstart" has AI draft a
  profile from a handle + description (`QuickstartModal` POSTs `/api/profiles/quickstart`).
- **Switch brands**: clicking a card calls `setSelectedProfileId(p.id)`; the active one shows an
  "Active" pill.
- **Edit** a brand in a full-screen `ProfileEditor`.
- **Manage connections** (owner only): "Get intake link" (`/api/intake/token`), "Get connect link"
  (the Upload-Post JWT via `/api/social/profiles?action=jwt`, see `docs/upload-post-scheduling-system.md`),
  "Intake responses."
- **Delete** (owner only): hard `DELETE /api/profiles?id=...` after a confirm.

Access is mediated by `profile_access` (`role` owner/admin/editor/contributor + `allowed_pages`).
There is no archive concept here; the table has `is_active` but the UI exposes only hard delete.

---

## 2. The `profiles` columns that define a brand

Grouped by purpose. "Editable" = exposed in the editor UI; POST/PATCH = present in the matching
ALLOWED set in `api/profiles.js`.

**Identity**: `business_name` (the only required field; POST+PATCH), `industry`, `business_type`,
`website_url`, `owner_name`.

**Voice / bible**: `brand_bible` (long-form, capped 60k chars on create), `brand_bible_summary`,
`brand_cta` (default call to action, auto-fills first comment), `preferred_tone`, `target_audience`,
`do_not_say` / `always_include` (arrays).

**Visual identity**: `brand_primary_color`, `brand_secondary_color`, `logo_url` (PATCH-only),
`brand_colors`, `brand_fonts` (PATCH-only), `cover_template` jsonb `{ image_url, base_prompt }`
(PATCH-only).

**Studio visual style**: `visual_style_guide`, `visual_keywords` (array), `visual_avoid` (array),
`youtube_description_default`, `youtube_thumbnail_references` (array), `youtube_email_template_html`.

**Scheduling**: `timezone`, `posting_schedule` jsonb `{ days:[...], times:[...] }`
(default `{ days:[1,2,3,4,5], times:['09:00','14:00'] }`), `synced_platforms`.

**Handles and social IDs**: `instagram_handle`, `tiktok_handle`, `youtube_handle`, `linkedin_handle`,
`threads_handle`, `x_handle`, `facebook_handle`, the matching `*_id` columns, and `core_hashtags`.

**Upload-Post / publishing**: `uploadpost_user`, `uploadpost_platforms`, `tiktok_force_direct_post`,
`default_formats`, `default_platforms`.

**PATCH-only operational**: `autodm_reply_message`, `carousel_templates`, `threads_style`,
`enabled_pages`, `agent_aggressiveness`, `is_active`, `location`, `polish_template` (jsonb, supports
a `{ __merge: true, ... }` partial-merge).

**Key asymmetry**: `logo_url`, `cover_template`, `brand_colors`, `brand_fonts`, `polish_template`
are PATCH-allowed but **not** POST-allowed, a brand-new profile cannot set them on create (which is
why the editor says "Save the profile first" before a logo/thumbnail upload). The client's `save()`
also strips `_role`, `_allowed_pages`, `role`, `allowed_pages`, `created_at`, `updated_at` before
sending.

---

## 3. The editor UI

`ProfileEditor` is a full-screen portal modal with a left section rail + right content pane, driven
by a `SECTIONS` array where each section has an `isComplete(form)` that feeds an "X of Y sections
complete" progress bar. Sections:

1. **Identity**: name, website, industry, type
2. **Brand**: logo, primary/secondary colors, Instagram cover template
3. **Voice**: tone, audience, brand bible, CTA, Studio visual style/keywords/avoid, YouTube
   description boilerplate, thumbnail references, HTML email template; header hosts "Import bible"
4. **Voice training**: feedback-driven training + the distilled voice summary card (needs a saved profile)
5. **Schedule**: timezone, day toggles, posting times, frequency presets
6. **Social handles**: six handle inputs + core hashtags
7. **Tags and references** (needs a saved profile)
8. **Music library**: account-wide, not per-brand

Key state: `form` (`{ ...FORM_DEFAULTS, ...profile }`), `activeSection`, plus helpers `set(k,v)` and
`mergeFields(fields)`. `FORM_DEFAULTS` seeds every editable field.

---

## 4. Creating a brand and switching brands

**Create** (`POST /api/profiles`):
1. Requires `business_name`.
2. **Tier gate**: reads the user's billing tier (honored only when the subscription is
   trialing/active/past_due, else floored to `solo_starter`) and compares `profileLimitForTier`
   (Starter 1, Pro 2, Studio 5, Founding 2) against how many `profile_access` rows the user owns.
   Over the limit returns `402` with `code:'profile_limit_reached'`. Fails open on a DB error.
3. Whitelists the body against the POST ALLOWED set, caps `brand_bible` at 60k, inserts into `profiles`.
4. Creates the owner grant: a `profile_access` row with `role:'owner'`, `allowed_pages:['*']`.
5. Best-effort `indexBrandBible(...)` to embed the bible for retrieval, then `201 { profile }`.

```js
// src/pages/Profiles.jsx, save() POSTs when new, PATCHes otherwise
const STRIP = new Set(['_role','_allowed_pages','role','allowed_pages','created_at','updated_at'])
const clean = Object.fromEntries(Object.entries(form).filter(([k]) => !STRIP.has(k)))
const r = await fetch('/api/profiles', {
  method: isNew ? 'POST' : 'PATCH',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
  body: JSON.stringify(isNew ? clean : { id: profile.id, ...clean }),
})
```

**Switch** (`src/context/ProfileContext.jsx`): `selectedProfileId` is initialized from
`localStorage` (`scalesolo.profile.selectedId`). `refresh()` queries
`profile_access.select('role, allowed_pages, profiles ( * )')` and attaches `_role` / `_allowed_pages`.
`setSelectedProfileId(id)` updates state and writes `localStorage`. After creating a brand, the page
calls `refresh()` then `setSelectedProfileId(newId)` so it becomes active. (Full RBAC details are in
`docs/frontend-architecture-and-design.md`.)

---

## 5. The brand "bible" and auto-learned voice

The bible is the brand's voice source of truth. `brand_bible` (long-form text) is the core, backed
by structured fields (`preferred_tone`, `target_audience`, `brand_cta`, `do_not_say`,
`always_include`) and a short `brand_bible_summary`. Three import paths fill it: paste
(`/api/profiles/parse-bible`), copy-a-prompt + paste-JSON, and an 8-question interview that bakes
answers into a starter bible. On save the API embeds bible chunks (`indexBrandBible`) for semantic
retrieval.

**Auto-learned voice** (`api/cron/distill-brand-voice.js`, daily `0 6 * * *`): for each brand with
new rated feedback, it pulls the freshest approved (`rating=1`) and rejected (`rating=-1`) scripts
and hooks (up to 30 each; skips if fewer than 3 total), and asks a "brand voice analyst" model for
strict JSON `{ summary, liked_patterns, disliked_patterns }`. It then rotates the active row in
`brand_voice_summaries` (deactivate the old, insert the new with `is_active: true` and `sample_size`).

**How it is used**: `api/_lib/brand-context.js` `loadBrandContext(profileId)` loads the profile
fields plus the active `brand_voice_summaries` row, and `renderBrandContextMarkdown(ctx)` assembles
an on-brand context block (identity, bible, distilled summary, exemplars, hooks, bad patterns, rules,
visual style). Caption generation (`api/content/caption-fanout.js`) and the main content generator
(`api/content/generate.js`) inject that markdown into their system prompts, so every generated
caption/script matches the brand without re-deriving the voice from raw examples each call.

```js
// api/content/caption-fanout.js
const brandCtx = await loadBrandContext(profile_id).catch(() => null)
const brandMd  = brandCtx ? renderBrandContextMarkdown(brandCtx) : ''
```

This is the link back to the scheduling system: the brand profile is where `default_platforms`,
`timezone`, `tiktok_force_direct_post`, `uploadpost_user`, and the voice all come from when a post
is generated and published.
