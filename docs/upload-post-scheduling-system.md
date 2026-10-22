# Scheduling and Posting System (Upload-Post): Architecture and Port Guide

How ScaleSolo connects client social accounts, schedules posts, publishes them through
[Upload-Post](https://docs.upload-post.com/api), and keeps status in sync. Written so you
can reimplement the same system in another app. It documents the real Upload-Post API
calls (so you can port to any stack) and shows ScaleSolo's wiring as the reference.

Reference files in this repo:
- `api/_lib/uploadpost.js`: the Upload-Post API client (auth, users, JWT, schedule list/cancel/edit, unpublish)
- `api/social/profiles.js`: per-brand Upload-Post user + the connect-link (JWT) endpoint
- `api/social/upload-post.js`: the submit handler (builds and sends the actual post)
- `api/content.js`: app-facing CRUD + `approve` / `schedule` actions that trigger a submit
- `api/cron/sync-scheduled-posts.js`: polls Upload-Post status and flips rows to posted/failed
- `api/account/uploadpost-connected.js`: reads which platforms a brand has connected
- `api/_lib/notify.js`: emits the in-app `post.published` / `post.scheduled` signals

---

## 1. Mental model

1. **One Upload-Post "user profile" per client brand.** Upload-Post is white-label: under
   one master API key you create many sub-accounts ("user profiles"), one per client. Each
   client connects their own TikTok / Instagram / YouTube / etc. to their own sub-account.
2. **You never touch client OAuth tokens.** Upload-Post holds them. You send a client a
   hosted "connect" link (a short-lived JWT URL); they authorize their platforms there.
3. **Publishing is one multipart POST** to Upload-Post with the media, the caption, the list
   of target platforms, and (optionally) a `scheduled_date`. Upload-Post fans it out to every
   platform and, if scheduled, fires it at the right time on its side.
4. **You keep a local row per post** (`content_scripts`) so the post shows on your calendar
   and so you can reconcile status. Upload-Post is the source of truth for delivery; your DB
   is the source of truth for the plan and the copy.

```
client brand (profiles row)
   └─ Upload-Post user profile  (sub-account, 1:1 with the brand)
        └─ connected platforms   (tiktok, instagram, youtube, ... via the connect link)

a post (content_scripts row)
   └─ POST /api/upload|upload_photos|upload_text   → request_id (+ job_id if scheduled)
        └─ Upload-Post delivers to each platform    → post_url per platform
             └─ status poll flips your row to posted/failed
```

---

## 2. Prerequisites

- An Upload-Post account with a **master API key**. Auth header on every call is
  `Authorization: Apikey <KEY>` (note the literal word `Apikey`, not `Bearer`).
- Base URL: `https://api.upload-post.com`
- One environment variable: `UPLOADPOST_API_KEY`.

```js
// api/_lib/uploadpost.js
const BASE = 'https://api.upload-post.com'
function key() {
  const k = process.env.UPLOADPOST_API_KEY
  if (!k) throw new Error('UPLOADPOST_API_KEY not configured')
  return k
}
```

The single fetch wrapper used by everything (JSON in, JSON out, throws on non-2xx):

```js
export async function uploadpost(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const init = {
    method,
    headers: { Authorization: `Apikey ${key()}`, Accept: 'application/json', ...headers },
  }
  if (body !== undefined) {
    if (body instanceof FormData) {
      init.body = body                 // let fetch set the multipart boundary
    } else {
      init.body = typeof body === 'string' ? body : JSON.stringify(body)
      if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json'
    }
  }
  const r = await fetch(`${BASE}${path}`, init)
  if (raw) return r
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const err = new Error(data?.message || data?.error || `Upload-Post ${path} -> ${r.status}`)
    err.status = r.status; err.response = data
    throw err
  }
  return data
}
```

---

## 3. One Upload-Post user per client (hooking client accounts)

Each brand maps to a stable Upload-Post username. ScaleSolo derives it from the brand's UUID
so no extra column is needed, with an optional manual override for brands that already own an
Upload-Post handle.

```js
// scalesolo_ + first 12 hex chars of the brand UUID. Stable and unique account-wide.
export function deriveUploadPostUsername(profileId) {
  if (!profileId) return ''
  const hex = String(profileId).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12)
  return `scalesolo_${hex}`
}

// Honor an explicit profiles.uploadpost_user override, else fall back to derived.
export async function resolveUploadpostUser(profileId) {
  const rows = await supaFetch(`profiles?id=eq.${profileId}&select=uploadpost_user`)
  const explicit = rows?.[0]?.uploadpost_user
  return (explicit && explicit.trim()) || deriveUploadPostUsername(profileId)
}
```

User-profile endpoints:

| Action | Call |
|---|---|
| Get one | `GET /api/uploadposts/users/<username>` |
| List all | `GET /api/uploadposts/users` |
| Create | `POST /api/uploadposts/users` body `{ username }` |

Idempotent "ensure it exists" (call this before generating a connect link or posting):

```js
export async function uploadpostEnsureUserProfile(username) {
  try {
    const data = await uploadpostGetUserProfile(username)
    if (data?.profile) return data.profile
  } catch (e) {
    if (e.status !== 404) throw e
  }
  const created = await uploadpostCreateUserProfile(username)
  return created.profile || { username, social_accounts: {} }
}
```

A user profile object carries a `social_accounts` map that tells you what is connected:

```jsonc
{
  "username": "scalesolo_ab12cd34ef56",
  "social_accounts": {
    "tiktok":    { "username": "@theclient", "connected": true },
    "instagram": { "username": "theclient",  "connected": true }
    // platforms the client has not connected are simply absent
  }
}
```

Reading connected platforms (see `api/account/uploadpost-connected.js`): fetch the user
profile and read the keys of `social_accounts` (normalize aliases like `twitter` -> `x`).

---

## 4. Sending the connect link to a client

This is how a client links their own TikTok / IG / YouTube without you ever seeing a password.
You ask Upload-Post for a short-lived JWT, which returns a hosted `access_url`. You send that
URL to the client (email, SMS, in-app button). They open it, authorize each platform, and get
redirected back to your `redirect_url`.

```js
// api/_lib/uploadpost.js
export async function uploadpostGenerateJwt(username, opts = {}) {
  return uploadpost('/api/uploadposts/users/generate-jwt', {
    method: 'POST',
    body: { username, ...opts },   // opts: redirect_url, connect_title, connect_description, branding
  })
}
```

The endpoint that the app calls (`POST /api/social/profiles?action=jwt`):

```js
const username = await resolveUploadpostUser(profile_id)
await uploadpostEnsureUserProfile(username)              // must exist before JWT
const jwt = await uploadpostGenerateJwt(username, {
  redirect_url,                                          // where to send them after connecting
  connect_title: 'Connect your social accounts',
  connect_description: 'Link the platforms we should publish to.',
  ...(branding || {}),                                   // optional logo / colors (white-label)
})
return res.status(200).json({ username, access_url: jwt.access_url, duration: jwt.duration })
```

`access_url` is a hosted Upload-Post page valid for ~48h. To onboard a client:

1. Resolve/ensure their Upload-Post user.
2. Generate the JWT with your `redirect_url`.
3. Send them `access_url` (button in your dashboard, or paste into an email/text).
4. They connect their platforms; poll the user profile (step 3) to confirm what connected.

To let a client manage/disconnect later, generate a fresh link the same way.

---

## 5. Minimal data model

You need two tables. ScaleSolo names them `profiles` (a brand) and `content_scripts` (a post).

**Brand (`profiles`)**: the fields that matter for posting:

| column | purpose |
|---|---|
| `id` (uuid) | brand id, also seeds the Upload-Post username |
| `uploadpost_user` (text, nullable) | manual override of the derived username |
| `default_platforms` (text[]) | platforms new posts target by default |
| `uploadpost_platforms` (text[]) | platforms actually connected on Upload-Post (synced copy) |
| `timezone` (text) | brand local zone, used when formatting schedule times |
| `tiktok_force_direct_post` (bool) | post straight to the TikTok feed vs leaving a draft in the TikTok app |

**Post (`content_scripts`)**: the fields that matter:

| column | purpose |
|---|---|
| `id` (uuid) | post id |
| `profile_id` | brand FK |
| `caption` (text) | the caption |
| `hashtags` (text) | `#a #b` string, kept separate from caption |
| `full_script` (text) | raw transcript/source (never sent as the caption) |
| `title` (text) | title (YouTube title, filename, etc.) |
| `media_urls` (text[]) | the media (video url at [0], or photo bundle) |
| `media_type` (text) | `video` / `image` / `text` |
| `platforms` (text[]) | per-post target platforms (can inherit brand defaults) |
| `status` (text) | `draft` / `caption_ready` / `scheduled` / `posted` / `failed` |
| `scheduled_datetime` (timestamptz) | the slot it should go live |
| `uploadpost_request_id` (text) | returned by the submit; used for status polling |
| `uploadpost_job_id` (text) | Upload-Post internal id; used to edit/cancel a scheduled job |
| `tiktok_direct_override` (bool, nullable) | per-post override of the brand TikTok mode |
| `last_error`, `last_error_at` | surfaced failure reason |

Delivery truth (post_url per platform, posted/failed) lives on Upload-Post and is reconciled
back by the status cron (section 8). You do not need a separate per-platform table.

---

## 6. Publishing a post (the core submit)

One multipart POST. The endpoint depends on media type:

| Media | Endpoint |
|---|---|
| Video | `POST /api/upload` |
| Photos | `POST /api/upload_photos` |
| Text only | `POST /api/upload_text` |

```js
// api/social/upload-post.js
const endpoint = `https://api.upload-post.com/api/${isText ? 'upload_text' : isVideo ? 'upload' : 'upload_photos'}`
const r = await fetch(endpoint, {
  method: 'POST',
  headers: { Authorization: `Apikey ${apiKey}` },   // do NOT set Content-Type; fetch sets the boundary
  body: fd,                                          // FormData
})
const body = await r.json()                          // -> { request_id, ... }
```

### 6a. Building the FormData

Common fields, then per-platform overrides. `user` is the Upload-Post username (the brand's
sub-account). `platform[]` is repeated once per target.

```js
const fd = new FormData()
fd.append('user', effectiveUser)                     // resolveUploadpostUser(profile_id)
for (const p of platforms) fd.append('platform[]', p)
if (fullCaption) fd.append('description', trim(fullCaption, 5000))   // caption + hashtags merged
fd.append('title', trim(cleanTitle, 100))
```

`fullCaption` is `caption` + `\n\n` + `hashtags`, trimmed. Important: never fall back to the raw
transcript or the filename for the caption. If caption is empty, send empty and block the post
upstream (see section 7), otherwise junk like `[outro jingle]` reaches a real feed.

Per-platform copy (each platform takes its own title/description field so you can tune wording):

```js
if (platforms.includes('tiktok')) {
  fd.append('tiktok_title', tiktokTitle)             // TikTok caption
  // Feed vs inbox draft (see gotchas):
  if (tiktokDraftMode) fd.append('post_mode', 'MEDIA_UPLOAD')   // leaves a draft in the TikTok app
  // else it posts straight to the public feed
}
if (platforms.includes('instagram')) {
  fd.append('instagram_title', trim(fullCaption || cleanTitle, 2200))
  if (cover_image_url) fd.append('instagram_cover_url', String(cover_image_url))  // Reel thumbnail
}
if (platforms.includes('facebook')) {
  fd.append('facebook_title', trim(fbTitleSource, 240))         // FB caps the title ~255
  fd.append('facebook_description', trim(fullCaption || cleanTitle, 5000))
}
if (platforms.includes('youtube')) {
  fd.append('youtube_title', trim(cleanTitle, 100))
  fd.append('youtube_description', trim(fullCaption || cleanTitle, 5000))
  if (youtube_thumbnail_url) fd.append('youtube_thumbnail', String(youtube_thumbnail_url))
}
if (platforms.includes('linkedin')) {
  fd.append('linkedin_title', trim(fullCaption || cleanTitle, 3000))
  fd.append('linkedin_description', trim(fullCaption || cleanTitle, 3000))
}
if (platforms.includes('threads')) fd.append('threads_title', trim(threadsBody, 500))
if (platforms.includes('x') || platforms.includes('twitter')) fd.append('x_title', trim(fullCaption, 25000))
if (platforms.includes('pinterest')) {
  fd.append('pinterest_title', trim(cleanTitle, 100))
  fd.append('pinterest_description', trim(fullCaption, 800))
}
// Optional pinned first comment (where supported):
if (firstCommentResolved) fd.append('first_comment', trim(firstCommentResolved, 1000))
```

Note: Upload-Post expects `x`, not `twitter`. Normalize `twitter` -> `x` before appending, or
`/upload_text` rejects the batch as "Invalid platforms".

### 6b. Attaching media

```js
if (isText) {
  // Text post: optional per-platform variants, else `description` is the fallback.
  if (ppt.x)        fd.set('x_title',        String(ppt.x).slice(0, 280))
  if (ppt.threads)  fd.set('threads_title',  String(ppt.threads).slice(0, 500))
  // ...facebook, linkedin
} else if (isVideo) {
  // Pass the video as a URL. Upload-Post fetches it itself (correct Content-Type, no
  // re-upload through your function's body limit). async_upload processes it in the
  // background so slow platforms do not block your request.
  fd.append('video', video_url)
  fd.append('async_upload', 'true')
} else {
  // Photos: upload bytes as blobs. For TikTok, convert each slide to a TikTok-safe JPEG
  // (TikTok rejects PNG). Other platforms get the original bytes.
  for (let i = 0; i < photos.length; i++) {
    const blob = platforms.includes('tiktok')
      ? await fetchTikTokSafeJpeg(photos[i])
      : await fetchToBlob(photos[i])
    fd.append('photos[]', blob, `photo-${i}.jpg`)
  }
}
```

### 6c. Immediate vs scheduled vs auto-slot

A `scheduling_mode` of `now`, `fixed`, or `auto` decides the slot:

- `now`: no `scheduled_date`, Upload-Post publishes immediately.
- `fixed`: you pass an explicit ISO timestamp.
- `auto`: you compute the next open slot from a posting schedule (skipping slots already taken
  by other scheduled rows), then treat it as fixed.

```js
if (resolvedScheduledIso) {
  fd.append('scheduled_date', resolvedScheduledIso)   // ISO 8601
  if (resolvedTimezone) fd.append('timezone', resolvedTimezone)
}
```

### 6d. Idempotency (post-once)

Publishing the same media to the same brand + same slot twice puts a duplicate on a real feed.
Before sending a media post, look for a row with the same `profile_id` + same media URL created
in the last 3 minutes that already has a `uploadpost_request_id`. If found for the same target
(same scheduled slot, or both immediate), return that prior job instead of posting again.
Fail-open: never let the guard block a legitimate post. Text posts are exempt (repeatable).

```js
if (!isText && !allow_duplicate) {
  const windowStart = new Date(Date.now() - 3 * 60_000).toISOString()
  const prior = (await supaFetch(
    `content_scripts?profile_id=eq.${profile_id}` +
    `&media_urls=cs.{"${dupMediaUrl}"}` +
    `&uploadpost_request_id=not.is.null&created_at=gte.${windowStart}` +
    `&order=created_at.desc&limit=1&select=id,uploadpost_request_id,uploadpost_job_id,scheduled_datetime`
  ))[0]
  const sameTarget = prior && (
    (scheduledIso && prior.scheduled_datetime === scheduledIso) ||
    (!scheduledIso && !prior.scheduled_datetime)
  )
  if (sameTarget) return res.json({ request_id: prior.uploadpost_request_id, deduped: true })
}
```

Related rule: **never auto-retry a failed post.** A retry loop double-posts or spams failures.
Surface the failure and let a human decide.

### 6e. The response: request_id, and backfilling job_id

The submit response gives you a `request_id` (your handle for status polling). It does **not**
return the `job_id` that Upload-Post's edit/cancel endpoints key on. For scheduled posts,
fetch the schedule list right after submit and match by time + title to capture `job_id`:

```js
// after a successful scheduled submit
for (const wait of [700, 1500]) {                     // most jobs index within ~1-2s
  await sleep(wait)
  const { posts } = await uploadpostListScheduled(username)
  const match = posts.find(j =>
    j.job_id &&
    Math.abs(Date.parse(j.scheduled_date) - Date.parse(scheduledIso)) < 60_000 &&
    (!j.title || j.title.toLowerCase().slice(0,40) === title.toLowerCase().slice(0,40))
  )
  if (match) { /* PATCH content_scripts.uploadpost_job_id = match.job_id */ break }
}
```

Store `request_id` always and `job_id` when you can. Persist the post as a `content_scripts`
row with `status` = `scheduled` (future ISO) or `posted` (immediate). If the submit succeeds
but the DB write fails, surface it loudly: the post is live but invisible in your UI, which
leads a user to re-submit and duplicate.

---

## 7. App-facing flow: draft -> approve -> submit

Users edit a draft, then approve/schedule it. `api/content.js` is the CRUD + action endpoint.
The submit handler is invoked **in-process** (not a public self-fetch) so there is no extra
network hop or auth dance:

```js
// api/content.js
import uploadPostHandler from './social/upload-post.js'
import { invokeHandler } from './_lib/internal-invoke.js'

// POST /api/content?action=approve&id=...  (or action=schedule)
// Guard: never schedule a media post with no caption.
if (scheduleFor && item.media_type !== 'text' && !String(item.caption || '').trim()) {
  await supaFetch(`content_scripts?id=eq.${id}`, {
    method: 'PATCH',
    body: { last_error: 'Not scheduled: add a caption first.', last_error_at: new Date().toISOString() },
  })
  return res.status(422).json({ error: 'This post has no caption. Add a caption before scheduling.', code: 'no_caption' })
}

// Build the submit body from the row and invoke the handler.
const body = {
  profile_id: row.profile_id,
  platforms,
  is_text_post: row.media_type === 'text' || undefined,
  video_url: isVideo ? videoToSend : undefined,
  photo_urls: (!isTextPost && !isVideo) ? mediaUrls : undefined,
  description: [row.caption, row.hashtags].filter(Boolean).join('\n\n').trim(),
  title: row.title || undefined,
  caption: row.caption || undefined,
  hashtags: row.hashtags || undefined,
  first_comment: row.first_comment || undefined,
  cover_image_url: row.cover_image_url || undefined,
  scheduling_mode: 'fixed',
  scheduled_iso: newScheduledIso,
  tiktok_direct_override: row.tiktok_direct_override ?? undefined,
  script_id: row.id,                // so the handler PATCHes THIS row, not a fuzzy match
}
const captured = await invokeHandler(uploadPostHandler, req, { method: 'POST', body })
```

The same `content.js` path also handles **rescheduling**: when a user moves an already-scheduled
post, it cancels the old Upload-Post job (by stored `job_id`, falling back to a time+title match)
and resubmits at the new time. Prefer Upload-Post's in-place `PATCH` of a scheduled job for pure
time moves (atomic), which avoids the window where a cancel misses but the resubmit still fires.

---

## 8. Keeping status in sync (the scheduler reconcile)

Scheduling happens on Upload-Post's side, so you poll. A cron (every ~10 min) takes rows that
are `scheduled` (or recently submitted) and asks Upload-Post for status by `request_id`:

```js
// api/cron/sync-scheduled-posts.js
const r = await fetch(`https://api.upload-post.com/api/uploadposts/status?request_id=${requestId}`, {
  headers: { Authorization: `Apikey ${process.env.UPLOADPOST_API_KEY}` },
})
```

Status response shape and classification:

```jsonc
{
  "status": "completed" | "in_progress" | "failed",
  "results": [
    { "platform": "tiktok", "success": true,  "post_url": "https://www.tiktok.com/@.../video/123" },
    { "platform": "youtube","success": false, "error_message": "..." }
  ]
}
```

- Mark the row **`posted`** when **any** platform succeeded (partial completion counts, so a
  slow platform does not hold the row open forever).
- Mark **`failed`** only when **every** platform failed.
- A TikTok "success" whose `post_url` contains `inbox` means it landed as a draft in the TikTok
  app, not the public feed. Treat that as its own state, not a clean feed delivery.

When a row flips to `posted`, emit a `post.published` signal with the live `post_url`, platform,
and brand (ScaleSolo writes it to a `notifications` table that the SPA reads over Realtime; this
is also the exact hook the post-caption watchdog listens to). See `api/_lib/notify.js`.

---

## 9. Edit, cancel, unpublish

All keyed on the Upload-Post job/post ids, all fail-soft on 404:

| Operation | Call | Notes |
|---|---|---|
| List scheduled | `GET /api/uploadposts/schedule` | Returns `scheduled_posts[]` under the master key; filter by `profile_username` in code |
| Edit scheduled (move time) | `PATCH /api/uploadposts/schedule/<job_id>` body `{ scheduled_date }` | Atomic; preferred over cancel+resubmit |
| Cancel scheduled | `DELETE /api/uploadposts/schedule/<job_id>` | Use the stored `job_id`; recover it by time+title match for legacy rows |
| Unpublish a live post | `DELETE /api/uploadposts/posts/unpublish` body `{ platform, user, post_id }` | Supported: facebook, youtube, x, linkedin, threads. NOT instagram or tiktok (manual only). `post_id` is the platform's id from `post_url` |

---

## 10. Platform gotchas (learned in production)

- **TikTok feed vs inbox.** Default posts straight to the public feed. Set `post_mode` =
  `MEDIA_UPLOAD` to instead leave a draft in the TikTok app (safer for review, but someone must
  tap Post in the app). ScaleSolo exposes this as a per-brand `tiktok_force_direct_post` with a
  per-post `tiktok_direct_override`.
- **TikTok photos must be JPEG.** PNG is rejected. Convert each slide before upload.
- **Facebook caption cap.** Keep the FB title near 240 to 255 chars.
- **Stories.** Instagram supports Stories (photo + video) with `media_type=STORIES` (UPPERCASE
  PLURAL; lowercase silently falls back to feed). Facebook Stories: video only. TikTok Stories:
  not possible. `media_type` is global to the request, not per-platform.
- **`twitter` vs `x`.** Always send `x`.
- **Post once.** Dedup before sending and never auto-retry a failure.
- **Video by URL, photos by bytes.** Pass video as a `video` URL with `async_upload=true`; send
  photos as `photos[]` blobs.
- **Captions.** Keep caption and hashtags in separate fields; merge into `description` at send
  time; never fall back to a transcript or filename for the caption.

---

## 11. Environment variables

```bash
UPLOADPOST_API_KEY=            # master Upload-Post API key (server-side only)
```

Everything else (which platforms, timezones, posting schedule) is per-brand data in your DB.

---

## 12. Port checklist (stripped to essentials)

1. Store `UPLOADPOST_API_KEY` server-side. Build the one `uploadpost()` fetch wrapper (section 2).
2. Give every client a stable Upload-Post username; `ensureUserProfile` before first use (section 3).
3. Add a "Connect accounts" button: `POST /users/generate-jwt`, hand the client `access_url`
   with your `redirect_url` (section 4). Poll the user profile to see what connected.
4. Create two tables: brand and post (section 5).
5. Publish by building the multipart FormData and POSTing to `/upload` | `/upload_photos` |
   `/upload_text`, with `scheduled_date` for future posts (section 6). Capture `request_id`,
   backfill `job_id`, write a local row.
6. Add the no-caption guard and the 3-minute dedup guard (sections 6d, 7).
7. Poll `GET /uploadposts/status?request_id=...` on a cron; flip rows to posted/failed; read
   `post_url` per platform (section 8).
8. Wire edit/cancel/unpublish on the job/post ids (section 9).
9. Respect the platform gotchas (section 10).

That is the whole system. The Upload-Post calls are the portable core; the rest is your own
queue, UI, and reconciliation around them.
