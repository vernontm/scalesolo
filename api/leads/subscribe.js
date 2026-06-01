// PUBLIC lead-capture endpoint for the marketing funnel (free-ebook opt-in).
// POST { email, name?, source?, source_url?, hp? }
//
// Saves/dedupes the email into email_contacts under FUNNEL_PROFILE_ID (the
// brand profile that owns the funnel), logs a contact_activity event, and
// returns the next funnel step to redirect to. No auth required.
//
// Requires env FUNNEL_PROFILE_ID = the profile id that should own these leads.

import { setCors, supaFetch } from '../_lib/supabase.js'

// The free Blueprint email is intentionally NOT sent on opt-in. It is sent
// from /api/leads/decline-offer when the visitor explicitly declines the
// tripwire offer, which gives the tripwire page real stakes and converts
// some "no" clicks back into "yes" via the shame-decline modal. Bouncers
// (no engagement either way) get the Blueprint from the drip cron (welcome
// email #1) as a safety net.

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

    // Upsert the contact (dedup on profile_id + email). Tag with
    // funnel:lead-opt-in and blueprint:pending so the drip cron and the
    // decline endpoint know where this contact is in the funnel.
    const existing = await supaFetch(
      `email_contacts?profile_id=eq.${profileId}&email=eq.${encodeURIComponent(email)}&select=id,tags`
    )
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

    // Return the email back so the next-page can stash it in localStorage
    // and pass it to /api/leads/decline-offer if the visitor declines.
    return res.status(200).json({ ok: true, redirect, email })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' })
  }
}
