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

import { setCors, requireUser, supaFetch, assertProfileAccess } from './_lib/supabase.js'
import { findNextOpenSlot, syncContentStatusInSpaces } from './_lib/scheduling.js'
import { uploadpostCancelScheduled } from './_lib/uploadpost.js'

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
  if (!platforms || !platforms.length) return null
  if (!mediaUrls.length) return null

  // Cancel old job if there is one. Best-effort — 404s (already fired
  // / never existed) don't block the re-submit.
  if (row.uploadpost_request_id) {
    try {
      const cancel = await uploadpostCancelScheduled(row.uploadpost_request_id)
      if (!cancel.ok && cancel.status !== 404) {
        console.warn('reschedule: cancel old job failed:', row.uploadpost_request_id, cancel.reason)
      }
    } catch (e) {
      console.warn('reschedule: cancel threw:', e.message)
    }
  }

  // Build a fresh /api/social/upload-post body from the row + new time.
  // mediaUrls[0] is the canonical video when media_type is 'video';
  // otherwise everything is treated as a photo bundle. description is
  // the merged caption + hashtags string each platform expects.
  const isVideo = row.media_type === 'video' || /\.(mp4|mov|webm|m4v)(\?|#|$)/i.test(mediaUrls[0] || '')
  const fullCaption = [row.caption, row.hashtags].filter(Boolean).join('\n\n').trim()

  const body = {
    profile_id: row.profile_id,
    platforms,
    video_url: isVideo ? mediaUrls[0] : undefined,
    photo_urls: !isVideo ? mediaUrls : undefined,
    description: fullCaption || row.full_script || row.title || '',
    title: row.title || undefined,
    caption: row.caption || undefined,
    hashtags: row.hashtags || undefined,
    script: row.full_script || undefined,
    first_comment: row.first_comment || undefined,
    scheduling_mode: 'fixed',
    scheduled_iso: newScheduledIso,
    // Force the upload-post endpoint to PATCH this row, not insert a
    // new one. Edits-on-scheduled-row often happen long after the
    // 5-min dedup window, which without script_id duplicates the row.
    script_id: row.id,
  }

  // Internal call — same Vercel host, forward the user's auth token so
  // /api/social/upload-post passes its requireUser check + can debit
  // the right billing customer. We resolve the absolute URL from the
  // current request so this works on prod, preview, and localhost.
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim()
  const host  = req.headers['x-forwarded-host'] || req.headers.host
  const base  = `${proto}://${host}`
  const r = await fetch(`${base}/api/social/upload-post`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify(body),
  })
  const resp = await r.json().catch(() => ({}))
  if (!r.ok) {
    const msg = resp?.error || `upload-post resubmit ${r.status}`
    const err = new Error(msg)
    err.status = r.status
    throw err
  }
  return resp.request_id || null
}

