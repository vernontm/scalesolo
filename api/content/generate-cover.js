// /api/content/generate-cover
//
// Two actions, dispatched via ?action=...
//
//   ?action=start
//     Body: { script_id, edit_instructions? }
//     Reads the row + brand's cover_template (image + base_prompt),
//     submits to gpt-image-2-image-to-image with the template as the
//     reference and a prompt that says "swap the title for X" (plus the
//     user's edits if any). Reserves 4000 ai_tokens through
//     withCreditReservation — failure refunds automatically. Returns the
//     KIE taskId so the client can poll /api/images/status.
//
//   ?action=commit
//     Body: { script_id, image_url }
//     Saves the user-accepted preview as the row's cover_image_url.
//     This is the explicit "Accept this one" step so a user can
//     regenerate multiple times without burning credits on saves.
//
// The client polls /api/images/status?taskId=... between start and
// commit to render the preview as soon as KIE finishes.
//
// We used to proxy `start` through an internal HTTP fetch to
// /api/images/generate so the credit + KIE logic lived in one place.
// On Vercel preview deployments with Deployment Protection turned on,
// that self-fetch hits the SSO wall (the server has no Vercel SSO
// cookie) and comes back 401 — which surfaced to the user as a
// "session expired" banner during bulk-upload cover-gen, even though
// the browser's own JWT was perfectly valid. Inline the submit logic
// here so the call never leaves the function.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { withCreditReservation } from '../_lib/credits.js'

const DEFAULT_BASE_PROMPT =
  "Keep the existing layout, fonts, colors, and branding exactly the same. " +
  "Only change the title text. Match the original typography weight, kerning, " +
  "and case. Maintain all logos, watermarks, and background imagery as-is."

const COVER_MODEL = 'gpt-image-2-image-to-image'
const COVER_ASPECT = '9:16'      // Reels / Shorts / TikTok / Stories
const COVER_FEE = 4000            // same rate /api/images/generate uses

function pickKieError(body, fallbackStatus) {
  const msg = body?.msg || body?.message || body?.error?.message || body?.error || ''
  const code = body?.code != null ? ` (code ${body.code})` : ''
  return msg ? `${msg}${code}` : `KIE error ${fallbackStatus}${code}`
}

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

    // ── action === 'start' ─────────────────────────────────────────────
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

    const prompt = [
      basePrompt,
      `New title text: "${title}".`,
      edits ? `Additional edits for this render: ${edits}` : '',
    ].filter(Boolean).join('\n\n')

    const apiKey = process.env.KIE_API_KEY
    if (!apiKey) return res.status(500).json({ error: 'KIE_API_KEY not configured' })

    // Reserve credits BEFORE submitting to KIE. If the inner fn throws
    // or KIE rejects, refundIfFailed() unwinds the reservation so the
    // user isn't charged for a failed render.
    return await withCreditReservation({
      userId: auth.user.id,
      poolType: 'ai_tokens',
      amount: COVER_FEE,
      action: 'consume:image-gen',
      profileId: row.profile_id,
      metadata: {
        model: COVER_MODEL,
        aspect: COVER_ASPECT,
        count: 1,
        quality: '1K',
        prompt: prompt.slice(0, 200),
        source: 'cover-template',
        script_id: body.script_id,
      },
    }, async ({ refundIfFailed, tagMetadata }) => {
      const submitResp = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: COVER_MODEL,
          input: {
            prompt,
            input_urls: [templateUrl],
            aspect_ratio: COVER_ASPECT,
            num_images: 1,
          },
        }),
      })
      const submitText = await submitResp.text()
      let submit = {}
      try { submit = JSON.parse(submitText) } catch { submit = { raw: submitText } }
      if (!submitResp.ok || (submit?.code && submit.code !== 200)) {
        await refundIfFailed()
        return res.status(502).json({
          error: pickKieError(submit, submitResp.status),
          kie_status: submitResp.status,
          kie_body: submit,
        })
      }
      const taskId = submit?.data?.taskId || submit?.data?.task_id || submit?.taskId
      if (!taskId) {
        await refundIfFailed()
        return res.status(502).json({ error: 'KIE returned no taskId', kie_body: submit })
      }
      // Stash taskId so /api/images/status can refund-by-metadata if the
      // generation later fails inside KIE itself.
      await tagMetadata({ taskId })

      return res.status(202).json({
        ok: true,
        taskId,
        model: COVER_MODEL,
        title_used: title,
      })
    })
  } catch (err) {
    if (err?.code === 'insufficient_credits') {
      return res.status(402).json({ error: err.message, code: 'insufficient_credits', need: err.need })
    }
    return res.status(err.status || 500).json({ error: err.message })
  }
}
