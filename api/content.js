// /api/content — CRUD for content_scripts.
//   GET ?profile_id=...&filter=library|drafts|scheduled|approvals|posted
//   GET ?id=...
//   POST { profile_id, ... }
//   PATCH ?id=... { ... }
//   DELETE ?id=...
//
// Special POSTs:
//   POST ?action=approve   ?id=...                 → approval_status=approved
//   POST ?action=reject    ?id=...  { reason? }    → approval_status=rejected
//   POST ?action=schedule  ?id=...  { scheduled_datetime, platforms? }

import { setCors, requireUser, supaFetch, assertProfileAccess, assertMinRole } from './_lib/supabase.js'
import { findNextOpenSlot, syncContentStatusInSpaces } from './_lib/scheduling.js'
import { uploadpostCancelByRequestId, uploadpostCancelScheduled, uploadpostJobIdViaScheduleMatch, uploadpostEditScheduled, uploadpostUnpublish, UNPUBLISH_SUPPORTED_PLATFORMS, uploadpost, resolveUploadpostUser } from './_lib/uploadpost.js'
import uploadPostHandler from './social/upload-post.js'
import { invokeHandler } from './_lib/internal-invoke.js'

// Cancel an existing scheduled Upload-Post job and re-submit it with a
// new time. Called from the PATCH + action=schedule paths whenever the
// user moves an already-scheduled post to a different datetime. Without
// this, ScaleSolo's UI would show the new time but the actual post
// would still fire at the original moment (silent wrong-time bug).
//
// Strategy: cancel old → POST /api/social/upload-post via internal
// fetch with the row's existing media + caption + platforms + the new
// scheduled_iso. The upload-post endpoint handles all the per-platform
// fan-out + caption mapping logic so we don't duplicate it here.
//
// Returns the new uploadpost_request_id, or null if there was nothing
// to reschedule (no prior job, no media, etc.). Failures are surfaced
// so the caller can decide whether to block the local DB update.
async function rescheduleUploadPostJob({ row, newScheduledIso, authToken, req }) {
  // Pre-flight: row must have all the pieces a fresh upload-post call
  // would need. If any are missing (older row, never actually scheduled
  // through us), skip the upload-post round trip entirely — the local
  // PATCH still happens so the user's view is consistent.
  const platforms = Array.isArray(row.platforms) ? row.platforms : null
  const mediaUrls = Array.isArray(row.media_urls) ? row.media_urls : []
  // Text posts (media_type='text') go through Upload-Post's /upload_text
  // endpoint and intentionally carry no media_urls. Only bail on missing
  // media when the row is NOT a text post.
  const isTextPost = row.media_type === 'text'
  if (!platforms || !platforms.length) return null
  if (!mediaUrls.length && !isTextPost) return null

  // Cancel old job if there is one. Prefer the stored uploadpost_job_id
  // (direct DELETE — single API call, no list lookup) over the legacy
  // request_id flow (which scans the documented list endpoint that
  // doesn't return request_id). Retries 3x with backoff. If the cancel
  // doesn't succeed or 404 within those attempts we throw so the
  // caller surfaces a 502 instead of silently double-booking on
  // Upload-Post.
  if (row.uploadpost_job_id || row.uploadpost_request_id) {
    const username = await resolveUploadpostUser(row.profile_id)
    const MAX_ATTEMPTS = 3
    const BACKOFF_MS = [0, 1000, 2000]
    let cancelled = false
    let lastError = null
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !cancelled; attempt++) {
      if (BACKOFF_MS[attempt]) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]))
      try {
        let cancel
        if (row.uploadpost_job_id) {
          cancel = await uploadpostCancelScheduled(row.uploadpost_job_id)
        } else {
          cancel = await uploadpostCancelByRequestId(username, row.uploadpost_request_id)
          // Fallback for legacy rows: if request_id lookup returns
          // not_found, match by scheduled_datetime + title against
          // the documented list endpoint.
          if (!cancel.ok && (cancel.reason === 'not_found' || cancel.status === 404) && row.scheduled_datetime) {
            const matchedJobId = await uploadpostJobIdViaScheduleMatch(username, {
              scheduled_iso: row.scheduled_datetime,
              title: row.title,
            })
            if (matchedJobId) cancel = await uploadpostCancelScheduled(matchedJobId)
          }
        }
        if (cancel.ok) {
          cancelled = true
          break
        }
        if (cancel.status === 404 || cancel.reason === 'not_found') {
          cancelled = true
          break
        }
        lastError = cancel.reason || `status ${cancel.status}`
      } catch (e) {
        lastError = e?.message || String(e)
      }
    }
    if (!cancelled) {
      const handle = row.uploadpost_job_id
        ? `job_id=${row.uploadpost_job_id}`
        : `request_id=${row.uploadpost_request_id}`
      const err = new Error(
        `Couldn't cancel the previous Upload-Post job (${handle}): ` +
        `${lastError || 'unknown'}. Aborted to avoid duplicates. Try again in a moment.`
      )
      err.status = 502
      throw err
    }
  }

  // Build a fresh /api/social/upload-post body from the row + new time.
  // mediaUrls[0] is the canonical video when media_type is 'video';
  // otherwise everything is treated as a photo bundle. description is
  // the merged caption + hashtags string each platform expects.
  const isVideo = row.media_type === 'video' || /\.(mp4|mov|webm|m4v)(\?|#|$)/i.test(mediaUrls[0] || '')
  const fullCaption = [row.caption, row.hashtags].filter(Boolean).join('\n\n').trim()
  // Prefer the cover-embedded video when the toggle is on and the
  // embedded URL has been generated. Falls back to the raw source.
  const videoToSend = isVideo
    ? ((row.embed_cover_intro !== false && row.media_url_with_cover) ? row.media_url_with_cover : mediaUrls[0])
    : undefined

  const body = {
    profile_id: row.profile_id,
    platforms,
    // Text posts: skip the media url fields entirely and set the flag
    // that routes /api/social/upload-post to Upload-Post's /upload_text
    // endpoint. Otherwise pass video / photo media as before.
    is_text_post: isTextPost || undefined,
    video_url: isTextPost ? undefined : videoToSend,
    photo_urls: !isTextPost && !isVideo ? mediaUrls : undefined,
    description: fullCaption || row.full_script || row.title || '',
    title: row.title || undefined,
    caption: row.caption || undefined,
    hashtags: row.hashtags || undefined,
    // Text posts use per_platform_text variants for per-platform copy;
    // pass them through so /upload_text + Upload-Post's per-platform
    // suffix logic can apply the right variant per platform.
    per_platform_text: row.per_platform_text || undefined,
    script: row.full_script || undefined,
    first_comment: row.first_comment || undefined,
    // Custom Instagram Reel cover when one is set on the row.
    cover_image_url: row.cover_image_url || undefined,
    scheduling_mode: 'fixed',
    scheduled_iso: newScheduledIso,
    // Per-post TikTok mode override rides along so a reschedule keeps it.
    tiktok_direct_override: (row.tiktok_direct_override === true || row.tiktok_direct_override === false)
      ? row.tiktok_direct_override : undefined,
    // Force the upload-post endpoint to PATCH this row, not insert a
    // new one. Edits-on-scheduled-row often happen long after the
    // 5-min dedup window, which without script_id duplicates the row.
    script_id: row.id,
  }

  // Invoke the upload-post handler IN-PROCESS instead of self-fetching
  // through Vercel's public URL. This avoids the Deployment-Protection
  // SSO wall on preview deployments (which would otherwise 401 the
  // server-side fetch and surface as "upload-post resubmit 401" in the
  // UI). The synthetic req carries the user's existing auth headers so
  // upload-post's requireUser + billing checks all pass identically.
  const captured = await invokeHandler(uploadPostHandler, req, { method: 'POST', body })
  const resp = captured.body || {}
  if (captured.statusCode < 200 || captured.statusCode >= 300) {
    const msg = resp?.error || `upload-post resubmit ${captured.statusCode}`
    const err = new Error(msg)
    err.status = captured.statusCode
    throw err
  }
  return { request_id: resp.request_id || null, job_id: resp.job_id || null }
}

