// POST /api/studio/youtube/edit-thumbnail
//
// Take an existing generated thumbnail + a free-form edit prompt and
// produce a new variation. Uses gpt-image-2-image-to-image with the
// previous thumbnail as input_urls so the model "edits" the existing
// composition rather than starting from scratch.
//
// Body: { studio_video_id, source_url, edit_prompt }
// Returns: { candidate } — appends to studio_videos.thumbnail_candidates

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../../_lib/supabase.js'
import { gateStudio } from '../_lib/gate.js'

export const config = { maxDuration: 90, memory: 1024 }

const KIE_BASE = 'https://api.kie.ai'
const STUDIO_BUCKET = 'studio-media'
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY

function parseKieResultUrls(data) {
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
    out = data?.resultUrls
      || data?.result?.urls
      || data?.images?.map?.((i) => i.url || i)
      || []
  }
  return (Array.isArray(out) ? out : []).filter(Boolean)
}

async function submitEditTask({ prompt, sourceUrl, apiKey }) {
  const body = {
    model: 'gpt-image-2-image-to-image',
    input: {
      prompt: prompt.slice(0, 20000),
      input_urls: [sourceUrl],
      aspect_ratio: '16:9',
      resolution: '2K',
    },
  }
  const r = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  let data = {}
  try { data = JSON.parse(text) } catch {}
  if (!r.ok || (data?.code && data.code !== 200)) {
    throw new Error(`Kie createTask ${r.status}: ${(data?.msg || text).slice(0, 240)}`)
  }
  const taskId = data?.data?.taskId || data?.taskId
  if (!taskId) throw new Error(`Kie response missing taskId: ${text.slice(0, 200)}`)
  return taskId
}

async function pollKieTask(taskId, apiKey, maxMs = 75000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const r = await fetch(`${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const text = await r.text()
    let body = {}
    try { body = JSON.parse(text) } catch {}
    const data = body?.data || body
    const state = String(data?.state || data?.status || '').toLowerCase()
    if (state === 'fail' || state === 'failed' || state === 'error') {
      throw new Error(data?.failMsg || data?.errorMessage || 'Kie task failed')
    }
    const urls = parseKieResultUrls(data)
    if (urls.length) return urls[0]
    if (['success', 'completed', 'done', 'finished'].includes(state)) {
      throw new Error(`Kie task completed but no image URL (keys=${Object.keys(data || {}).join(',')})`)
    }
    await new Promise((r) => setTimeout(r, 2500))
  }
  throw new Error('Kie edit task did not complete in time')
}

async function mirrorToStorage(remoteUrl, profileId, videoId) {
  const dl = await fetch(remoteUrl)
  if (!dl.ok) throw new Error(`mirror download ${dl.status}`)
  const buf = Buffer.from(await dl.arrayBuffer())
  const path = `${profileId}/studio/youtube-thumbnails/edit-${videoId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
  const up = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${STUDIO_BUCKET}/${encodeURI(path)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'image/jpeg',
        'x-upsert': 'true',
      },
      body: buf,
    },
  )
  if (!up.ok) {
    const detail = await up.text().catch(() => '')
    throw new Error(`mirror upload ${up.status}: ${detail.slice(0, 200)}`)
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${STUDIO_BUCKET}/${path}`
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    gateStudio(auth.user.id)
    const { studio_video_id, source_url, edit_prompt } = req.body || {}
    if (!studio_video_id) return res.status(400).json({ error: 'studio_video_id required' })
    if (!source_url) return res.status(400).json({ error: 'source_url required' })
    if (!edit_prompt || !edit_prompt.trim()) return res.status(400).json({ error: 'edit_prompt required' })

    const videos = await supaFetch(`studio_videos?id=eq.${studio_video_id}&select=id,profile_id,thumbnail_candidates`)
    const video = videos?.[0]
    if (!video) return res.status(404).json({ error: 'Video not found' })
    await assertProfileAccess(auth.user.id, video.profile_id)

    const kieKey = process.env.KIE_API_KEY
    if (!kieKey) return res.status(500).json({ error: 'KIE_API_KEY not configured.' })

    const taskId = await submitEditTask({ prompt: edit_prompt.trim(), sourceUrl: source_url, apiKey: kieKey })
    const remoteUrl = await pollKieTask(taskId, kieKey)
    const finalUrl = await mirrorToStorage(remoteUrl, video.profile_id, video.id)

    const newCandidate = {
      url: finalUrl,
      prompt: edit_prompt.trim(),
      overlay_text: '',
      style: 'Edited',
      features_person: false,
      derived_from: source_url,
    }
    const existing = Array.isArray(video.thumbnail_candidates) ? video.thumbnail_candidates : []
    const nextCandidates = [...existing, newCandidate]
    try {
      await supaFetch(`studio_videos?id=eq.${video.id}`, {
        method: 'PATCH',
        body: { thumbnail_candidates: nextCandidates },
        prefer: 'return=minimal',
      })
    } catch (e) {
      console.warn(`[edit-thumbnail] persist failed: ${e.message}`)
    }
    return res.status(200).json({ candidate: newCandidate })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
