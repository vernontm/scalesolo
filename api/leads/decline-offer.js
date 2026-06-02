// PUBLIC endpoint: visitor declined a funnel offer.
// POST { email, offer: 'tripwire' | 'dfy', source_url? }
//
// When a visitor confirms "no thanks" on the tripwire offer, send them
// the free Blueprint and tag the contact. The Blueprint is held back at
// opt-in time and delivered here, so the tripwire page has real stakes
// and the shame-decline modal converts some declines back into yeses.
//
// For DFY decline, we just log the activity (the visitor is later in the
// funnel and almost always already has the Blueprint).

import { setCors, supaFetch } from '../_lib/supabase.js'
import { brandedEmail, ctaButton, sendEmailSafe } from '../_lib/email.js'
import { mailerliteTagDeclined } from '../_lib/mailerlite.js'

// Use the tracked-redirect endpoint so we can log every click. The
// endpoint 302s to the real Supabase URL after writing an activity log
// row. Pass the contact's email so the endpoint can resolve their id.
const APP_URL = process.env.SCALESOLO_DOMAIN || process.env.FRONTEND_URL || 'https://scalesolo.ai'
const blueprintLink = (email) => `${APP_URL}/api/r/blueprint?src=email-decline&e=${encodeURIComponent(email)}`

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

    // For the tripwire decline, deliver the Blueprint NOW.
    if (offer === 'tripwire') {
      if (tags.has('blueprint:pending')) {
        await sendEmailSafe({
          to: email,
          subject: 'Here is your Faceless AI Brand Blueprint',
          html: brandedEmail({
            preheader: 'Your free Faceless AI Brand Blueprint is inside.',
            body:
              '<p style="margin:0 0 12px;font-size:18px;font-weight:700;color:#0c0c0d;">Your Blueprint is ready.</p>' +
              '<p style="margin:0 0 4px;">No worries on passing on the playbook. Here is the free Blueprint you came for, yours to keep.</p>' +
              ctaButton({ label: 'Download the Blueprint', url: blueprintLink(email) }) +
              '<p style="margin:14px 0 0;">One tip: do not skip Chapter 2, the brand voice step. It is the part most people skip, and the reason most pages end up sounding like a robot.</p>' +
              '<p style="margin:12px 0 0;">When you are ready to make it actually pay, the playbook will still be there.</p>' +
              '<p style="margin:12px 0 0;">See you on the inside,<br>Rayvaughn · ScaleSolo</p>',
          }),
        })
        tags.delete('blueprint:pending')
        tags.add('blueprint:sent')
      }
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
