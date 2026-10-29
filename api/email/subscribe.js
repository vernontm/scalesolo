// Ingest endpoint: add a lead or customer to ONE brand's email list.
//
//   POST /api/email/subscribe
//   x-api-key: ssk_live_...            (or Authorization: Bearer ssk_live_...)
//   { "email": "jane@example.com",
//     "name": "Jane", "phone": "+1...",
//     "tags": ["funnel:lead-opt-in"],
//     "source": "website-footer" }
//
//   -> 200 { ok: true, contact_id, created: true }
//
// The key decides the brand, so there is no profile_id in the body and no way
// for a key to write to a list it does not own.
//
// Tags are the point of this endpoint. A drip automation triggers on a tag
// (migration 0082), so posting a lead with tags: ["funnel:lead-opt-in"] starts
// that brand's sequence on the next runner tick, within a minute. Without a
// tag the contact simply lands on the list and waits for a broadcast.
//
// SERVER SIDE ONLY, by design. There is deliberately no CORS header here, so
// a browser cannot call it: the key is a secret that writes to a client's
// mailing list, and anything pasted into a public page is not a secret. Browser
// forms already have two routes that need no key, api/landing-pages/lead.js
// and api/forms/submit.js, and both now tag what they capture.
//
// What it will not do, all of it enforced in api/_lib/email-contacts.js:
// resurrect a suppressed address, or flip someone who unsubscribed back to
// mailable. Those return ok: true with a `skipped` reason rather than an
// error, because the caller did nothing wrong and retrying will not help.

import { resolveKey, touchKey, keyFromRequest, isMissingTable } from '../_lib/email-api-key.js'
import { upsertContact, logContactActivity, isEmail, clean } from '../_lib/email-contacts.js'

export const config = { maxDuration: 15 }

// Per-key rate limit, best effort and per warm container. A real limit would
// need shared state; this exists to blunt a runaway loop or a hammering bot,
// not to meter usage. 600/hour is far above a plausible signup rate and far
// below anything that would matter to the list.
const RATE_PER_HOUR = 600
const hits = new Map()
function rateAllowed(keyId) {
  const now = Date.now()
  const arr = (hits.get(keyId) || []).filter((t) => now - t < 3600_000)
  arr.push(now)
  hits.set(keyId, arr)
  return arr.length <= RATE_PER_HOUR
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(405).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' })

  const presented = keyFromRequest(req)
  if (!presented) {
    return res.status(401).json({
      error: 'Send your brand key as the x-api-key header, or as an Authorization bearer token.',
      code: 'no_key',
    })
  }

  let key
  try {
    key = await resolveKey(presented)
  } catch (e) {
    if (isMissingTable(e)) {
      return res.status(503).json({
        error: 'Ingest keys are not switched on for this database yet. Apply migration 0084.',
        code: 'migration_pending',
      })
    }
    return res.status(500).json({ error: e.message })
  }

  // One message for a malformed, unknown and revoked key alike: a caller with
  // a bad key learns nothing about which keys exist.
  if (!key) return res.status(401).json({ error: 'That key is not valid.', code: 'bad_key' })

  if (!rateAllowed(key.id)) {
    return res.status(429).json({ error: 'Too many requests for this key, slow down.', code: 'rate_limited' })
  }

  try {
    const body = req.body || {}

    // Honeypot, for a server that is proxying a form it does not control.
    if (body.hp) return res.status(200).json({ ok: true, ignored: true })

    const email = body.email
    if (!isEmail(email)) {
      return res.status(400).json({ error: 'A valid email address is required.', code: 'bad_email' })
    }

    const result = await upsertContact({
      profileId: key.profileId,
      email,
      name: body.name,
      phone: body.phone,
      tags: body.tags,
      source: clean(body.source, 60) || `api:${key.name}`,
    })

    await touchKey(key.id)

    if (result.contact_id && (result.created || !result.skipped)) {
      await logContactActivity({
        profileId: key.profileId,
        contactId: result.contact_id,
        eventType: result.created ? 'lead_opt_in' : 'contact_updated',
        payload: {
          source: clean(body.source, 60) || 'api',
          via: 'api/email/subscribe',
          key_name: key.name,
          tags: body.tags || [],
        },
      })
    }

    return res.status(200).json({
      ok: true,
      contact_id: result.contact_id,
      created: Boolean(result.created),
      ...(result.skipped ? { skipped: result.skipped, note: skipNote(result.skipped) } : {}),
      ...(result.held ? { status_held: result.held } : {}),
    })
  } catch (err) {
    if (isMissingTable(err)) {
      return res.status(503).json({ error: 'Email tables are not ready on this database.', code: 'migration_pending' })
    }
    return res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' })
  }
}

function skipNote(reason) {
  if (reason === 'suppressed') {
    return 'That address bounced or reported spam before, so it stays suppressed and was not added.'
  }
  if (reason === 'unsubscribed') {
    return 'That person unsubscribed, so they were left unsubscribed. Reactivating is a manual step on the Subscribers tab.'
  }
  if (reason === 'bounced' || reason === 'complained') {
    return `That address previously ${reason === 'bounced' ? 'hard bounced' : 'reported spam'}, so it was not made mailable again.`
  }
  if (reason === 'unchanged') return 'Already on the list with these details, nothing to change.'
  return undefined
}
