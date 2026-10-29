// PUBLIC lead-capture endpoint for landing-page Lead Capture sections.
// POST { page_id, name, email, phone?, source_url? }
//
// Looks up the page → infers profile_id, upserts email_contacts (dedup on
// email) tagged landing:<slug> so a drip automation can trigger on it,
// inserts an activity event, and returns { ok: true }. Honeypot field 'hp'
// is silently dropped. Suppressed addresses are refused by the shared intake.

import { setCors, supaFetch } from '../_lib/supabase.js'
import { upsertContact } from '../_lib/email-contacts.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// in-memory rate limit per page+IP (best-effort; resets on cold start)
const rateMap = new Map()
function rateAllowed(key, perHour = 30) {
  const now = Date.now()
  const arr = (rateMap.get(key) || []).filter((t) => now - t < 60 * 60 * 1000)
  arr.push(now)
  rateMap.set(key, arr)
  return arr.length <= perHour
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const { page_id, name, email, phone, source_url, hp } = req.body || {}
    if (hp) return res.status(200).json({ ok: true, ignored: true })   // honeypot
    if (!page_id || !email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Valid email required' })
    }

    // Lookup the page → profile + slug for source attribution
    const pageRows = await supaFetch(`landing_pages?id=eq.${page_id}&is_published=eq.true&select=id,profile_id,name,slug`)
    const page = pageRows?.[0]
    if (!page) return res.status(404).json({ error: 'Page not found' })

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || ''
    if (!rateAllowed(`${page.id}:${ip}`)) {
      return res.status(429).json({ error: 'Too many submissions, slow down.' })
    }

    const lower = email.toLowerCase().trim()

    // Upsert through the shared intake, which checks the suppression list.
    // This path used to add whatever address it was handed, so a hard bounce
    // filling in the form again went back onto the list and back onto the
    // bounce rate that governs every brand's SES sending.
    //
    // The page slug also becomes a tag now, not just the source string. A
    // drip automation triggers on a tag, so a lead captured here entered no
    // sequence at all before this: point an automation's trigger at
    // "landing:<slug>" and the welcome series starts within a minute.
    const up = await upsertContact({
      profileId: page.profile_id,
      email: lower,
      name,
      phone,
      tags: [`landing:${page.slug}`],
      source: `landing:${page.slug}`,
    })
    const contactId = up.contact_id

    // Activity event. Guarded because contactId is now null when the address
    // is suppressed, and contact_activity.contact_id is NOT NULL, so this
    // would be a write that always fails.
    if (contactId) {
      await supaFetch('rpc/log_activity', {
        method: 'POST',
        body: {
          p_profile_id: page.profile_id,
          p_contact_id: contactId,
          p_event_type: 'form_submitted',
          p_payload: { source: 'landing_page', page_id: page.id, page_name: page.name, source_url: source_url || null },
          p_source: 'webhook',
        },
      }).catch(() => {})
    }

    return res.status(200).json({ ok: true })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
