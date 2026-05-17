// Cron: scan every brand profile that has at least one Upload-Post
// submission and DELETE any scheduled jobs on Upload-Post that no
// longer have a content_scripts row pointing at them.
//
// Why: deleting a row in-app cascades a DELETE to Upload-Post (see
// api/content.js DELETE), but a few legacy paths could leave orphans:
//   - rows deleted before the cascade guard was widened
//   - rows whose uploadpost_request_id wasn't persisted (e.g. crash
//     between submit and PATCH)
//   - upstream Upload-Post outages that swallowed our DELETE
// Without this sweeper, those orphans keep firing on the schedule.
//
// Schedule (vercel.json crons): every 30 minutes.
// Authentication: CRON_SECRET bearer (Vercel Cron auto-injects).
//
// Per-brand logic mirrors api/social/uploadpost-cleanup.js (mode:
// 'cancel_orphans'). Matched (currently-queued) posts are NEVER
// touched — only jobs with no DB row pointing at them.

import { setCors, supaFetch } from '../_lib/supabase.js'
import {
  resolveUploadpostUser,
  uploadpostListScheduled,
  uploadpostCancelScheduled,
} from '../_lib/uploadpost.js'

export const config = { maxDuration: 300 }

const CONCURRENCY_PER_BRAND = 5

async function cleanupBrand(profileId) {
  const username = await resolveUploadpostUser(profileId)
  if (!username) return { profile_id: profileId, skipped: 'no_username', canceled: 0, failed: 0 }

  let raw = { posts: [] }
  try {
    raw = await uploadpostListScheduled(username)
  } catch (e) {
    return { profile_id: profileId, username, skipped: 'list_failed', error: e?.message || String(e), canceled: 0, failed: 0 }
  }

  const rawJobs = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw?.posts) ? raw.posts
      : Array.isArray(raw?.results) ? raw.results
      : Array.isArray(raw?.data) ? raw.data
      : [])
  // Per the documented Upload-Post list endpoint, each job carries a
  // job_id, scheduled_date, post_type, title, and profile_username.
  // It does NOT carry a request_id. Match exclusively on job_id; fall
  // back to title + scheduled_date for legacy rows that don't yet
  // have uploadpost_job_id persisted.
  const jobs = rawJobs
    .map((j) => ({
      job_id: j?.job_id || j?.jobId || null,
      scheduled_date: j?.scheduled_date || j?.scheduled_at || null,
      title: (j?.title || '').trim(),
    }))
    .filter((j) => j.job_id)
  if (!jobs.length) return { profile_id: profileId, username, total: 0, orphan: 0, canceled: 0, failed: 0 }

  // Pull every currently-tracked row for this profile so we can match
  // both by job_id (the future-proof path) and by title+date (legacy
  // rows submitted before uploadpost_job_id existed). Keeps the cron
  // conservative — never DELETEs a job that any local row appears to
  // claim.
  const rows = await supaFetch(
    `content_scripts?profile_id=eq.${profileId}&or=(uploadpost_job_id.not.is.null,uploadpost_request_id.not.is.null)` +
    `&select=id,uploadpost_job_id,uploadpost_request_id,scheduled_datetime,title&limit=2000`
  ).catch(() => [])

  const matchedJobIds = new Set((rows || []).map((r) => r.uploadpost_job_id).filter(Boolean))
  const legacyRows = (rows || []).filter((r) => !r.uploadpost_job_id && r.uploadpost_request_id)

  // ± 90 seconds tolerance on the scheduled timestamp to absorb minor
  // clock drift / formatting differences between our DB and
  // Upload-Post's stored time.
  const fuzzyMatchesLegacy = (job) => {
    if (!legacyRows.length) return false
    const jobMs = job.scheduled_date ? Date.parse(job.scheduled_date) : NaN
    return legacyRows.some((r) => {
      const rMs = r.scheduled_datetime ? Date.parse(r.scheduled_datetime) : NaN
      if (Number.isFinite(jobMs) && Number.isFinite(rMs) && Math.abs(jobMs - rMs) <= 90_000) {
        // Title or date alone is enough — date is the strong signal,
        // title is a tie-breaker for the rare same-minute case.
        const rTitle = (r.title || '').trim()
        if (!job.title || !rTitle) return true
        return job.title.toLowerCase().slice(0, 40) === rTitle.toLowerCase().slice(0, 40)
      }
      return false
    })
  }

  const orphans = jobs.filter((j) => !matchedJobIds.has(j.job_id) && !fuzzyMatchesLegacy(j))

  let canceled = 0, failed = 0
  let cursor = 0
  const workers = Array.from({ length: Math.min(CONCURRENCY_PER_BRAND, orphans.length) }, async () => {
    while (cursor < orphans.length) {
      const j = orphans[cursor++]
      if (!j.job_id) { failed++; continue }
      try {
        const r = await uploadpostCancelScheduled(j.job_id)
        if (r.ok) canceled++; else failed++
      } catch { failed++ }
    }
  })
  await Promise.all(workers)

  return { profile_id: profileId, username, total: jobs.length, orphan: orphans.length, canceled, failed }
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || !bearer || bearer !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (!process.env.UPLOADPOST_API_KEY) {
    return res.status(503).json({ error: 'UPLOADPOST_API_KEY not configured' })
  }

  try {
    // Enumerate only profiles that have ever submitted to Upload-Post.
    // Scanning every profile would burn the 300s budget on brands that
    // can't possibly have orphans (never touched Upload-Post).
    const rows = await supaFetch(
      `content_scripts?or=(uploadpost_job_id.not.is.null,uploadpost_request_id.not.is.null)&select=profile_id&limit=10000`
    ).catch(() => [])
    const profileIds = [...new Set((rows || []).map((r) => r.profile_id).filter(Boolean))]

    if (!profileIds.length) {
      return res.status(200).json({ ok: true, scanned: 0, results: [] })
    }

    // Sequential across brands; concurrency lives inside each brand's
    // orphan loop. Keeps Upload-Post's rate-limit budget per-username.
    const results = []
    let totalCanceled = 0, totalFailed = 0, totalOrphan = 0
    for (const pid of profileIds) {
      try {
        const r = await cleanupBrand(pid)
        results.push(r)
        totalCanceled += r.canceled || 0
        totalFailed += r.failed || 0
        totalOrphan += r.orphan || 0
      } catch (e) {
        results.push({ profile_id: pid, error: e?.message || String(e), canceled: 0, failed: 0 })
        totalFailed += 1
      }
    }

    return res.status(200).json({
      ok: true,
      scanned: profileIds.length,
      totals: { orphan: totalOrphan, canceled: totalCanceled, failed: totalFailed },
      results,
    })
  } catch (err) {
    console.error('cleanup-uploadpost-orphans error:', err?.stack || err)
    return res.status(500).json({ error: err.message || String(err) })
  }
}
