// GET /api/images/status?taskId=...&model=... → { state, urls? }
//
// Single KIE poll + storage mirror for one task. Client-side runner calls
// this on a loop until state === 'success' (then receives mirrored Supabase
// URLs ready for display) or 'failed'.

import { setCors, requireUser } from '../_lib/supabase.js'
import { mirrorToStorage } from './_mirror.js'

function pickResultUrls(data) {
  let out = []
  const rj = data?.resultJson
  if (typeof rj === 'string') {
    try {
      const parsed = JSON.parse(rj)
      if (Array.isArray(parsed?.resultUrls)) out = parsed.resultUrls
      else if (Array.isArray(parsed)) out = parsed
    } catch {}
  } else if (rj && Array.isArray(rj.resultUrls)) out = rj.resultUrls
  if (!out.length) {
    out = data?.resultUrls || data?.result?.urls || data?.images?.map?.((i) => i.url || i) || []
  }
  return (Array.isArray(out) ? out : []).filter(Boolean)
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  const taskId = req.query.taskId
  const profile_id = req.query.profile_id
  if (!taskId) return res.status(400).json({ error: 'taskId required' })
  const apiKey = process.env.KIE_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'KIE_API_KEY not configured' })

  try {
    const r = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const text = await r.text()
    let body = {}
    try { body = JSON.parse(text) } catch { body = { raw: text } }
    const data = body?.data || body
    const state = String(data?.state || data?.status || '').toLowerCase()

    // Probe for result URLs first — some KIE jobs return result data
    // without a definitive state field. If we have URLs, the job is done.
    const probableUrls = pickResultUrls(data)
    const isDone = state === 'success' || state === 'completed' || state === 'done' || state === 'finished'

    if (isDone || probableUrls.length > 0) {
      const raw = probableUrls.map((u) => (typeof u === 'string' ? { url: u } : u))
      if (!raw.length) return res.status(502).json({ state: 'failed', error: 'KIE returned no image URLs', kie_body: data })
      const mirrored = await Promise.all(
        raw.map(async (u) => ({ ...u, url: await mirrorToStorage(u.url, profile_id) }))
      )
      return res.status(200).json({ state: 'success', images: mirrored })
    }
    if (state === 'fail' || state === 'failed' || state === 'error') {
      return res.status(200).json({ state: 'failed', error: data?.failMsg || data?.errorMessage || data?.message || 'Generation failed' })
    }
    return res.status(200).json({ state: state || 'pending' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
