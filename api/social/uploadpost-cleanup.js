// POST /api/social/uploadpost-cleanup
// Body: { profile_id, mode: 'list' | 'cancel_orphans' }
// Returns (list):           { jobs: [{ request_id, scheduled_date, platforms, ... , matched_script_id|null }], counts: { total, matched, orphan } }
// Returns (cancel_orphans): { canceled: [{ request_id, ok, reason? }], counts: { total, matched, orphan, canceled, failed } }
//
// Reconciles Upload-Post's view of "what's scheduled for this brand"
// against our content_scripts table:
//
//   • list — fetches every scheduled job on the profile's Upload-Post user,
//     looks each request_id up in content_scripts, and tags it as either
//     matched (a row points to it) or orphan (nothing in our DB knows
//     about it). Pure read; nothing changes.
//
//   • cancel_orphans — same fetch + tagging, then DELETEs every orphan
//     scheduled job on Upload-Post. Use this when bulk-deletes left
//     untracked jobs on Upload-Post's calendar (the failure mode that
//     prompted this endpoint). Matched jobs are NEVER cancelled — those
//     are real, currently-queued posts.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import {
  resolveUploadpostUser,
  uploadpostListScheduled,
  uploadpostCancelScheduled,
} from '../_lib/uploadpost.js'

export const config = { maxDuration: 300 }

// Pull a request_id out of whatever shape Upload-Post returned for a job.
// Their list endpoint has historically returned the id under a few names
// depending on platform / version; we accept any of them.
function jobRequestId(j) {
  return j?.request_id || j?.id || j?.requestId || j?.upload_id || null
}

// Best-effort normalize an Upload-Post job into a small shape the UI can
// render (request_id, scheduled time, platforms, title). Keeps the
// payload tight even when Upload-Post returns 30+ fields per job.
function summarizeJob(j) {
  return {
    request_id:     jobRequestId(j),
    scheduled_date: j?.scheduled_date || j?.scheduled_at || j?.scheduled_for || null,
    platforms:      Array.isArray(j?.platform) ? j.platform : Array.isArray(j?.platforms) ? j.platforms : [],
    title:          j?.title || j?.tiktok_title || j?.description?.slice?.(0, 80) || '',
    media_type:     j?.media_type || (j?.video_url ? 'video' : j?.photos ? 'photo' : null),
    created_at:     j?.created_at || null,
  }
}

export default async function handler(req, res) {
  setCors(res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST')     return res.status(405).json({ error: 'Method not allowed' })

  try {
    const auth = await requireUser(req)
    const { profile_id, mode = 'list' } = req.body || {}
    if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
    if (!['list', 'cancel_orphans'].includes(mode)) {
      return res.status(400).json({ error: `mode must be 'list' or 'cancel_orphans'` })
    }
    await assertProfileAccess(auth.user.id, profile_id)

    if (!process.env.UPLOADPOST_API_KEY) {
      return res.status(503).json({ error: 'UPLOADPOST_API_KEY not configured' })
    }

    // 1. List every scheduled job on Upload-Post for this profile's user.
    const username = await resolveUploadpostUser(profile_id)
    if (!username) return res.status(400).json({ error: 'No Upload-Post user resolved for this profile' })

    // Wrap the Upload-Post list call in a tolerant try. Upload-Post
    // sometimes returns 5xx or auth errors during their own incidents,
    // and this endpoint is hit silently on every Schedule page mount —
    // a 500 here pollutes the user's console without any actionable
    // outcome. Empty list is the safe default.
    let raw = { posts: [] }
    try {
      raw = await uploadpostListScheduled(username)
    } catch (e) {
      console.warn('uploadpost-cleanup: list call failed, treating as empty:', e?.status || '', e?.message || e)
      return res.status(200).json({
        jobs: [],
        counts: { total: 0, matched: 0, orphan: 0 },
        username,
        warning: `Upload-Post list call failed (${e?.status || 'network'}): ${e?.message || 'unknown'}`,
      })
    }
    // Upload-Post returns its list under a few different keys depending
    // on which endpoint family. Find the first array-shaped field.
    const rawJobs = Array.isArray(raw)
      ? raw
      : (Array.isArray(raw?.posts) ? raw.posts
        : Array.isArray(raw?.results) ? raw.results
        : Array.isArray(raw?.data) ? raw.data
        : [])
    const jobs = rawJobs.map(summarizeJob).filter((j) => j.request_id)

    // 2. Tag each job as matched / orphan by looking the request_id up
    //    in content_scripts. One IN query for the whole batch keeps this
    //    O(1) DB calls regardless of job count.
    let matchedIds = new Set()
    if (jobs.length) {
      const idList = jobs.map((j) => encodeURIComponent(j.request_id)).join(',')
      const rows = await supaFetch(
        `content_scripts?profile_id=eq.${profile_id}&uploadpost_request_id=in.(${idList})&select=id,uploadpost_request_id`
      ).catch(() => [])
      for (const r of (rows || [])) {
        if (r.uploadpost_request_id) matchedIds.add(r.uploadpost_request_id)
      }
    }

    const taggedJobs = jobs.map((j) => ({
      ...j,
      matched: matchedIds.has(j.request_id),
    }))
    const orphans = taggedJobs.filter((j) => !j.matched)

    const counts = {
      total: taggedJobs.length,
      matched: taggedJobs.length - orphans.length,
      orphan: orphans.length,
    }

    // 3. List mode — return the inventory, no side effects.
    if (mode === 'list') {
      return res.status(200).json({ jobs: taggedJobs, counts, username })
    }

    // 4. cancel_orphans — DELETE each orphan job on Upload-Post.
    //    Concurrency-capped so we don't slam their API and to fit the
    //    function budget. matched jobs are never touched.
    let canceled = 0
    let failed = 0
    const detail = []

    const CONCURRENCY = 5
    let cursor = 0
    const workers = Array.from({ length: Math.min(CONCURRENCY, orphans.length) }, async () => {
      while (cursor < orphans.length) {
        const j = orphans[cursor++]
        const r = await uploadpostCancelScheduled(j.request_id)
        if (r.ok) { canceled++; detail.push({ request_id: j.request_id, ok: true }) }
        else      { failed++;  detail.push({ request_id: j.request_id, ok: false, reason: r.reason || 'unknown', status: r.status || null }) }
      }
    })
    await Promise.all(workers)

    return res.status(200).json({
      counts: { ...counts, canceled, failed },
      canceled: detail,
      username,
    })
  } catch (err) {
    console.error('uploadpost-cleanup error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  }
}
