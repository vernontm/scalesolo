// PUBLIC lead-capture endpoint for the marketing funnel (free-ebook opt-in).
// POST { email, name?, source?, source_url?, hp? }
//
// Saves/dedupes the email into email_contacts under FUNNEL_PROFILE_ID (the
// brand profile that owns the funnel), logs a contact_activity event, and
// returns the next funnel step to redirect to. No auth required.
//
// Requires env FUNNEL_PROFILE_ID = the profile id that should own these leads.

import { setCors, supaFetch } from '../_lib/supabase.js'
import { brandedEmail, ctaButton, sendEmailSafe } from '../_lib/email.js'

const BLUEPRINT_URL = 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/faceless-ai-brand-blueprint.pdf'

// Best-effort per-instance IP rate limit (same approach as forms/submit.js).
const rateMap = new Map()
function rateAllowed(key, perHour = 20) {
  const now = Date.now()
  const arr = (rateMap.get(key) || []).filter((t) => now - t < 60 * 60 * 1000)
  arr.push(now)
  rateMap.set(key, arr)
  return arr.length <= perHour
}

const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const profileId = process.env.FUNNEL_PROFILE_ID
  if (!profileId) {
    return res.status(500).json({ error: 'Lead capture is not configured yet (FUNNEL_PROFILE_ID missing).' })
  }

  try {
    const body = req.body || {}

    // Honeypot — bots fill hidden fields. Pretend success, save nothing.
    const redirect = '/build-your-ai-empire'
    if (body.hp) return res.status(200).json({ ok: true, redirect })

    const email = (body.email || '').toString().trim().toLowerCase()
    if (!isEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' })

    const name = (body.name || '').toString().slice(0, 120)
    const source = (body.source || 'funnel:opt-in').toString().slice(0, 60)
    const sourceUrl = body.source_url || req.headers.referer || ''
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || ''

    if (!rateAllowed(ip || 'anon', 20)) {
      return res.status(429).json({ error: 'Too many requests, please slow down.' })
    }

    // Upsert the contact (dedup on profile_id + email).
    const existing = await supaFetch(
      `email_contacts?profile_id=eq.${profileId}&email=eq.${encodeURIComponent(email)}&select=id`
    )
    let contactId
    if (existing && existing.length) {
      contactId = existing[0].id
    } else {
      const created = await supaFetch('email_contacts', {
        method: 'POST',
        body: {
          profile_id: profileId,
          email,
          name,
          source,
          signed_up_at: new Date().toISOString(),
        },
      })
      contactId = (Array.isArray(created) ? created[0] : created).id
    }

    // Deliver the free guide by email (best-effort, non-fatal).
    await sendEmailSafe({
      to: email,
      subject: 'Here is your Faceless AI Brand Blueprint',
      html: brandedEmail({
        preheader: 'Your free Faceless AI Brand Blueprint is inside.',
        body:
          '<p style="margin:0 0 12px;font-size:18px;font-weight:700;color:#0c0c0d;">Your Blueprint is ready.</p>' +
          '<p style="margin:0 0 4px;">Thanks for grabbing the Faceless AI Brand Blueprint. Here it is, yours to keep.</p>' +
          ctaButton({ label: 'Download the Blueprint', url: BLUEPRINT_URL }) +
          '<p style="margin:14px 0 0;">One tip: do not skip Chapter 2, the brand voice step. It is the part most people skip, and the reason most pages end up sounding like a robot.</p>' +
          '<p style="margin:12px 0 0;">See you on the inside,<br>Rayvaughn · ScaleSolo</p>',
      }),
    })

    // Activity timeline event (non-fatal).
    await supaFetch('rpc/log_activity', {
      method: 'POST',
      body: {
        p_profile_id: profileId,
        p_contact_id: contactId,
        p_event_type: 'lead_opt_in',
        p_payload: { source, source_url: sourceUrl },
        p_source: 'webhook',
      },
    }).catch(() => {})

    return res.status(200).json({ ok: true, redirect })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' })
  }
}
