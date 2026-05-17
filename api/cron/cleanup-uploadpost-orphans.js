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

function jobRequestId(j) {
  return j?.request_id || j?.id || j?.requestId || j?.upload_id || null
}

function summarizeJob(j) {
  return {
    request_id: jobRequestId(j),
    job_id: j?.job_id || j?.jobId || null,
  }
}

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
  const jobs = rawJobs.map(summarizeJob).filter((j) => j.request_id)
  if (!jobs.length) return { profile_id: profileId, username, total: 0, orphan: 0, canceled: 0, failed: 0 }

  // Tag matched vs orphan via one IN query.
  const idList = jobs.map((j) => encodeURIComponent(j.request_id)).join(',')
  const matchedRows = await supaFetch(
    `content_scripts?profile_id=eq.${profileId}&uploadpost_request_id=in.(${idList})&select=uploadpost_request_id`
  ).catch(() => [])
  const matched = new Set((matchedRows || []).map((r) => r.uploadpost_request_id).filter(Boolean))
  const orphans = jobs.filter((j) => !matched.has(j.request_id))

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
      `content_scripts?uploadpost_request_id=not.is.null&select=profile_id&limit=10000`
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
