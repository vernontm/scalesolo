// POST /api/studio/apply-template
// Body: { studio_video_id, template_id, brand_color, deep? }
//
// Two modes:
//
//   Shallow (default, fast, cheap):
//     - Patches studio_videos.template_id + brand_color
//     - Bulk-updates every motion-graphics segment's
//       hyperframes_variables.accent_color so the new color flows
//       into the next bake
//     - Resets motion segments to status='pending' so the UI shows
//       "needs re-render" on those rows
//     - Leaves voice/image/avatar URLs alone — they're style-agnostic
//
//   Deep (deep=true, slow, expensive):
//     - Same as shallow, then ALSO kicks off generate-map with the new
//       template so Claude re-segments according to the new template's
//       pacing + composition pool + SFX guidance
//     - Wipes existing segments (caller must have already shown a
//       confirm dialog). The /api/studio/generate-map endpoint already
//       has the confirm_wipe_render guard; we forward through it.
//
// Either way the existing final_video_url stays on the row, so the
// previously-rendered MP4 keeps playing until the next bake replaces
// it. Defense against the "I switched template and lost my video"
// surprise.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { gateStudio } from './_lib/gate.js'
import { getTemplate } from './_lib/templates.js'
import { invokeHandler } from '../_lib/internal-invoke.js'
import generateMapHandler from './generate-map.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    gateStudio(auth.user.id)

    const videoId = req.body?.studio_video_id
    const templateId = req.body?.template_id
    const brandColor = req.body?.brand_color || null
    const deep = req.body?.deep === true
    if (!videoId) return res.status(400).json({ error: 'studio_video_id required' })
    if (!templateId) return res.status(400).json({ error: 'template_id required' })

    const vRows = await supaFetch(`studio_videos?id=eq.${videoId}&select=*&limit=1`)
    const video = vRows?.[0]
    if (!video) return res.status(404).json({ error: 'Video not found' })
    await assertProfileAccess(auth.user.id, video.profile_id)

    // Validate template_id resolves to a real template. getTemplate
    // falls back to SLEEK on unknown id, so we check the round-trip.
    const tmpl = getTemplate(templateId)
    if (tmpl.id !== templateId) {
      return res.status(400).json({ error: `Unknown template_id: ${templateId}` })
    }
    const resolvedAccent = brandColor || tmpl.colors.primary_accent

    // 1. Patch parent video row
    await supaFetch(`studio_videos?id=eq.${videoId}`, {
      method: 'PATCH',
      body: { template_id: templateId, brand_color: brandColor },
      prefer: 'return=minimal',
    })

    if (deep) {
      // Caller is in the "wipe + re-segment" path. Kick off generate-map
      // server-side instead of relying on a client-side fan-out. We
      // pass confirm_wipe_render so the destructive-action guard
      // doesn't bounce us.
      // In-process invoke. Self-fetching the public URL would hit
      // Vercel Deployment Protection's SSO wall on preview deployments
      // and 401, surfacing as a silent "deep template apply did nothing"
      // bug. Fire-and-forget — the per-video poller will surface state.
      invokeHandler(generateMapHandler, req, {
        method: 'POST',
        body: {
          studio_video_id: videoId,
          confirm_wipe_render: true,
        },
      }).catch(() => { /* surfaces on the per-video poller via status */ })
      return res.status(202).json({
        ok: true,
        deep: true,
        message: 'Re-segmenting with the new template. Watch the map for the new draft.',
      })
    }

    // 2. Shallow path: bulk-update motion segments' accent_color so the
    // new color flows into the next bake. We only touch the variables
    // jsonb, not the composition_id — the user keeps whatever cards
    // they had, just in a new accent.
    const segments = await supaFetch(
      `studio_segments?studio_video_id=eq.${videoId}&segment_type=in.(voiceover_motion_graphics,pure_motion_graphics)&select=id,hyperframes_variables&limit=200`
    )
    let updated = 0
    for (const s of segments || []) {
      const vars = (s.hyperframes_variables && typeof s.hyperframes_variables === 'object')
        ? { ...s.hyperframes_variables } : {}
      if (vars.accent_color === resolvedAccent) continue  // already set, skip
      vars.accent_color = resolvedAccent
      await supaFetch(`studio_segments?id=eq.${s.id}`, {
        method: 'PATCH',
        body: { hyperframes_variables: vars, status: 'pending' },
        prefer: 'return=minimal',
      })
      updated++
    }

    return res.status(200).json({
      ok: true,
      deep: false,
      template_id: templateId,
      brand_color: resolvedAccent,
      motion_segments_updated: updated,
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
