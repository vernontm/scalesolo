// PUBLIC endpoint: visitor declined a funnel offer.
// POST { email, offer: 'tripwire' | 'dfy', source_url? }
//
// When a visitor confirms "no thanks" on a shame-decline modal, we:
//   1. Tag the contact 'declined:tripwire' or 'declined:dfy' in Supabase
//   2. Add the matching MailerLite Declined group so the win-back
//      automation can fire (mutual-exclusion removal from Lead must be
//      configured manually in the MailerLite dashboard)
//   3. Log the activity
//
// The Blueprint email itself is delivered by the MailerLite "Lead ·
// Blueprint" automation Day 0 (which fires the moment we add the
// subscriber to the Lead group on opt-in). We do NOT send a duplicate
// Blueprint email from Resend here, because every funnel lead is
// already in the Lead group and the MailerLite Day 0 email lands
// within a minute or two of group-join.
//
// If you ever disable the MailerLite Lead · Blueprint automation, you
// will need to add the Resend Blueprint send back here as the canonical
// magnet delivery (or re-enable /api/cron/funnel-drip).

import { setCors, supaFetch } from '../_lib/supabase.js'
import { mailerliteTagDeclined } from '../_lib/mailerlite.js'

const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const profileId = process.env.FUNNEL_PROFILE_ID
  if (!profileId) return res.status(500).json({ error: 'Funnel is not configured yet (FUNNEL_PROFILE_ID missing).' })

  try {
    const body = req.body || {}
    const email = (body.email || '').toString().trim().toLowerCase()
    const offer = (body.offer || 'tripwire').toString()
    if (!isEmail(email)) return res.status(400).json({ error: 'We need your email to send the free guide.' })

    // Find the contact (the visitor must have opted in earlier).
    const existing = await supaFetch(
      `email_contacts?profile_id=eq.${profileId}&email=eq.${encodeURIComponent(email)}&select=id,tags`
    )
    if (!existing || !existing.length) {
      return res.status(404).json({ error: 'We could not find your signup. Please grab the free guide from the home page.' })
    }
    const contactId = existing[0].id
    const tags = new Set(existing[0].tags || [])

    // Tag the decline. The actual Blueprint delivery comes from the
    // MailerLite Lead · Blueprint Day 0 email (fired on group-join from
    // the opt-in endpoint). We just record the decline state here so
    // the win-back automation has the right group to trigger from.
    if (offer === 'tripwire') {
      tags.add('declined:tripwire')
    } else if (offer === 'dfy') {
      tags.add('declined:dfy')
    }

    await supaFetch(`email_contacts?id=eq.${contactId}`, {
      method: 'PATCH',
      body: { tags: Array.from(tags) },
    }).catch(() => {})

    // Move them into the matching DECLINED group in MailerLite. MUST be
    // awaited — Vercel serverless can terminate the function the moment
    // we return, killing any in-flight fetch. Wrapped so a MailerLite
    // outage doesn't 500 the decline endpoint.
    try { await mailerliteTagDeclined({ email, offer }) } catch (e) {
      console.warn('[decline-offer] mailerlite sync failed:', e?.message || e)
    }

    await supaFetch('rpc/log_activity', {
      method: 'POST',
      body: {
        p_profile_id: profileId,
        p_contact_id: contactId,
        p_event_type: 'offer_declined',
        p_payload: { offer, source_url: body.source_url || req.headers.referer || '' },
        p_source: 'webhook',
      },
    }).catch(() => {})

    return res.status(200).json({ ok: true, redirect: '/welcome?product=blueprint' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' })
  }
}
