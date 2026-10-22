// AI composer for campaign email. Drafts (or rewrites) subject, preview
// text and body HTML in the brand's voice, from the same brand context
// every other generator uses. Ported from the VTM CRM's email-template-ai.
//
//   POST { profile_id, prompt, kind?: 'blast' | 'welcome', current?: { subject, html_body } }
//   ->   { subject, preview_text, html_body, usage }
//
// Credits: total tokens are consumed from ai_tokens after the call, best
// effort, matching agent chat.

import { setCors, requireUser, supaFetch, assertMinRole, isUuid } from '../_lib/supabase.js'
import { message } from '../_lib/anthropic.js'
import { loadBrandContext, renderBrandContextMarkdown } from '../_lib/brand-context.js'
import { customerIdForUser } from '../_lib/credits.js'

export const config = { maxDuration: 60 }

const stripDashes = (s) => String(s || '').replace(/—/g, ',').replace(/–/g, ' to ')

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const auth = await requireUser(req, res)
  if (!auth) return

  const body = req.body || {}
  if (!isUuid(body.profile_id)) return res.status(400).json({ error: 'profile_id required' })
  const prompt = String(body.prompt || '').trim().slice(0, 4000)
  if (!prompt) return res.status(400).json({ error: 'Tell the composer what the email is about.' })

  try {
    await assertMinRole(auth.user.id, body.profile_id, 'editor')
    const [ctx, profiles, configs] = await Promise.all([
      loadBrandContext(body.profile_id, { skip: ['disliked'] }),
      supaFetch(`profiles?id=eq.${encodeURIComponent(body.profile_id)}&select=business_name,brand_primary_color,brand_secondary_color,logo_url,website_url,location`),
      supaFetch(`email_config?profile_id=eq.${encodeURIComponent(body.profile_id)}&select=from_name&limit=1`),
    ])
    const p = profiles?.[0] || {}
    const cfg = configs?.[0] || {}
    const businessName = p.business_name || 'the brand'
    const primary = p.brand_primary_color || '#E8650A'
    const secondary = p.brand_secondary_color || '#1a1a2e'
    const kind = body.kind === 'welcome' ? 'welcome' : 'blast'
    const current = body.current && (body.current.subject || body.current.html_body) ? body.current : null

    const system = `You write marketing email for ${businessName} and you output production-ready HTML.

${renderBrandContextMarkdown(ctx, { bibleCharLimit: 5000 })}

DESIGN FACTS:
- Sender name: ${cfg.from_name || businessName}
- Primary color (buttons, accents): ${primary}
- Secondary color (headings): ${secondary}
- Website: ${p.website_url || 'n/a'}
${p.logo_url ? `- Logo: <img src="${p.logo_url}" alt="${businessName}" style="max-width:160px;height:auto;display:block;margin:0 auto 24px;">` : `- No logo: open with <h1 style="color:${secondary};text-align:center;margin:0 0 24px;">${businessName}</h1>`}

EMAIL TYPE: ${kind === 'welcome' ? 'WELCOME email for a brand new subscriber. Warm, thankful, set expectations, one CTA.' : 'BROADCAST to the existing list. Punchy hook, real value, one clear CTA.'}

RULES:
1. Output ONLY a JSON object, no code fences: { "subject": "...", "preview_text": "...", "html_body": "..." }
2. html_body is the INNER body only: no <html>, <head> or <body>. Our renderer wraps it in a 600px shell and appends the unsubscribe footer, so do not write a footer or an unsubscribe line yourself.
3. Inline styles only. No <style> blocks, no scripts, no external CSS. Single column.
4. One CTA button: <a href="..." style="display:inline-block;padding:14px 32px;background:${primary};color:#ffffff;border-radius:8px;text-decoration:none;font-weight:700;">Label</a>
5. Personalize with {{first_name}} where it reads naturally. Leave other merge tags alone.
6. Short, scannable, in the brand's voice. Name specific dishes, products or offers; never a vague "our food" or "our services".
7. No em dashes and no en dashes anywhere. Use commas, periods, colons or the word "to" instead.
8. Subject under 55 characters. Preview text 40 to 90 characters that complements the subject rather than repeating it.
${current ? '9. The user is EDITING an existing draft. Apply their instruction to it and return the full updated email, keeping everything they did not ask to change.' : ''}`

    const userMsg = current
      ? `INSTRUCTION: ${prompt}\n\nCURRENT SUBJECT: ${current.subject || ''}\n\nCURRENT HTML BODY:\n${String(current.html_body || '').slice(0, 60000)}`
      : `Write the email. Brief from the user: ${prompt}`

    const resp = await message({ system, messages: [{ role: 'user', content: userMsg }], max_tokens: 6000 })
    const raw = (resp?.content || []).map((b) => b.text || '').join('').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
    let parsed
    try { parsed = JSON.parse(raw) } catch {
      const m = raw.match(/\{[\s\S]*\}/)
      if (!m) return res.status(502).json({ error: 'The composer returned something unreadable. Try again.' })
      try { parsed = JSON.parse(m[0]) } catch { return res.status(502).json({ error: 'The composer returned something unreadable. Try again.' }) }
    }

    const usage = resp?.usage || {}
    const total = (usage.input_tokens || 0) + (usage.output_tokens || 0)
    if (total > 0) {
      const customerId = await customerIdForUser(auth.user.id).catch(() => null)
      if (customerId) {
        await supaFetch('rpc/consume_credits', {
          method: 'POST', prefer: 'return=minimal',
          body: { p_customer_id: customerId, p_pool_type: 'ai_tokens', p_amount: total, p_action: 'consume:email-compose', p_profile_id: body.profile_id, p_metadata: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, kind } },
        }).catch((e) => console.warn('[email/generate] consume failed', e?.message))
      }
    }

    return res.status(200).json({
      subject: stripDashes(parsed.subject).slice(0, 300),
      preview_text: stripDashes(parsed.preview_text).slice(0, 300),
      html_body: stripDashes(parsed.html_body),
      usage: { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 },
    })
  } catch (e) {
    if (e?.status === 403) return res.status(403).json({ error: e.message || 'Forbidden' })
    console.error('[email/generate]', e)
    return res.status(500).json({ error: e?.message || 'Internal error' })
  }
}
