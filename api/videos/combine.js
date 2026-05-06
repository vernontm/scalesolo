// POST /api/videos/combine
// Body: { profile_id, video_urls: [...] }
// Returns: { video_url } — the stitched MP4 in landing-media.
//
// Thin proxy that forwards to the Supabase Edge Function `combine-videos`
// (Deno + ffmpeg-wasm). The edge function downloads each URL, concats,
// and uploads to landing-media via the service role. We sit in front of
// it so we can authenticate the user, debit credits, and avoid exposing
// the service-role key to the browser.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { profile_id, video_urls } = req.body || {}
    if (!profile_id || !Array.isArray(video_urls) || video_urls.length < 2) {
      return res.status(400).json({ error: 'profile_id + at least 2 video_urls required' })
    }
    await assertProfileAccess(auth.user.id, profile_id)

    // Pre-flight credit check (concat is server CPU time; charge a flat fee
    // proportional to clip count so heavy stitches cost more).
    const cust = await supaFetch(`billing_customers?user_id=eq.${auth.user.id}&select=id`)
    const customerId = cust?.[0]?.id
    const fee = 1500 + 500 * video_urls.length
    if (customerId) {
      const pools = await supaFetch(`credit_pools?customer_id=eq.${customerId}&pool_type=eq.ai_tokens&select=balance`)
      if ((Number(pools?.[0]?.balance ?? 0)) < fee) {
        return res.status(402).json({ error: 'Insufficient AI tokens for combine.', code: 'insufficient_credits' })
      }
    }

    const SUPABASE_URL = process.env.SUPABASE_URL
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
    if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Storage not configured' })

    // Edge function is deployed at:
    //   https://<project>.supabase.co/functions/v1/combine-videos
    const r = await fetch(`${SUPABASE_URL}/functions/v1/combine-videos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ profile_id, video_urls }),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) {
      return res.status(502).json({ error: body?.error || `Edge function failed (${r.status})`, raw: body })
    }
    if (!body?.video_url) return res.status(502).json({ error: 'Edge function returned no URL', raw: body })

    if (customerId) {
      try {
        await supaFetch('rpc/consume_credits', {
          method: 'POST',
          body: {
            p_customer_id: customerId,
            p_pool_type: 'ai_tokens',
            p_amount: fee,
            p_action: 'consume:combine-videos',
            p_profile_id: profile_id,
            p_metadata: { clips: video_urls.length },
          },
        })
      } catch {}
    }

    return res.status(200).json({ video_url: body.video_url })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
