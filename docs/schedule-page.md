# Schedule Page

Route `/schedule` -> `src/pages/Content.jsx` (the file is named `Content.jsx` for historical
reasons; the page is branded "Schedule"). This is the single surface for a brand's content
pipeline: connect accounts, bulk-upload media, auto-caption and schedule, review/approve, and see
everything on a calendar. For how a post actually publishes, see
`docs/upload-post-scheduling-system.md`.

Supporting components: `src/components/BulkUploadView.jsx`, `src/components/SocialAccountsPanel.jsx`,
`src/components/MediaLightbox.jsx`.

---

## 1. Layout

The page is scoped to one brand via `selectedProfileId` from `useProfile()`; with no brand selected
it shows a "Pick a brand profile to manage content." card. Top to bottom (desktop):

1. **`<SocialAccountsPanel>`**: connections + posting defaults (on mobile this collapses to an
   `<h1>Schedule</h1>` plus an "Autopilot on" link to `/schedule/connections`).
2. **Tab bar**: the `TABS` array as pill buttons, with a pending-count badge on Approvals.
3. **Active view**: `BulkUploadView` (All), `CalendarView` (Calendar), or `ItemList` (Drafts/Approvals).
4. **Modals**: `GenerateModal` and the `ItemDetail` drawer (opened via `opened` state).

A `useIsMobile()` hook drives mobile/desktop forks throughout.

---

## 2. Tabs

```js
// Content.jsx
const TABS = [
  { value: 'library',   label: 'All',       icon: Library,        filter: 'library'   },
  { value: 'calendar',  label: 'Calendar',  icon: Calendar,       filter: 'calendar'  },
  { value: 'drafts',    label: 'Drafts',    icon: FileEdit,       filter: 'drafts'    },
  { value: 'approvals', label: 'Approvals', icon: ClipboardCheck, filter: 'approvals' },
]
```

- **Default tab is `calendar`** (the primary surface), not the first array element.
- **All** renders `<BulkUploadView>` (the bulk-upload + manage table; it owns its own fetch).
- **Calendar** renders `<CalendarView>`.
- **Drafts / Approvals** render `<ItemList>`.
- `refresh()` fetches `GET /api/content?profile_id=...&filter=<tab.filter>`; a separate
  `refreshPending()` fetches `filter=approvals` to drive the Approvals badge.

Status sub-filters inside `BulkUploadView` (the `STATUS_TABS` array, default `queued`):

```js
const STATUS_TABS = [
  { id: 'queued',    label: 'Queued Posts', filter: (s) => ['draft','caption_ready','scheduled'].includes(s.status) },
  { id: 'error',     label: 'Error',        filter: (s) => s.status === 'failed' },
  { id: 'delivered', label: 'Delivered',    filter: (s) => s.status === 'posted' },
]
```

Plus a post-kind chip row (`all | video | image | text`) and a date-range + sort row. The `visible`
memo applies tab filter, then kind, then date range, then text search, then sort.

---

## 3. Social accounts panel (`SocialAccountsPanel.jsx`)

Props `{ profileId, token }`. Exports `SOCIAL_PLATFORMS`: tiktok, instagram, youtube, x, threads,
linkedin, facebook, pinterest.

**Two data sources** (an important detail):
- **Connection status** comes from the Upload-Post profile: `GET /api/social/profiles?profile_id=...`,
  with `connectedIds` derived from `profile.social_accounts` (entries that are `true` or carry
  `access_token`/`connected`/`username`).
- **Posting defaults** live on the **ScaleSolo** `profiles` row (via `useProfile()`):
  `default_platforms` (array) and `tiktok_force_direct_post` (bool).

**Global platform selector, auto-saves with no Save button**: `toggleDefault(id)` updates local
state and `persist()` debounces 500ms then `PATCH /api/profiles?id=<profileId>` with
`{ default_platforms, tiktok_force_direct_post }`, showing a "Saving / Saved" hint (`autoStatus`).
An empty stored `default_platforms` means "all connected" (the scheduler fallback); the first toggle
materializes the full connected list before flipping, and it refuses to drop to empty.

