// Cron: scan for avatar_renders rows stuck in 'generating_clips' or
// other transient states for > 30 minutes, mark them failed, and
// refund the consume:photo-avatar-render charge.
//
// Why: a user can close their tab mid-poll and the render row sits
// in 'generating_clips' forever — consuming a video_unit they never
// got to use. Without this sweeper, support has to manually credit.
//
// Schedule (vercel.json crons): runs every 15 minutes.
// Authentication: CRON_SECRET bearer (Vercel Cron auto-injects).

import { setCors, supaFetch } from '../_lib/supabase.js'
import { refundConsumeByMetadata } from '../_lib/credits.js'
import { getVideoStatusV3Direct } from '../_lib/heygen.js'

const STUCK_AFTER_MINUTES = 30
const TRANSIENT_STATES = ['generating_clips', 'pending', 'processing', 'queued', 'submitted']

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }
  // Cron-secret auth. Same pattern as affiliates-close.
  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || !bearer || bearer !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60 * 1000).toISOString()
    const filter = [
      `status=in.(${TRANSIENT_STATES.join(',')})`,
      `created_at=lt.${encodeURIComponent(cutoff)}`,
    ].join('&')
    const stuck = await supaFetch(
      `avatar_renders?${filter}&select=id,heygen_video_id,profile_id,created_at,status&limit=200`
    ).catch(() => [])

    let swept = 0
    let refunded = 0
    let rescued = 0
    for (const row of stuck || []) {
      try {
        // Poll HeyGen first. If the render actually completed and we
        // just never persisted the status (e.g. user closed the tab
        // mid-poll, photo-render-status never got called), promote
        // the row to 'completed' instead of marking it failed +
        // refunding a charge the user got real value for. This was
        // the bug behind admin Usage showing 'failed' rows with full
        // cost on renders the user actually received.
        if (row.heygen_video_id) {
          try {
            const r = await getVideoStatusV3Direct(row.heygen_video_id)
            const data = r?.data || r
            const hgStatus = String(data?.status || '').toLowerCase()
            const url = data?.video_url || data?.video_url_caption || data?.url
            if ((hgStatus === 'completed' || hgStatus === 'success' || hgStatus === 'done') && url) {
              await supaFetch(`avatar_renders?id=eq.${row.id}`, {
                method: 'PATCH',
                body: { status: 'completed', final_video_url: url },
                prefer: 'return=minimal',
              })
              rescued += 1
              continue
            }
          } catch (e) {
            console.warn('sweep-stale-renders: heygen poll failed, falling through to mark failed', row.id, e?.message)
          }
        }
        await supaFetch(`avatar_renders?id=eq.${row.id}`, {
          method: 'PATCH',
          body: { status: 'failed', error: 'Sweeper: render did not complete within timeout' },
          prefer: 'return=minimal',
        })
        swept += 1
        if (row.heygen_video_id) {
          const r = await refundConsumeByMetadata({
            originalAction: 'consume:photo-avatar-render',
            metadataKey: 'heygen_video_id',
            metadataValue: row.heygen_video_id,
            profileId: row.profile_id,
          })
          if (r.refunded) refunded += 1
        }
      } catch (e) {
        console.warn('sweep-stale-renders: row failed', row.id, e?.message)
      }
    }

    return res.status(200).json({
      swept,
      rescued,
      refunded,
      cutoff,
      examined: (stuck || []).length,
    })
  } catch (err) {
    console.error('sweep-stale-renders error:', err?.stack || err)
    return res.status(500).json({ error: err.message })
  }
}