const ALLOWED = new Set([
  'title','hook','full_script','series_name','caption','hashtags','first_comment',
  'tags','media_urls','media_type','scheduled_datetime','status','sort_order',
  'post_type','location','platforms','cover_timestamp',
  'needs_approval','approval_status','rejected_reason','recycle_period_days',
  'tiktok_direct_override',
  'generated_by','generation_prompt','performance',
  // uploadpost_request_id is server-managed (set when the original
  // submission lands + rotated when we reschedule), but it lives in
  // ALLOWED so the reschedule handler can include it in the updates
  // payload alongside scheduled_datetime in one PATCH.
  'uploadpost_request_id',
  'uploadpost_job_id',
  // Per-platform text variants for text-only posts (text_post_gen
  // output). Editable inline on the Schedule page.
  'per_platform_text',
  // Generated Instagram cover image (gpt-image-2-image-to-image output).
  // Set by /api/content/generate-cover; passed to Upload-Post as
  // instagram_cover_url on submit.
  'cover_image_url',
  // Source video with the cover prepended as a 1s intro card. Built by
  // /api/videos/prepend-cover. Used for TikTok / YouTube / FB / Threads
  // so the cover survives platforms that auto-thumbnail from frame 0.
  'media_url_with_cover',
  // Per-row toggle for the prepend behavior.
  'embed_cover_intro',
])

