// PUBLIC lead-capture endpoint for landing-page Lead Capture sections.
// POST { page_id, name, email, phone?, source_url? }
//
// Looks up the page → infers profile_id, upserts email_contacts (dedup on
// email), inserts a form_submissions-style row + activity event, and returns
// { ok: true }. Honeypot field 'hp' is silently dropped.

import { setCors, supaFetch } from '../_lib/supabase.js'

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

    // Upsert email_contacts on (profile_id, email)
    const existing = await supaFetch(
      `email_contacts?profile_id=eq.${page.profile_id}&email=eq.${encodeURIComponent(lower)}&select=id`
    )
    let contactId = existing?.[0]?.id
    if (!contactId) {
      const created = await supaFetch('email_contacts', {
        method: 'POST',
        body: {
          profile_id: page.profile_id,
          email: lower,
          name: (name || '').trim() || null,
          phone: (phone || '').trim() || null,
          source: `landing:${page.slug}`,
          signed_up_at: new Date().toISOString(),
        },
      })
      contactId = (Array.isArray(created) ? created[0] : created).id
    } else if (name || phone) {
      // Patch with new info if we have it
      const updates = {}
      if (name)  updates.name  = name.trim()
      if (phone) updates.phone = phone.trim()
      if (Object.keys(updates).length) {
        await supaFetch(`email_contacts?id=eq.${contactId}`, {
          method: 'PATCH', body: updates, prefer: 'return=minimal',
        })
      }
    }

    // Activity event
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

    return res.status(200).json({ ok: true })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
