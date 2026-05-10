// /api/admin/usage/user-detail — per-user video pipeline cost breakdown
// for the admin Usage page. Click a row in the "Top users" table → see
// every avatar render this user produced and what each cost, plus the
// stitching / polish / caption events that ran on top of them.
//
// Query:
//   ?customer_id=<billing_customers.id>
//   ?window=24h | 7d | 30d | all   (default 7d; 'all' bypasses the cutoff)
//
// Response:
//   {
//     customer_id, email, user_id, window, since,
//     videos: [{                               // each avatar_renders row, charged or not
//       render_id, status, created_at, model_version, engine,
//       duration_secs, heygen_video_id, video_url, thumbnail_url,
//       avatar_id, avatar_name,
//       render_cost_usd, render_units,
//     }],
//     post_processing: [{                      // combine / polish / captions / auto-title
//       id, action, created_at, units, est_usd, profile_id, metadata,
//     }],
//     totals: {
//       videos_count, render_cost_usd,
//       post_processing_cost_usd, total_usd,
//     },
//   }
//
// Cost is the same estimateCogsUsd() the rollup endpoint uses, so the
// numbers reconcile against the user's row in the main table.

import { setCors, requireAdmin, supaFetch } from '../../_lib/supabase.js'
import { estimateCogsUsd } from '../../_lib/cogs.js'

const WINDOWS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d':  7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

