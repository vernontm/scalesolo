// POST /api/videos/captions
// Body: { profile_id, video_url, template_id, language?, render_options? }
// Returns: { video_url, bytes, zapcap }
//
// Pure ZapCap caption pass: submits the video URL, polls until rendered,
// downloads the result, re-uploads to landing-media so the URL is stable.
//
// Heavier polish features (title overlay, logo/watermark, background music)
// live in /api/videos/polish.js — temporarily unused by the canvas while
// we focus on captions, but the endpoint + ffmpeg pipeline are kept in
// place so we can re-enable them later without rewriting.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { createClient } from '@supabase/supabase-js'
import { zapcapAddVideoByUrl, zapcapCreateTask, zapcapPollTask } from '../_lib/zapcap.js'

export const config = { maxDuration: 300 }

async function fetchToBuffer(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Fetch ${url} → ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { profile_id, video_url, template_id, language = 'en', render_options } = req.body || {}
    if (!profile_id || !video_url) return res.status(400).json({ error: 'profile_id + video_url required' })
    if (!template_id) return res.status(400).json({ error: 'template_id required (pick a caption style)' })
    await assertProfileAccess(auth.user.id, profile_id)

    const cust = await supaFetch(`billing_customers?user_id=eq.${auth.user.id}&select=id`)
    const customerId = cust?.[0]?.id
    const fee = 2000
    if (customerId) {
      const pools = await supaFetch(`credit_pools?customer_id=eq.${customerId}&pool_type=eq.ai_tokens&select=balance`)
      if ((Number(pools?.[0]?.balance ?? 0)) < fee) {
        return res.status(402).json({ error: 'Insufficient AI tokens.', code: 'insufficient_credits' })
      }
    }

    const SUPABASE_URL = process.env.SUPABASE_URL
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
    if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Storage not configured' })

    // 1. Hand the video to ZapCap.
    const zVideoId = await zapcapAddVideoByUrl(video_url, { ttl: '1d' })
    const zTaskId  = await zapcapCreateTask(zVideoId, {
      templateId: template_id, language, autoApprove: true, renderOptions: render_options,
    })
    const zResult  = await zapcapPollTask(zVideoId, zTaskId, { timeoutMs: 5 * 60 * 1000, intervalMs: 4000 })
    const downloadUrl = zResult.downloadUrl || zResult.video?.downloadUrl || zResult.url
    if (!downloadUrl) throw new Error('ZapCap finished without a downloadUrl')

    // 2. Re-host to our bucket so the link doesn't expire when ZapCap's TTL hits.
    const buf = await fetchToBuffer(downloadUrl)
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    const path = `${profile_id}/spaces/captions/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`
    const { error: upErr } = await supabase.storage.from('landing-media').upload(path, buf, {
      contentType: 'video/mp4', upsert: false,
    })
    if (upErr) return res.status(502).json({ error: `Upload failed: ${upErr.message}` })
    const { data: pub } = supabase.storage.from('landing-media').getPublicUrl(path)

    if (customerId) {
      try {
        await supaFetch('rpc/consume_credits', {
          method: 'POST',
          body: {
            p_customer_id: customerId, p_pool_type: 'ai_tokens', p_amount: fee,
            p_action: 'consume:zapcap-captions', p_profile_id: profile_id,
            p_metadata: { template_id, video_id: zVideoId, task_id: zTaskId, bytes: buf.byteLength },
          },
        })
      } catch {}
    }

    // Don't auto-insert a "Captioned video" content_scripts row. Like
    // polish.js, the save_library node is the canonical writer — auto
    // inserts here just produced empty Library rows for every run.
    return res.status(200).json({
      video_url: pub.publicUrl,
      bytes: buf.byteLength,
      zapcap: { template_id, video_id: zVideoId, task_id: zTaskId },
      content_id: null,
    })
  } catch (err) {
    console.error('captions error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  }
}
