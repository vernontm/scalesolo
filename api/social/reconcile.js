// Reconcile the ScaleSolo calendar against Upload-Post's own schedule.
//
// POST /api/social/reconcile   Body: { profile_id }
//   → { mirrored, scanned }
//
// Why this exists: a post can reach Upload-Post's scheduler without a
// content_scripts row ever landing (a swallowed insert error, a flow that
// submitted then lost the row, etc.). When that happens the post is live/
// queued but INVISIBLE in ScaleSolo, so the user assumes it failed and
// re-submits, duplicating it on a real audience's feed. This endpoint pulls
// the brand's scheduled jobs straight from Upload-Post and back-fills a
// calendar row for any that don't already have one, so the Schedule page
// always reflects what is actually queued.
//
// Safety properties:
//   • Insert-only. Never deletes, never posts, never edits an existing row.
//   • Deduped on uploadpost_job_id (the key Upload-Post's schedule list
//     exposes and that content_scripts already stores), so re-running is
//     idempotent and can't create duplicate calendar rows.
//   • Mirrored rows carry NO media_urls, so publish-selected's "no media"
//     guard makes them impossible to accidentally re-publish. They exist
//     purely to be visible; the real job lives at Upload-Post.
import { setCors, requireUser, assertProfileAccess, supaFetch } from '../_lib/supabase.js'
import { resolveUploadpostUser, uploadpostListScheduled } from '../_lib/uploadpost.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const auth = await requireUser(req, res)
  if (!auth) return

  const { profile_id } = req.body || {}
  if (!profile_id) return res.status(400).json({ error: 'profile_id required' })

  try {
    await assertProfileAccess(auth.user.id, profile_id)
  } catch (e) {
    return res.status(e?.status || 403).json({ error: e?.message || 'Forbidden' })
  }

  try {
    const username = await resolveUploadpostUser(profile_id)
    if (!username) return res.status(200).json({ mirrored: 0, scanned: 0, note: 'no upload-post account for this brand' })

    // Upload-Post's scheduled jobs for this brand only (helper filters by
    // profile_username). This list exposes job_id, not request_id.
    const { posts } = await uploadpostListScheduled(username).catch(() => ({ posts: [] }))
    const scheduled = Array.isArray(posts) ? posts : []
    if (!scheduled.length) return res.status(200).json({ mirrored: 0, scanned: 0 })

    // Every local row that already carries a job_id, so we only insert the
    // jobs we don't already know about.
    const existing = await supaFetch(
      `content_scripts?profile_id=eq.${encodeURIComponent(profile_id)}` +
      `&uploadpost_job_id=not.is.null&select=uploadpost_job_id`
    ).catch(() => [])
    const known = new Set((existing || []).map((r) => String(r.uploadpost_job_id)))

    let mirrored = 0
    for (const job of scheduled) {
      const jobId = job?.job_id
      if (!jobId || known.has(String(jobId))) continue

      const platforms = Array.isArray(job.platforms) ? job.platforms.map((p) => String(p).toLowerCase()) : []
      const caption = (job.caption || job.description || '').toString().trim() || null
      const title = (job.title || caption || 'Scheduled post').toString().slice(0, 120)
      const pt = String(job.post_type || '').toLowerCase()
      const mediaType = pt.includes('video') ? 'video' : pt.includes('text') ? 'text' : 'image'
      // Prefer the offset-carrying string; fall back to the bare local one.
      const scheduledIso = job.original_scheduled_str || job.scheduled_date || null

      try {
        await supaFetch('content_scripts', {
          method: 'POST',
          body: {
            profile_id,
            title,
            caption,
            // No media on purpose: makes the row visible on the calendar but
            // impossible to re-publish (publish-selected skips "no media").
            media_urls: [],
            media_type: mediaType,
            post_type: mediaType === 'video' ? 'video' : mediaType === 'text' ? 'text' : 'post',
            platforms: platforms.length ? platforms : null,
            status: 'scheduled',
            scheduled_datetime: scheduledIso,
            uploadpost_job_id: String(jobId),
            generated_by: 'reconcile',
          },
        })
        known.add(String(jobId))
        mirrored++
      } catch (e) {
        console.error('reconcile: insert failed', { profile_id, jobId, message: e?.message })
      }
    }

    return res.status(200).json({ mirrored, scanned: scheduled.length })
  } catch (e) {
    console.error('reconcile error:', e?.stack || e)
    return res.status(500).json({ error: e?.message || 'Reconcile failed' })
  }
}
