// PUBLIC lead-capture endpoint for the marketing funnel (free-ebook opt-in).
// POST { email, name?, source?, source_url?, hp? }
//
// Saves/dedupes the email into email_contacts under FUNNEL_PROFILE_ID (the
// brand profile that owns the funnel), logs a contact_activity event, sends
// the free Blueprint immediately via Resend, and returns the next funnel
// step to redirect to. No auth required.
//
// Requires env FUNNEL_PROFILE_ID = the profile id that should own these leads.

import { setCors, supaFetch } from '../_lib/supabase.js'
import { mailerliteTagLead } from '../_lib/mailerlite.js'
import { sendEmailSafe } from '../_lib/email.js'

// The free Blueprint is delivered HERE, on opt-in, as a Resend transactional
// email. This is the canonical magnet delivery. It deliberately does NOT
// depend on the MailerLite Lead nurture surviving a fast tripwire decline:
// the decline win-back removes the lead from the Lead group, which used to
// race with and clobber the MailerLite Day-0 email and left fast-decliners
// with no guide. Sending on opt-in guarantees every lead gets the guide
// within seconds. Idempotent via the blueprint:sent tag so repeat opt-ins
// never double-send.
//
// NOTE: the MailerLite Lead nurture Day-0 email still also delivers the
// guide. Repoint that Day-0 to a welcome / "did you get it" message (or
// remove it) so leads are not emailed the guide twice.

const BLUEPRINT_URL =
  process.env.FUNNEL_BLUEPRINT_URL ||
  'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/build-your-ai-empire.pdf'

// Plain-text Blueprint email. No template, no buttons — reads like a
// personal note from Rayvaughn, which lands in the primary inbox better.
// Returns { text, html } where html is a minimal, unstyled fallback with a
// clickable link (Resend sends multipart; text is the canonical version).
function blueprintEmail() {
  const url = BLUEPRINT_URL
  const text = [
    'Hey, it is Rayvaughn.',
    '',
    'You asked for the Faceless AI Brand Blueprint, so here it is. This is the exact framework I use to build faceless AI brands that run without me on camera.',
    '',
    'Download it here:',
    url,
    '',
    'Open it today while the reason you signed up is still fresh, and start with the brand voice section. That is the part most people skip, and it is the part that makes a faceless brand feel like a real person instead of a content farm.',
    '',
    'If you ever have a question, just reply to this email. It comes straight to me.',
    '',
    'Talk soon,',
    'Rayvaughn',
    'ScaleSolo',
  ].join('\n')
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const html =
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#111111;white-space:pre-wrap;">' +
    esc(text).replace(url, '<a href="' + url + '">' + url + '</a>') +
    '</div>'
  return { text, html }
}

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
      `email_contacts?profile_id=eq.${profileId}&email=eq.${encodeURIComponent(email)}&select=id,tags`
    )
    const alreadySent = Boolean(existing && existing.length && (existing[0].tags || []).includes('blueprint:sent'))
    let contactId
    if (existing && existing.length) {
      contactId = existing[0].id
      const tags = Array.from(new Set([...(existing[0].tags || []), 'funnel:lead-opt-in', 'blueprint:pending']))
      await supaFetch(`email_contacts?id=eq.${contactId}`, {
        method: 'PATCH',
        body: { tags, status: 'active' },
      }).catch(() => {})
    } else {
      const created = await supaFetch('email_contacts', {
        method: 'POST',
        body: {
          profile_id: profileId,
          email,
          name,
          source,
          tags: ['funnel:lead-opt-in', 'blueprint:pending'],
          signed_up_at: new Date().toISOString(),
        },
      })
      contactId = (Array.isArray(created) ? created[0] : created).id
    }

    // Deliver the Blueprint via Resend now (idempotent + best-effort: a
    // Resend hiccup must not 500 the opt-in).
    if (!alreadySent) {
      const { text, html } = blueprintEmail()
      const sent = await sendEmailSafe({
        to: email,
        subject: 'Your Faceless AI Brand Blueprint is inside',
        html,
        text,
      })
      if (sent) {
        const finalTags = new Set(existing && existing.length ? (existing[0].tags || []) : [])
        finalTags.add('funnel:lead-opt-in')
        finalTags.delete('blueprint:pending')
        finalTags.add('blueprint:sent')
        await supaFetch(`email_contacts?id=eq.${contactId}`, {
          method: 'PATCH',
          body: { tags: Array.from(finalTags) },
        }).catch(() => {})
      }
    }

    // Push to MailerLite as a LEAD. MUST be awaited — Vercel serverless can
    // terminate the function the moment we return, killing in-flight fetches.
    // Wrapped so a MailerLite outage still doesn't 500 the opt-in.
    try { await mailerliteTagLead({ email, name }) } catch (e) {
      console.warn('[subscribe] mailerlite sync failed:', e?.message || e)
    }

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

    return res.status(200).json({ ok: true, redirect, email })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' })
  }
}
