// /api/content/generate-cover
//
// Two actions, dispatched via ?action=...
//
//   ?action=start
//     Body: { script_id, edit_instructions? }
//     Reads the row + brand's cover_template (image + base_prompt),
//     submits to gpt-image-2-image-to-image via /api/images/generate
//     with the template as the reference and a prompt that says
//     "swap the title for X" (plus the user's edits if any). Returns
//     the KIE taskId so the client can poll /api/images/status. The
//     underlying endpoint reserves 4000 ai_tokens through
//     withCreditReservation — failure refunds automatically.
//
//   ?action=commit
//     Body: { script_id, image_url }
//     Saves the user-accepted preview as the row's cover_image_url.
//     This is the explicit "Accept this one" step so a user can
//     regenerate multiple times without burning credits on saves.
//
// The client polls /api/images/status?taskId=... between start and
// commit to render the preview as soon as KIE finishes.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'

const DEFAULT_BASE_PROMPT =
  "Keep the existing layout, fonts, colors, and branding exactly the same. " +
  "Only change the title text. Match the original typography weight, kerning, " +
  "and case. Maintain all logos, watermarks, and background imagery as-is."

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  const action = String(req.query.action || '')
  if (action !== 'start' && action !== 'commit') {
    return res.status(400).json({ error: `Unknown action: ${action}. Use start or commit.` })
  }

  try {
    const body = req.body || {}
    if (!body.script_id) return res.status(400).json({ error: 'script_id required' })

    // Pull the row + the brand's cover_template in one shot. We need
    // row.title + row.profile_id, and the brand's image_url + base_prompt.
    const rows = await supaFetch(
      `content_scripts?id=eq.${body.script_id}&select=id,profile_id,title,cover_image_url`
    )
    const row = rows?.[0]
    if (!row) return res.status(404).json({ error: 'Content row not found' })
    await assertProfileAccess(auth.user.id, row.profile_id)

    if (action === 'commit') {
      if (!body.image_url) return res.status(400).json({ error: 'image_url required' })
      const updated = await supaFetch(`content_scripts?id=eq.${body.script_id}`, {
        method: 'PATCH',
        body: { cover_image_url: body.image_url, updated_at: new Date().toISOString() },
        prefer: 'return=representation',
      })
      return res.status(200).json({
        ok: true,
        item: Array.isArray(updated) ? updated[0] : updated,
      })
    }

    // action === 'start' — fetch brand template + submit to image gen.
    const profileRows = await supaFetch(
      `profiles?id=eq.${row.profile_id}&select=cover_template`
    )
    const tpl = profileRows?.[0]?.cover_template
    const templateUrl = tpl?.image_url
    if (!templateUrl) {
      return res.status(409).json({
        error: 'No cover template set for this brand. Add one on the Brand profile page first.',
        code: 'no_cover_template',
      })
    }
    const basePrompt = (tpl?.base_prompt || DEFAULT_BASE_PROMPT).trim()
    const title = String(row.title || '').trim() || 'Untitled'
    const edits = String(body.edit_instructions || '').trim()

    // Build the prompt. Always lead with the base instruction so the
    // model preserves the template; then the new title; then the
    // user's optional edits for this specific render.
    const prompt = [
      basePrompt,
      `New title text: "${title}".`,
      edits ? `Additional edits for this render: ${edits}` : '',
    ].filter(Boolean).join('\n\n')

    // Forward to the existing image-gen endpoint. It handles credit
    // reservation, KIE submission, and returns { taskId, model }.
    // Internal call — same host, forward the auth token.
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim()
    const host  = req.headers['x-forwarded-host'] || req.headers.host
    const base  = `${proto}://${host}`
    const authToken = req.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
    const genResp = await fetch(`${base}/api/images/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        profile_id: row.profile_id,
        prompt,
        model: 'gpt-2',
        count: 1,
        aspect: '9:16',                 // Vertical full-frame — matches Reels / Shorts / TikTok / Stories
        reference_urls: [templateUrl],
        enhance_prompt: false,          // we already gave it precise instructions, don't let the rewriter drift
      }),
    })
    const genBody = await genResp.json().catch(() => ({}))
    if (!genResp.ok) {
      return res.status(genResp.status).json({
        error: genBody?.error || 'Cover generation submit failed',
        code: genBody?.code,
      })
    }

    return res.status(202).json({
      ok: true,
      taskId: genBody.taskId,
      model: genBody.model,
      // Echo back the prompt so the client can show "Generating: …" copy
      // if it wants, and the title used so the client can confirm we
      // rendered the right one.
      title_used: title,
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