const ALLOWED = new Set([
  'title','hook','full_script','series_name','caption','hashtags','first_comment',
  'tags','media_urls','media_type','scheduled_datetime','status','sort_order',
  'post_type','location','platforms','cover_timestamp',
  'needs_approval','approval_status','rejected_reason','recycle_period_days',
  'generated_by','generation_prompt','performance',
  // uploadpost_request_id is server-managed (set when the original
  // submission lands + rotated when we reschedule), but it lives in
  // ALLOWED so the reschedule handler can include it in the updates
  // payload alongside scheduled_datetime in one PATCH.
  'uploadpost_request_id',
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
      if (filter === 'scheduled') where += '&status=eq.scheduled'
      if (filter === 'posted')    where += '&status=eq.posted'
      if (filter === 'approvals') where += '&approval_status=eq.pending'
      const order = filter === 'scheduled' ? 'scheduled_datetime.asc' : 'updated_at.desc'
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
        await assertProfileAccess(auth.user.id, item.profile_id)

        let updates = {}
        if (action === 'approve') {
          updates = {
            approval_status: 'approved',
            needs_approval: false,
            approved_by: auth.user.id,
            approved_at: new Date().toISOString(),
            rejected_reason: null,
            status: item.status,
          }
          // If approved-from-draft and the user didn't supply a time, find
          // the next open slot from the profile's posting_schedule and
          // promote to scheduled in one step. Gated on media: a row
          // without media_urls stays as approved-draft until media is
          // attached, otherwise it pollutes the calendar with text-only
          // ghosts.
          if (hasMedia(item)) {
            try {
              const pr = await supaFetch(`profiles?id=eq.${item.profile_id}&select=timezone,posting_schedule`)
              const taken = await supaFetch(
                `content_scripts?profile_id=eq.${item.profile_id}&status=eq.scheduled&select=scheduled_datetime`
              )
              const slot = findNextOpenSlot(pr?.[0], (taken || []).map((t) => t.scheduled_datetime))
              if (slot) {
                updates.scheduled_datetime = slot
                updates.status = 'scheduled'
              }
            } catch (e) { console.warn('auto-schedule on approve failed:', e.message) }
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
          // Block scheduling text-only rows. Caller has to attach a
          // video or image upstream first — otherwise the post lands
          // in the calendar with nothing to publish on the actual day.
          if (!hasMedia(item)) {
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
          // new time, cancel + re-submit on Upload-Post so the actual
          // post fires at the right moment. Brand-new schedules (the
          // first time the user hits Schedule) skip this — the initial
          // submission is owned by /api/social/upload-post directly.
          const wasScheduled = item.status === 'scheduled' && item.uploadpost_request_id
          const timeChanged = item.scheduled_datetime !== req.body.scheduled_datetime
          if (wasScheduled && timeChanged) {
            try {
              const newReqId = await rescheduleUploadPostJob({
                row: item,
                newScheduledIso: req.body.scheduled_datetime,
                authToken: req.headers.authorization?.replace(/^Bearer\s+/i, '') || '',
                req,
              })
              if (newReqId) updates.uploadpost_request_id = newReqId
            } catch (e) {
              return res.status(502).json({ error: `Reschedule failed on Upload-Post: ${e.message}` })
            }
          }
        } else {
          return res.status(400).json({ error: `unknown action: ${action}` })
        }

        const updated = await supaFetch(`content_scripts?id=eq.${id}`, { method: 'PATCH', body: updates })
        if (updates.status) {
          syncContentStatusInSpaces(item.profile_id, id, updates.status).catch(() => {})
        }
        return res.status(200).json({ item: Array.isArray(updated) ? updated[0] : updated })
      }

      // ── Plain create ────────────────────────────────────────────────────
      const body = req.body || {}
      if (!body.profile_id) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, body.profile_id)
      const row = pickAllowed(body)
      row.profile_id = body.profile_id

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
      await assertProfileAccess(auth.user.id, profileId)
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
      if (wasScheduled && uploadPostFieldChanged) {
        try {
          // Use the next-scheduled-iso the user is moving to (if they
          // changed it) OR the row's existing time. Either way, we
          // re-submit the full current payload (merged with the new
          // values from updates) so Upload-Post's queued job matches
          // what the user sees in the Schedule UI.
          const mergedRow = { ...item, ...updates }
          const newIso = updates.scheduled_datetime || item.scheduled_datetime
          const newReqId = await rescheduleUploadPostJob({
            row: mergedRow,
            newScheduledIso: newIso,
            authToken: req.headers.authorization?.replace(/^Bearer\s+/i, '') || '',
            req,
          })
          if (newReqId) updates.uploadpost_request_id = newReqId
        } catch (e) {
          return res.status(502).json({ error: `Reschedule failed on Upload-Post: ${e.message}` })
        }
      }

      const updated = await supaFetch(`content_scripts?id=eq.${id}`, { method: 'PATCH', body: updates })
      // If status changed, propagate to any collection nodes referencing it.
      if (updates.status) {
        syncContentStatusInSpaces(profileId, id, updates.status).catch(() => {})
      }
      return res.status(200).json({ item: Array.isArray(updated) ? updated[0] : updated })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`content_scripts?id=eq.${id}&select=profile_id,status,uploadpost_request_id`)
      const row = rows?.[0]
      const profileId = row?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      // Cascade-cancel the Upload-Post job before dropping the local row, so a
      // deleted-in-app post doesn't keep firing on the schedule. Best-effort:
      // 404s (already fired / never existed) don't block the local delete.
      if (row.status === 'scheduled' && row.uploadpost_request_id) {
        try {
          const result = await uploadpostCancelScheduled(row.uploadpost_request_id)
          if (!result.ok && result.status !== 404) {
            console.warn('upload-post cancel failed:', row.uploadpost_request_id, result.reason)
          }
        } catch (e) {
          console.warn('upload-post cancel threw:', e.message)
        }
      }
      await supaFetch(`content_scripts?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      // Mark collection items as deleted so they reflect in the canvas.
      syncContentStatusInSpaces(profileId, id, 'deleted').catch(() => {})
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