```js
// SocialAccountsPanel.jsx, debounced auto-save, next values passed explicitly (no stale closure)
saveTimer.current = setTimeout(async () => {
  const r = await fetch(`/api/profiles?id=${profileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ default_platforms: nextDefaults, tiktok_force_direct_post: nextDirect }),
  })
  // ...setAutoStatus('saved'); refreshProfiles()
}, 500)
```

**Connect-link flow** ("Add / manage"): `POST /api/social/profiles?action=jwt` with
`{ profile_id, redirect_url: window.location.href }`, then `window.open(body.access_url)` so the user
connects on Upload-Post's hosted page and returns to hit Refresh.

```js
const r = await fetch('/api/social/profiles?action=jwt', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ profile_id: profileId, redirect_url: window.location.href }),
})
const body = await r.json()
window.open(body.access_url, '_blank', 'noopener')
```

**TikTok direct-post toggle** (only when TikTok is connected): a checkbox bound to
`tiktok_force_direct_post`, "Post to TikTok straight to the public feed (instead of leaving a draft
in the TikTok app)". Pills: connected+on = green check, connected+off = muted + green dot,
not-connected = dashed border that routes to the connect flow.

---

## 4. BulkUploadView table

Columns: select, **Media**, **Title**, **Caption**, **Hashtags** (hidden on tablet), **1st comment**
(hidden on tablet), **Scheduled**, **Status**, actions. On phones the table becomes a card list.

- Title/Caption/Hashtags/1st-comment are inline `<EditableCell>`s that `PATCH /api/content?id=...` on
  blur (and surface a "Schedule updated" toast when the server reports `upload_post_resynced`).
- Text posts with per-platform variants use `<PerPlatformCaptionCell>` (caps:
  `{ x:280, threads:500, facebook:5000, linkedin:3000 }`) saving the `per_platform_text` jsonb.
- **Scheduled** is a `datetime-local` input (UTC<->local conversion).
- **Status** is a `<StatusPill>`; failed rows show the Upload-Post error on hover.

Bulk action bar ("Select All (N)" plus):

| Button | Endpoint |
|---|---|
| Generate Captions | `POST /api/content/bulk-actions?action=generate-captions` |
| Auto Schedule | `...?action=auto-schedule` |
| Approve Selected | per-id `POST /api/content?id=...&action=approve` (concurrency 3) |
| Publish Selected | `...?action=publish-selected` (confirm first) |
| Resync Scheduled | `...?action=resync-upload-post` (confirm first) |
| Delete N | per-id `DELETE /api/content?id=...` |
| Export CSV | client-side CSV blob |

Bulk endpoints post `{ profile_id, script_ids: [...] }` and compose a summary toast from the
response (`updated` / `scheduled` / `submitted` / `resynced`, plus any `transcript_failures`).

**Autopilot bulk upload panel**: a drag-and-drop card (accepts `video/*,image/*`) with three sticky
(localStorage) toggles: **Autopilot** (after upload, auto-run captions then auto-schedule),
**Polish video** (shares the brand `polish_template` with the Spaces "Finish video" node), and
**Generate cover** (needs a cover template). Upload flow: each file goes to the Supabase
`landing-media` bucket, a `content_scripts` row is created (`status:'draft'`, `generated_by:'bulk'`,
platforms pre-filled from brand defaults filtered by media kind), and `runAutoPipeline` sequences
`captions -> covers -> polish -> embed -> schedule`. Live values are read through refs
(`tokenRef`, `polishTemplateRef`, `coverEnabledRef`, ...) to survive long async runs and token
rotation (documented stale-closure guards; do not remove them).

---

## 5. Per-post editor (`ItemDetail`, in `Content.jsx`)

Opens when a row/card is clicked. Two columns when the post has media: preview left, editor right.

**Caption + hashtags autosave (savedRef + debounce)**: `captionDraft` / `hashtagsDraft` /
`firstCommentDraft` / `ttOverride` are compared to `savedRef.current` so autosave and the Save button
never loop and never need a refetch to settle. `saveCaption({silent})` does
`PATCH /api/content?id=...` with `{ caption, hashtags: limitHashtags(..,5), first_comment,
tiktok_direct_override }` then updates `savedRef`. Autosave is debounced ~900ms and gated to
non-live rows (`autosaveEligible = !['scheduled','posted'].includes(item.status)`), so a scheduled or
posted row saves only via the explicit button (to avoid churning the Upload-Post job).

```js
const savedRef = useRef({ caption: item.caption || '', hashtags: item.hashtags || '', first_comment: item.first_comment || '', tt: ttSaved })
const captionDirty = captionDraft !== savedRef.current.caption
  || hashtagsDraft !== savedRef.current.hashtags
  || firstCommentDraft !== savedRef.current.first_comment
  || ttOverride !== savedRef.current.tt
const autosaveEligible = !['scheduled', 'posted'].includes(item.status)
useEffect(() => {
  if (!autosaveEligible || !captionDirty) return
  autoTimer.current = setTimeout(() => { saveCaption({ silent: true }) }, 900)
}, [captionDraft, hashtagsDraft, firstCommentDraft, ttOverride])
```

**Schedule button + no-caption guard**: a `datetime-local` (`scheduledAt`) and a Schedule button that
saves if dirty, then `action('schedule', { scheduled_datetime: new Date(scheduledAt).toISOString() })`.
Disabled when `busy || !scheduledAt || !captionDraft.trim()`, with an inline red alert when the
caption is empty: "Add a caption before this can be scheduled." (This is the front-end half of the
no-caption guard; the backend returns `422 code:'no_caption'` as a backstop.)

**`action(verb, body)`** hits `POST /api/content?action=<verb>&id=...` for approve/reject/schedule and
`DELETE /api/content?id=...` for delete.

**`tiktok_direct_override` toggle** (only when the post targets TikTok): three pills mapping to `null`
(brand default), `true` (direct to feed), `false` (draft/inbox), persisted via `saveCaption`.

**Status pill values** (`STATUS_PILL`): `draft` -> "Draft" (gray), `caption_ready` -> "Caption ready"
(amber), `scheduled` -> "Scheduled" (blue), `posted` -> "Posted" (green), `failed` -> "Failed" (red).
Note a deliberate divergence: `BulkUploadView`'s pill labels `posted` as "Published".

Also inside the editor: a cover-image generator (`/api/content/generate-cover` + poll
`/api/images/status`) and an `embed_cover_intro` toggle (`/api/videos/prepend-cover`).

---

## 6. Calendar view (`CalendarView`)

Desktop is a 7-column month grid; mobile is an agenda list.

- **Header**: month title, "Generate content for the month" (opens `GenerateMonthModal`), a
  **Review queue** link (`<a href="/schedule/queue">`, the swipe queue), and Today / prev / next steppers.
- **"Waiting to schedule" tray**: the backlog, loaded from `GET /api/content?profile_id=...&filter=unscheduled`,
  filtered to rows with media or text. Desktop shows it as a sticky 250px left column ("Waiting to
  schedule, N"); each card is draggable.
- **Drag to schedule**: the brand posting schedule is loaded from `/api/profiles`; `openSlotsFor(day)`
  computes unfilled future times. Dropping a backlog card on a slot optimistically moves it, resolves
  platforms (falling back to `/api/account/uploadpost-connected`), then `PATCH /api/content?id=...`
  (time + platforms) followed by `POST /api/content?action=approve`, rolling back on failure.
  Rescheduling an existing post is an optimistic `PATCH` with the new ISO.
- Day cells show per-post thumbnails (preferring `cover_image_url`), color-coded left borders by
  kind/status (posted green, pending-approval amber dashed, video blue, text amber, image purple);
  posted rows are not draggable.

---

## 7. API endpoints the page uses

- `GET /api/content?profile_id=...&filter=library|calendar|drafts|approvals|unscheduled` : lists
- `POST /api/content?action=approve|schedule|reject&id=...` : per-post lifecycle
- `PATCH /api/content?id=...` : field saves / reschedule (auto-resyncs the Upload-Post job)
- `DELETE /api/content?id=...` : delete
- `POST /api/content` : create a `content_scripts` row on upload
- `POST /api/content/bulk-actions?action=generate-captions|auto-schedule|publish-selected|resync-upload-post`
- `POST /api/content/generate` : single-item generate
- `POST /api/content/generate-cover` + `GET /api/images/status` : covers
- `POST /api/videos/polish`, `POST /api/videos/prepend-cover` : video processing
- `GET /api/social/profiles?profile_id=...`, `POST /api/social/profiles?action=jwt` : connection state + connect link
- `PATCH /api/profiles?id=...` : brand defaults (posting platforms, templates)
- `GET /api/profiles` : posting schedule + platforms
- Supabase Storage direct upload to the `landing-media` bucket

---

## 8. Gotchas

- The **All** tab maps to the `library` filter and renders the bulk-upload table, not a plain list
  (historical naming).
- Posting defaults and connection state come from **two different records** (the ScaleSolo `profiles`
  row vs the Upload-Post profile); an empty `default_platforms` means "all connected."
- Two status-pill maps exist with one label divergence: `posted` is "Posted" in `Content.jsx` and
  "Published" in `BulkUploadView.jsx`.
- Pipeline-critical values are mirrored into refs to survive long async runs and token rotation;
  editing those flows without the refs reintroduces stale-closure bugs.
