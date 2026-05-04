// PUBLIC form submission endpoint.
// POST { form_id?, slug?, profile_id?, payload, source_url? }
//
// - Looks up the form (must be is_published=true).
// - Honeypot check: if payload contains a non-empty 'hp' field, drop silently.
// - Rate limit (per-IP per-form): up to spam.rate_limit submissions per hour.
// - Upserts an email_contacts row (dedup on email).
// - Inserts form_submissions and a contact_activity event.
// - Runs the form's confirmation action (return message / redirect URL).

import { setCors, supaFetch } from '../_lib/supabase.js'

// in-memory rate limit per-instance — best-effort; real solution in M8
const rateMap = new Map()
function rateAllowed(key, perHour) {
  const now = Date.now()
  const arr = (rateMap.get(key) || []).filter((t) => now - t < 60 * 60 * 1000)
  arr.push(now)
  rateMap.set(key, arr)
  return arr.length <= perHour
}

function emailish(payload) {
  if (!payload || typeof payload !== 'object') return null
  for (const v of Object.values(payload)) {
    if (typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return v
  }
  return null
}

function nameish(payload) {
  if (!payload) return ''
  return payload.name || payload.full_name || payload.first_name || ''
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const body = req.body || {}
    const payload = body.payload || {}
    const sourceUrl = body.source_url || (req.headers.referer || '')
    const ua = req.headers['user-agent'] || ''
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || ''

    // Find form
    let form
    if (body.form_id) {
      const rows = await supaFetch(`forms?id=eq.${body.form_id}&select=*`)
      form = rows?.[0]
    } else if (body.slug && body.profile_id) {
      const rows = await supaFetch(`forms?profile_id=eq.${body.profile_id}&slug=eq.${encodeURIComponent(body.slug)}&select=*`)
      form = rows?.[0]
    }
    if (!form) return res.status(404).json({ error: 'Form not found' })
    if (!form.is_published) return res.status(403).json({ error: 'Form is not published' })

    // Honeypot
    if (form.spam?.honeypot && payload.hp) return res.status(200).json({ ok: true, ignored: true })

    // Rate limit
    const limit = form.spam?.rate_limit ?? 10
    if (limit > 0 && !rateAllowed(`${form.id}:${ip}`, limit)) {
      return res.status(429).json({ error: 'Too many submissions, slow down.' })
    }

    // Upsert email contact (dedup by email)
    const email = emailish(payload)
    let contactId = null
    if (email) {
      const existing = await supaFetch(
        `email_contacts?profile_id=eq.${form.profile_id}&email=eq.${encodeURIComponent(email)}&select=id,tags`
      )
      if (existing && existing.length) {
        contactId = existing[0].id
      } else {
        const created = await supaFetch('email_contacts', {
          method: 'POST',
          body: {
            profile_id: form.profile_id,
            email,
            name: nameish(payload),
            source: `form:${form.slug}`,
            signed_up_at: new Date().toISOString(),
          },
        })
        contactId = (Array.isArray(created) ? created[0] : created).id
      }
    }

    // Insert submission
    const subRow = await supaFetch('form_submissions', {
      method: 'POST',
      body: {
        form_id: form.id,
        profile_id: form.profile_id,
        contact_id: contactId,
        payload,
        source_url: sourceUrl,
        ip_address: ip || null,
        user_agent: ua,
      },
    })
    const submission = Array.isArray(subRow) ? subRow[0] : subRow

    // Activity event
    if (contactId) {
      await supaFetch('rpc/log_activity', {
        method: 'POST',
        body: {
          p_profile_id: form.profile_id,
          p_contact_id: contactId,
          p_event_type: 'form_submitted',
          p_payload: { form_id: form.id, form_name: form.name, submission_id: submission.id },
          p_source: 'webhook',
        },
      }).catch(() => {})
    }

    // Confirmation action
    const confirmation = form.confirmation || { kind: 'message', message: 'Thanks — we got it.' }
    return res.status(200).json({ ok: true, confirmation, submission_id: submission.id })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