// Actions tied to render charges. Avatar renders use either of the
// first two (heygen vs photo), and the credit_transactions rows reference
// avatar_renders via ref_table + ref_id. Anything else lives in
// post-processing.
const RENDER_ACTIONS = new Set(['consume:avatar-render', 'consume:photo-avatar-render'])
const POST_PROCESSING_ACTIONS = new Set([
  'consume:combine-videos',
  'consume:video-polish',
  'consume:zapcap-captions',
  'consume:auto-title',
])

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireAdmin(req, res)
  if (!auth) return

  const customerId = req.query.customer_id
  if (!customerId) return res.status(400).json({ error: 'customer_id required' })
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customerId)) {
    return res.status(400).json({ error: 'invalid customer_id' })
  }
  const win = (req.query.window || '7d').toString()
  const since = win === 'all'
    ? null
    : new Date(Date.now() - (WINDOWS[win] || WINDOWS['7d'])).toISOString()

  try {
    const customers = await supaFetch(
      `billing_customers?id=eq.${customerId}&select=id,user_id,email`
    )
    const customer = customers?.[0]
    if (!customer) return res.status(404).json({ error: 'customer not found' })

    // 1. Video-pipeline credit transactions for this customer in the window.
    //    A single PostgREST call grabs everything; we partition in JS.
    const tsFilter = since ? `&created_at=gte.${encodeURIComponent(since)}` : ''
    const txns = await supaFetch(
      `credit_transactions?customer_id=eq.${customerId}&delta=lt.0${tsFilter}` +
      `&action=in.(${[...RENDER_ACTIONS, ...POST_PROCESSING_ACTIONS].map((a) => encodeURIComponent(a)).join(',')})` +
      `&select=id,action,pool_type,delta,profile_id,ref_table,ref_id,metadata,created_at` +
      `&order=created_at.desc&limit=2000`
    )

    // Index render charges by ref_id so we can stitch onto avatar_renders.
    const renderCostByRefId = new Map()
    const postProcessing = []
    for (const t of (txns || [])) {
      const units = Math.abs(Number(t.delta) || 0)
      const cost = estimateCogsUsd(t)
      if (RENDER_ACTIONS.has(t.action) && t.ref_id) {
        const cur = renderCostByRefId.get(t.ref_id) || { units: 0, est_usd: 0 }
        cur.units += units; cur.est_usd += cost
        renderCostByRefId.set(t.ref_id, cur)
      } else if (POST_PROCESSING_ACTIONS.has(t.action)) {
        postProcessing.push({
          id: t.id,
          action: t.action,
          created_at: t.created_at,
          units, est_usd: cost,
          profile_id: t.profile_id,
          metadata: t.metadata,
        })
      }
    }

    // 2. avatar_renders for this user (joined to avatars for name).
    //    We pull renders by profile_access — every profile this user
    //    can write to. Cheaper than scanning all renders.
    const accesses = await supaFetch(
      `profile_access?user_id=eq.${customer.user_id}&select=profile_id`
    ).catch(() => [])
    const profileIds = (accesses || []).map((a) => a.profile_id).filter(Boolean)

    let videos = []
    if (profileIds.length) {
      const sinceClause = since ? `&created_at=gte.${encodeURIComponent(since)}` : ''
      // NOTE the column names: avatar_renders has `final_video_url`
      // (not `video_url`) and no `thumbnail_url`. Selecting non-existent
      // columns makes PostgREST 400 the request, which our .catch then
      // swallows into an empty array — silent "0 renders" bug.
      const renders = await supaFetch(
        `avatar_renders?profile_id=in.(${profileIds.map((p) => encodeURIComponent(p)).join(',')})${sinceClause}` +
        `&select=id,profile_id,avatar_id,status,created_at,model_version,duration_secs,heygen_video_id,final_video_url,video_units_charged` +
        `&order=created_at.desc&limit=500`
      ).catch((e) => { console.warn('user-detail renders fetch failed:', e?.message); return [] })

      // Resolve avatar names in one shot.
      const avatarIds = Array.from(new Set((renders || []).map((r) => r.avatar_id).filter(Boolean)))
      let avatarById = new Map()
      if (avatarIds.length) {
        const avs = await supaFetch(
          `avatars?id=in.(${avatarIds.map((i) => encodeURIComponent(i)).join(',')})&select=id,name`
        ).catch(() => [])
        avatarById = new Map((avs || []).map((a) => [a.id, a]))
      }

      videos = (renders || []).map((r) => {
        const cost = renderCostByRefId.get(r.id) || { units: 0, est_usd: 0 }
        // Belt-and-suspenders: when a render has duration_secs +
        // model_version on the row but the consume row never recorded
        // them in metadata (older rows), fall back to computing the
        // HeyGen cost from the avatar_renders row directly so the
        // dashboard never shows $0 on a real render.
        if ((!cost.est_usd || cost.est_usd === 0) && r.duration_secs && r.model_version) {
          const fallback = estimateCogsUsd({
            action: 'consume:avatar-render',
            pool_type: 'video_units',
            delta: -(Number(r.video_units_charged) || 1),
            metadata: { duration_secs: r.duration_secs, model_version: r.model_version },
          })
          if (fallback > 0) cost.est_usd = fallback
        }
        return {
          render_id: r.id,
          status: r.status,
          created_at: r.created_at,
          model_version: r.model_version,
          duration_secs: r.duration_secs,
          heygen_video_id: r.heygen_video_id,
          video_url: r.final_video_url,
          avatar_id: r.avatar_id,
          avatar_name: avatarById.get(r.avatar_id)?.name || null,
          profile_id: r.profile_id,
          render_units: cost.units,
          render_cost_usd: cost.est_usd,
        }
      })
    }

    // 3. Totals.
    const renderCostSum = videos.reduce((s, v) => s + (v.render_cost_usd || 0), 0)
    const postProcessingSum = postProcessing.reduce((s, p) => s + (p.est_usd || 0), 0)
    // Sum of HeyGen seconds across renders. Counts every render including
    // failed ones, since HeyGen bills the second they start generation.
    const totalDurationSecs = videos.reduce((s, v) => s + (Number(v.duration_secs) || 0), 0)

    return res.status(200).json({
      customer_id: customer.id,
      user_id: customer.user_id,
      email: customer.email,
      window: win,
      since,
      videos,
      post_processing: postProcessing,
      totals: {
        videos_count: videos.length,
        total_duration_secs: totalDurationSecs,
        render_cost_usd: renderCostSum,
        post_processing_cost_usd: postProcessingSum,
        total_usd: renderCostSum + postProcessingSum,
      },
    })
  } catch (err) {
    console.error('admin/usage/user-detail error:', err?.stack || err)
    return res.status(500).json({ error: err.message })
  }
}