function pickAllowed(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) if (ALLOWED.has(k)) out[k] = v
  return out
}

// Guard: only rows with real media attached are allowed in the scheduled
// queue. Without this, text-only generations (script_gen / caption_gen
// outputs that never got wired to a video or image upstream) silently
// land in the calendar as ghosts, often duplicated when the workflow
// re-runs. Returns true if media_urls is a non-empty array containing
// at least one truthy string.
function hasMedia(row) {
  const urls = row?.media_urls
  if (!Array.isArray(urls) || urls.length === 0) return false
  return urls.some((u) => typeof u === 'string' && u.trim().length > 0)
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const id = req.query.id
      if (id) {
        const rows = await supaFetch(`content_scripts?id=eq.${id}&select=*`)
        const item = rows?.[0]
        if (!item) return res.status(404).json({ error: 'Not found' })
        await assertProfileAccess(auth.user.id, item.profile_id)
        return res.status(200).json({ item })
      }
      const profileId = req.query.profile_id
      if (!profileId) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profileId)

      const filter = req.query.filter || 'library'
      let where = `profile_id=eq.${profileId}`
      if (filter === 'drafts')    where += '&status=eq.draft'
      if (filter === 'caption_ready') where += '&status=eq.caption_ready'
      // Backlog for the calendar's drag-to-schedule panel: posts that are
      // ready but have no time yet (draft or caption_ready, no slot). The
      // client further keeps only postable rows (has media or text-only).
      if (filter === 'unscheduled') where += '&status=in.(draft,caption_ready)&scheduled_datetime=is.null'
      if (filter === 'scheduled') where += '&status=eq.scheduled'
      if (filter === 'posted')    where += '&status=eq.posted'
      // Calendar view: show scheduled (queued), posted (delivered), AND
      // pending-approval drafts that have a scheduled_datetime. The
      // pending drafts are the new "intent" rows — they reserve a slot
      // on the calendar but won't fire on Upload-Post until approved.
      // The UI distinguishes them via approval_status='pending' vs the
      // green-pill scheduled rows.
      if (filter === 'calendar')  where += '&or=(and(status.in.(scheduled,posted),scheduled_datetime.not.is.null),and(status.eq.draft,approval_status.eq.pending,scheduled_datetime.not.is.null))'
      if (filter === 'approvals') where += '&approval_status=eq.pending'
      const order = (filter === 'scheduled' || filter === 'calendar') ? 'scheduled_datetime.asc' : 'updated_at.desc'
      const rows = await supaFetch(`content_scripts?${where}&order=${order}&limit=200&select=*`)
      return res.status(200).json({ items: rows || [] })
    }

    if (req.method === 'POST') {
      const action = req.query.action
      const id = req.query.id

      // ── Approve / reject / schedule actions ─────────────────────────────
      if (action && id) {
        // Pull the full row up front. The schedule action needs every
        // field (platforms, media_urls, caption, etc.) to re-submit
        // the Upload-Post job when rescheduling an existing post.
        const rows = await supaFetch(`content_scripts?id=eq.${id}&select=*`)
        const item = rows?.[0]
        if (!item) return res.status(404).json({ error: 'Not found' })
        // approve / reject / schedule mutate the posting pipeline — contributors are excluded.
        await assertMinRole(auth.user.id, item.profile_id, 'editor')

        let updates = {}
        let submittedRequestId = null
        if (action === 'approve') {
          updates = {
            approval_status: 'approved',
            needs_approval: false,
            approved_by: auth.user.id,
            approved_at: new Date().toISOString(),
            rejected_reason: null,
            status: item.status,
          }
          // Use the slot save_library reserved when it wrote the draft.
          // Only re-pick if the row never got a slot (legacy drafts that
          // predate the approval flow).
          let scheduleFor = item.scheduled_datetime
          if (!scheduleFor && hasMedia(item)) {
            try {
              const pr = await supaFetch(`profiles?id=eq.${item.profile_id}&select=timezone,posting_schedule`)
              const taken = await supaFetch(
                `content_scripts?profile_id=eq.${item.profile_id}&status=eq.scheduled&select=scheduled_datetime`
              )
              scheduleFor = findNextOpenSlot(pr?.[0], (taken || []).map((t) => t.scheduled_datetime))
            } catch (e) { console.warn('auto-schedule on approve failed:', e.message) }
          }
          if (scheduleFor && (hasMedia(item) || item.media_type === 'text')) {
            updates.scheduled_datetime = scheduleFor
            updates.status = 'scheduled'
            // Submit to Upload-Post NOW so approval = live. The user
            // explicitly chose Option A: approval immediately fires.
            // Upload-Post stores future-dated jobs fine — it'll fire at
            // scheduleFor regardless of when we submit.
            // Skip submission if the row already has an uploadpost_request_id
            // (re-approving something that was already submitted).
            if (!item.uploadpost_request_id) {
              try {
                const authToken = req.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
                // rescheduleUploadPostJob is named for the reschedule case
                // but its no-existing-request_id branch is exactly the
                // first-time-submit path: it builds the payload from
                // the row and POSTs to /api/social/upload-post.
                const mergedRow = { ...item, ...updates }
                const submitResult = await rescheduleUploadPostJob({
                  row: mergedRow,
                  newScheduledIso: scheduleFor,
                  authToken, req,
                })
                if (submitResult?.request_id) {
                  submittedRequestId = submitResult.request_id
                  updates.uploadpost_request_id = submitResult.request_id
                }
                if (submitResult?.job_id) updates.uploadpost_job_id = submitResult.job_id
              } catch (e) {
                // Surface the error so the toast says why it failed.
                // The DB row stays untouched on this path because we
                // return BEFORE running the PATCH below.
                return res.status(502).json({
                  error: `Approval failed at Upload-Post: ${e.message}`,
                  code: 'upload_post_failed',
                })
              }
            }
          }
        } else if (action === 'reject') {
          updates = {
            approval_status: 'rejected',
            needs_approval: false,
            approved_by: auth.user.id,
            approved_at: new Date().toISOString(),
            rejected_reason: req.body?.reason || null,
          }
        } else if (action === 'schedule') {
          if (!req.body?.scheduled_datetime) return res.status(400).json({ error: 'scheduled_datetime required' })
          // Block scheduling rows that have nothing to publish — no
          // media AND not a text-only post. Text-only rows (media_type
          // = 'text', set by save_library when manual_caption / text_post_gen
          // produced the bundle) are valid: publishSelected / cron sweeps
          // route them to Upload-Post's /upload_text endpoint.
          if (!hasMedia(item) && item.media_type !== 'text') {
            return res.status(400).json({
              error: 'Cannot schedule a post without media. Attach an image or video first.',
              code: 'missing_media',
            })
          }
          updates = {
            scheduled_datetime: req.body.scheduled_datetime,
            status: 'scheduled',
            platforms: req.body.platforms || null,
          }
          // If this row was ALREADY scheduled and is being moved to a
          // new time, update the Upload-Post job. Preferred path: PATCH
          // the existing job in place (atomic on their side, no window
          // where a missed cancel + successful resubmit double-books —
          // the failure mode behind past duplicate-post incidents).
          // Fallback: cancel + re-submit for rows without a stored
          // job_id or when the PATCH 404s (job already fired/pruned).
          // Brand-new schedules skip this — the initial submission is
          // owned by /api/social/upload-post directly.
          const wasScheduled = item.status === 'scheduled' && item.uploadpost_request_id
          const timeChanged = item.scheduled_datetime !== req.body.scheduled_datetime
          if (wasScheduled && timeChanged) {
            let patched = false
            if (item.uploadpost_job_id) {
              const edit = await uploadpostEditScheduled(item.uploadpost_job_id, {
                scheduled_date: req.body.scheduled_datetime,
              })
              patched = !!edit.ok
              if (!patched && edit.status !== 404) {
                console.warn('upload-post PATCH reschedule failed, falling back to cancel+resubmit:', edit.reason)
              }
            }
            if (!patched) {
              try {
                const submitResult = await rescheduleUploadPostJob({
                  row: item,
                  newScheduledIso: req.body.scheduled_datetime,
                  authToken: req.headers.authorization?.replace(/^Bearer\s+/i, '') || '',
                  req,
                })
                if (submitResult?.request_id) updates.uploadpost_request_id = submitResult.request_id
                if (submitResult?.job_id) updates.uploadpost_job_id = submitResult.job_id
              } catch (e) {
                return res.status(502).json({ error: `Reschedule failed on Upload-Post: ${e.message}` })
              }
            }
          }
        } else {
          return res.status(400).json({ error: `unknown action: ${action}` })
        }

        const updated = await supaFetch(`content_scripts?id=eq.${id}`, { method: 'PATCH', body: updates })
        if (updates.status) {
          syncContentStatusInSpaces(item.profile_id, id, updates.status).catch(() => {})
        }
        const finalRow = Array.isArray(updated) ? updated[0] : updated
        // For approve, also return the payload the UI needs to build a
        // confirmation toast ("Scheduled to TikTok, Instagram for ...")
        // without a second round trip.
        if (action === 'approve' && updates.status === 'scheduled') {
          return res.status(200).json({
            item: finalRow,
            scheduled: {
              scheduled_datetime: updates.scheduled_datetime,
              platforms: finalRow?.platforms || item.platforms || [],
              uploadpost_request_id: submittedRequestId || item.uploadpost_request_id || null,
            },
          })
        }
        return res.status(200).json({ item: finalRow })
      }

      // ── Plain create ────────────────────────────────────────────────────
      const body = req.body || {}
      if (!body.profile_id) return res.status(400).json({ error: 'profile_id required' })
      await assertMinRole(auth.user.id, body.profile_id, 'editor')
      const row = pickAllowed(body)
      row.profile_id = body.profile_id

      // ── Approval queue (status='draft' + request_slot=true) ─────────────
      // save_library writes drafts with request_slot=true. We pick the next
      // open slot, mark the row pending approval, and DO NOT submit to
      // Upload-Post. Row appears on the Schedule calendar with a "pending
      // approval" visual state; user clicks Approve to actually queue it.
      // Status stays 'draft' so the existing filter logic stays sane —
      // approval_status='pending' is the marker that puts it on the
      // calendar.
      if (row.status === 'draft' && body.request_slot === true && hasMedia(row)) {
        try {
          const profileRows = await supaFetch(`profiles?id=eq.${body.profile_id}&select=timezone,posting_schedule`)
          const profile = profileRows?.[0]
          // Skip slots already taken by ACTUAL scheduled posts AND by
          // other pending-approval drafts so we don't double-book the
          // same minute.
          const taken = await supaFetch(
            `content_scripts?profile_id=eq.${body.profile_id}&or=(status.eq.scheduled,and(status.eq.draft,approval_status.eq.pending))&scheduled_datetime=not.is.null&select=scheduled_datetime`
          )
          const slot = findNextOpenSlot(profile, (taken || []).map((t) => t.scheduled_datetime))
          if (slot) {
            row.scheduled_datetime = slot
            row.needs_approval = true
            row.approval_status = 'pending'
          }
        } catch (e) {
          console.warn('auto-schedule (pending approval) failed:', e.message)
        }
      }

      // If the row arrives marked "Ready to schedule" (status=caption_ready),
      // pick the next open slot from the profile's posting_schedule and
      // promote it to scheduled before insert. Gated on media: caption-
      // ready rows without media stay caption_ready until the user
      // attaches an image or video, otherwise they pollute the calendar.
      if (row.status === 'caption_ready' && hasMedia(row)) {
        try {
          const profileRows = await supaFetch(`profiles?id=eq.${body.profile_id}&select=timezone,posting_schedule`)
          const profile = profileRows?.[0]
          const taken = await supaFetch(
            `content_scripts?profile_id=eq.${body.profile_id}&status=eq.scheduled&select=scheduled_datetime`
          )
          const slot = findNextOpenSlot(profile, (taken || []).map((t) => t.scheduled_datetime))
          if (slot) {
            row.scheduled_datetime = slot
            row.status = 'scheduled'
          }
        } catch (e) {
          console.warn('auto-schedule failed:', e.message)
        }
      }

      const created = await supaFetch('content_scripts', { method: 'POST', body: row })
      return res.status(201).json({ item: Array.isArray(created) ? created[0] : created })
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const id = req.query.id || req.body?.id
      if (!id) return res.status(400).json({ error: 'id required' })
      // Pull the full row up front. If scheduled_datetime is being
      // changed on an already-scheduled post, we need the row's
      // platforms / media / caption to re-submit Upload-Post with
      // the new time.
      const rows = await supaFetch(`content_scripts?id=eq.${id}&select=*`)
      const item = rows?.[0]
      const profileId = item?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertMinRole(auth.user.id, profileId, 'editor')
      const updates = pickAllowed(req.body || {})

      // Reschedule-on-Upload-Post when ANY field that gets sent to
      // Upload-Post is changing on an already-scheduled row. Previously
      // we only re-submitted on scheduled_datetime changes, which meant
      // editing platforms / caption / hashtags / media on a scheduled
      // post updated the local row but left the queued Upload-Post job
      // with the original payload — eg adding Instagram to a row that
      // was already submitted as TikTok-only would silently still fire
      // only on TikTok. Now we cancel + re-submit whenever the user
      // changes any field Upload-Post actually consumes.
      const wasScheduled = item.status === 'scheduled' && item.uploadpost_request_id
      const UPLOAD_POST_FIELDS = ['scheduled_datetime', 'platforms', 'caption', 'hashtags', 'first_comment', 'media_urls', 'media_type', 'title', 'full_script']
      const arraysDiffer = (a, b) => {
        const aa = Array.isArray(a) ? a : []
        const bb = Array.isArray(b) ? b : []
        if (aa.length !== bb.length) return true
        const sa = [...aa].sort()
        const sb = [...bb].sort()
        return sa.some((v, i) => v !== sb[i])
      }
      const uploadPostFieldChanged = UPLOAD_POST_FIELDS.some((k) => {
        if (!Object.prototype.hasOwnProperty.call(updates, k)) return false
        const next = updates[k]
        const prev = item[k]
        if (Array.isArray(next) || Array.isArray(prev)) return arraysDiffer(next, prev)
        return (next ?? null) !== (prev ?? null)
      })
      let resynced = false
      let resyncFields = []
      if (wasScheduled && uploadPostFieldChanged) {
        try {
          // Use the next-scheduled-iso the user is moving to (if they
          // changed it) OR the row's existing time. Either way, we
          // re-submit the full current payload (merged with the new
          // values from updates) so Upload-Post's queued job matches
          // what the user sees in the Schedule UI.
          const mergedRow = { ...item, ...updates }
          const newIso = updates.scheduled_datetime || item.scheduled_datetime
          const submitResult = await rescheduleUploadPostJob({
            row: mergedRow,
            newScheduledIso: newIso,
            authToken: req.headers.authorization?.replace(/^Bearer\s+/i, '') || '',
            req,
          })
          if (submitResult?.request_id) updates.uploadpost_request_id = submitResult.request_id
          if (submitResult?.job_id) updates.uploadpost_job_id = submitResult.job_id
          resynced = true
          // List which fields actually moved so the toast on the
          // client can name what got pushed to Upload-Post.
          resyncFields = UPLOAD_POST_FIELDS.filter((k) => {
            if (!Object.prototype.hasOwnProperty.call(updates, k)) return false
            const next = updates[k]
            const prev = item[k]
            if (Array.isArray(next) || Array.isArray(prev)) return arraysDiffer(next, prev)
            return (next ?? null) !== (prev ?? null)
          })
        } catch (e) {
          return res.status(502).json({ error: `Reschedule failed on Upload-Post: ${e.message}` })
        }
      }

      const updated = await supaFetch(`content_scripts?id=eq.${id}`, { method: 'PATCH', body: updates })
      // If status changed, propagate to any collection nodes referencing it.
      if (updates.status) {
        syncContentStatusInSpaces(profileId, id, updates.status).catch(() => {})
      }
      return res.status(200).json({
        item: Array.isArray(updated) ? updated[0] : updated,
        upload_post_resynced: resynced,
        upload_post_fields_changed: resyncFields,
      })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`content_scripts?id=eq.${id}&select=profile_id,status,uploadpost_request_id,uploadpost_job_id,scheduled_datetime,title`)
      const row = rows?.[0]
      const profileId = row?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertMinRole(auth.user.id, profileId, 'editor')
      // Cascade-cancel the Upload-Post job before dropping the local row.
      // Cancellation strategy (in order of preference):
      //   1. Stored uploadpost_job_id    → direct DELETE
      //   2. Stored uploadpost_request_id → list-scan lookup (works on
      //      Upload-Post API versions that still expose request_id)
      //   3. scheduled_datetime + title  → list-scan match (works on the
      //      newer documented API which only returns job_id/date/title).
      //      Critical for "legacy" rows submitted before uploadpost_job_id
      //      was persisted — without this fallback the cancel silently
      //      returns not_found and Upload-Post keeps the orphan queued.
      let cancelDiag = { attempted: false, strategy: null, ok: null, reason: null, status: null, matched_job_id: null }
      if ((row.uploadpost_job_id || row.uploadpost_request_id) && !['posted', 'failed'].includes(row.status)) {
        cancelDiag.attempted = true
        try {
          let result
          if (row.uploadpost_job_id) {
            cancelDiag.strategy = 'by_job_id'
            result = await uploadpostCancelScheduled(row.uploadpost_job_id)
          } else {
            const username = await resolveUploadpostUser(profileId)
            cancelDiag.strategy = 'by_request_id'
            result = await uploadpostCancelByRequestId(username, row.uploadpost_request_id)
            if (!result.ok && (result.reason === 'not_found' || result.status === 404) && row.scheduled_datetime) {
              cancelDiag.strategy = 'by_schedule_match'
              const matchedJobId = await uploadpostJobIdViaScheduleMatch(username, {
                scheduled_iso: row.scheduled_datetime,
                title: row.title,
              })
              cancelDiag.matched_job_id = matchedJobId
              if (matchedJobId) result = await uploadpostCancelScheduled(matchedJobId)
            }
          }
          cancelDiag.ok = !!result.ok
          cancelDiag.reason = result.reason || null
          cancelDiag.status = result.status || null
          if (!result.ok && result.status !== 404) {
            console.warn('upload-post cancel failed:', row.uploadpost_job_id || row.uploadpost_request_id, result.reason)
          }
        } catch (e) {
          cancelDiag.reason = e?.message || String(e)
          console.warn('upload-post cancel threw:', e.message)
        }
      }
      // Cascade-unpublish for rows that already went live. Upload-Post's
      // /posts/unpublish (documented in their llm.txt) deletes published
      // posts on facebook / youtube / x / linkedin / threads. Instagram
      // and TikTok have no deletion API — those the user removes in-app.
      // We resolve each platform's post_id from the request's status
      // results, then fire best-effort unpublishes. Never blocks the
      // local delete.
      const unpublishDiag = []
      if (row.status === 'posted' && row.uploadpost_request_id) {
        try {
          const username = await resolveUploadpostUser(profileId)
          const statusBody = await uploadpost(
            `/api/uploadposts/status?request_id=${encodeURIComponent(row.uploadpost_request_id)}`
          ).catch(() => null)
          for (const r of (statusBody?.results || [])) {
            if (!r?.success || !r?.platform_post_id) continue
            const platform = String(r.platform || '').toLowerCase()
            if (!UNPUBLISH_SUPPORTED_PLATFORMS.has(platform)) {
              unpublishDiag.push({ platform, ok: false, reason: 'platform_unsupported (delete in-app)' })
              continue
            }
            const result = await uploadpostUnpublish({ platform, username, postId: r.platform_post_id })
            unpublishDiag.push({ platform, ok: result.ok, reason: result.reason || null })
          }
        } catch (e) {
          unpublishDiag.push({ platform: '*', ok: false, reason: e?.message || String(e) })
        }
      }
      await supaFetch(`content_scripts?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      // Mark collection items as deleted so they reflect in the canvas.
      syncContentStatusInSpaces(profileId, id, 'deleted').catch(() => {})
      // Return the diagnostic so the frontend can show / log why the
      // Upload-Post cascade did or didn't happen. 200 instead of 204
      // so the body is honored.
      return res.status(200).json({ deleted: true, upload_post_cancel: cancelDiag, upload_post_unpublish: unpublishDiag })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
