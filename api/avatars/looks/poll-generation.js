// GET /api/avatars/looks/poll-generation?task_id=...&profile_id=...
//
// Stateless poll endpoint for the New Look modal. Takes a Kie task id,
// returns one of:
//
//   { state: 'running' }
//   { state: 'failed', error: '<message>' }
//   { state: 'ready',  url: '<mirrored public url>' }
//
// On `ready` we mirror the Kie CDN URL into our `avatar-media` Supabase
// bucket (Kie URLs expire in days) and return the durable public URL.
// The client polls per-task every ~3-5s until state becomes terminal.
//
// No DB writes here. The avatar_looks row only gets created when the
// user clicks "Save look" in the modal — see /api/avatars/looks/save.

import { setCors, requireUser, assertProfileAccess } from '../../_lib/supabase.js'

export const config = { maxDuration: 30 }

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const BUCKET = 'avatar-media'

function pickKieImageUrl(data) {
  let out = []
  const rj = data?.resultJson
  if (typeof rj === 'string') {
    try {
      const parsed = JSON.parse(rj)
      if (Array.isArray(parsed?.resultUrls)) out = parsed.resultUrls
      else if (Array.isArray(parsed)) out = parsed
    } catch {}
  } else if (rj && Array.isArray(rj.resultUrls)) {
    out = rj.resultUrls
  }
  if (!out.length) {
    out = data?.resultUrls || data?.result?.urls || data?.images?.map?.((i) => i.url || i) || []
  }
  const first = (Array.isArray(out) ? out : []).filter(Boolean)[0]
  return typeof first === 'string' ? first : first?.url || null
}

async function mirrorImage(remoteUrl, profileId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Supabase storage not configured')
  }
  // One retry to absorb transient blips; on persistent failure we throw
  // and let the caller surface the error to the UI.
  const attempt = async () => {
    const r = await fetch(remoteUrl)
    if (!r.ok) throw new Error(`download ${r.status}`)
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.byteLength === 0) throw new Error('empty download')
    const path = `${profileId || 'shared'}/looks/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
    const up = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURI(path)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'image/jpeg',
          'x-upsert': 'true',
        },
        body: buf,
      }
    )
    if (!up.ok) {
      let detail = ''
      try { detail = (await up.text())?.slice(0, 200) } catch {}
      throw new Error(`upload ${up.status}: ${detail}`)
    }
    return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`
  }
  try { return await attempt() }
  catch (first) {
    await new Promise((r) => setTimeout(r, 1500))
    try { return await attempt() }
    catch (second) {
      throw new Error(`Mirror failed twice. last: ${second.message}, first: ${first.message}`)
    }
  }
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  const taskId = req.query.task_id
  const profileId = req.query.profile_id
  if (!taskId) return res.status(400).json({ error: 'task_id required' })
  if (!profileId) return res.status(400).json({ error: 'profile_id required' })
  await assertProfileAccess(auth.user.id, profileId)

  const apiKey = process.env.KIE_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'KIE_API_KEY not configured' })

  try {
    const r = await fetch(
      `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    )
    const text = await r.text()
    let body = {}
    try { body = JSON.parse(text) } catch { body = { raw: text } }
    const data = body?.data || body
    const state = String(data?.state || data?.status || '').toLowerCase()

    if (state === 'fail' || state === 'failed' || state === 'error') {
      return res.status(200).json({
        state: 'failed',
        error: (data?.failMsg || data?.errorMessage || 'Image generation failed').slice(0, 500),
      })
    }
    const url = pickKieImageUrl(data)
    if (url) {
      // Mirror immediately so the client can store a URL that won't
      // expire. The poll endpoint is the right place — by the time the
      // user accepts the image, the original might already be near
      // expiry.
      try {
        const mirrored = await mirrorImage(url, profileId)
        return res.status(200).json({ state: 'ready', url: mirrored })
      } catch (e) {
        return res.status(200).json({ state: 'failed', error: `Could not mirror image: ${e.message}` })
      }
    }
    return res.status(200).json({ state: 'running' })
  } catch (e) {
    return res.status(e?.status || 500).json({ error: e?.message || String(e) })
  }
}
