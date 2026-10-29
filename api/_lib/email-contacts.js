// Shared contact intake: one place that decides what happens when an address
// arrives from outside, whoever sent it.
//
// Before this module there were three separate copies of "upsert a contact"
// (api/email/contacts.js, api/landing-pages/lead.js, api/forms/submit.js) and
// they had already drifted apart in the way that matters most: the authored
// admin path refuses to resurrect a suppressed address, and the two public
// paths did not check suppression at all. A bounced address re-submitted
// through a landing page went straight back onto the list. Every brand sends
// through ONE SES account, so a resurrected hard bounce does not just hurt
// that brand, it moves the bounce rate that governs all of them.
//
// The rules, in one place:
//
//   1. An address on email_suppressions is never added or reactivated.
//   2. An existing contact who is unsubscribed, bounced or complained keeps
//      that status. New tags and a name still merge onto the row, so the
//      record stays useful, but nothing flips them back to mailable.
//   3. A new address is created active, because nothing can send to it until
//      a campaign or an automation targets its tags anyway.
//
// Rule 2 is the one worth defending. A Zapier sync pointed at a stale export
// would otherwise quietly re-subscribe everyone who had opted out, which is
// the single most likely way an ingest API turns into a complaint. Someone
// who genuinely re-subscribes is reactivated by hand on the Subscribers tab,
// which is a deliberate human act and leaves a trail.

import { supaFetch } from './supabase.js'

const enc = encodeURIComponent

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const NOT_MAILABLE = ['unsubscribed', 'bounced', 'complained']

export const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max)
export const normEmail = (v) => clean(v, 320).toLowerCase()
export const isEmail = (v) => EMAIL_RE.test(normEmail(v))

// Same shape the Subscribers tab and the automation triggers use: lowercase,
// 40 characters, 20 of them. The cap is why enrollment state lives in a row
// rather than a tag (see migration 0082).
export function normTags(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(',')
  return [...new Set(raw.map((t) => clean(t, 40).toLowerCase()).filter(Boolean))].slice(0, 20)
}

// Merge new tags onto existing ones without blowing the cap, keeping the
// contact's current tags first so an incoming batch of 20 cannot evict the
// tag an automation is keyed on.
export function mergeTags(current, incoming) {
  return [...new Set([...normTags(current), ...normTags(incoming)])].slice(0, 20)
}

export async function suppressedSet(emails) {
  const list = [...new Set((emails || []).filter(Boolean))]
  if (!list.length) return new Set()
  const inList = list.map((e) => `"${String(e).replace(/"/g, '')}"`).join(',')
  const rows = await supaFetch(`email_suppressions?email=in.(${inList})&select=email`).catch(() => [])
  return new Set((rows || []).map((r) => String(r.email).toLowerCase()))
}

// The decision, with no database in it, so the rules above can be tested
// directly rather than inferred from behaviour.
//
// Returns one of:
//   { action: 'skip',   reason }        nothing is written
//   { action: 'insert', row }           a new active contact
//   { action: 'patch',  id, patch }     merge onto an existing one
export function planUpsert({ email, name, phone, tags, source, existing, suppressed, now = new Date() }) {
  const addr = normEmail(email)
  if (!isEmail(addr)) return { action: 'skip', reason: 'invalid' }
  if (suppressed) return { action: 'skip', reason: 'suppressed' }

  const wanted = normTags(tags)

  if (existing) {
    const patch = { updated_at: now.toISOString() }
    const merged = mergeTags(existing.tags, wanted)
    // Only write tags when they actually changed, so a repeat submission of
    // the same form does not bump updated_at on every hit.
    if (merged.length !== normTags(existing.tags).length) patch.tags = merged
    const nm = clean(name, 120)
    if (nm && !clean(existing.name, 120)) patch.name = nm
    const ph = clean(phone, 40)
    if (ph && !clean(existing.phone, 40)) patch.phone = ph

    // Rule 2: never flip a non-mailable contact back to active.
    const status = String(existing.status || '')
    if (NOT_MAILABLE.includes(status)) {
      const touched = Object.keys(patch).filter((k) => k !== 'updated_at')
      if (!touched.length) return { action: 'skip', reason: status, id: existing.id }
      return { action: 'patch', id: existing.id, patch, held: status }
    }
    if (status !== 'active') patch.status = 'active'

    const touched = Object.keys(patch).filter((k) => k !== 'updated_at')
    if (!touched.length) return { action: 'skip', reason: 'unchanged', id: existing.id }
    return { action: 'patch', id: existing.id, patch }
  }

  return {
    action: 'insert',
    row: {
      email: addr,
      name: clean(name, 120) || '',
      phone: clean(phone, 40) || null,
      tags: wanted,
      source: clean(source, 60) || 'api',
      status: 'active',
      signed_up_at: now.toISOString(),
    },
  }
}

// Apply planUpsert against the database for one address.
// Returns { contact_id, created, skipped?, held? }.
export async function upsertContact({ profileId, email, name, phone, tags, source }) {
  const addr = normEmail(email)
  if (!isEmail(addr)) return { contact_id: null, created: false, skipped: 'invalid' }

  const [existingRows, blocked] = await Promise.all([
    supaFetch(
      `email_contacts?profile_id=eq.${enc(profileId)}&email=eq.${enc(addr)}` +
      '&select=id,tags,name,phone,status&limit=1',
    ).catch(() => []),
    suppressedSet([addr]),
  ])

  const plan = planUpsert({
    email: addr, name, phone, tags, source,
    existing: existingRows?.[0] || null,
    suppressed: blocked.has(addr),
  })

  if (plan.action === 'skip') {
    return { contact_id: plan.id || null, created: false, skipped: plan.reason }
  }

  if (plan.action === 'patch') {
    await supaFetch(`email_contacts?id=eq.${enc(plan.id)}`, {
      method: 'PATCH', body: plan.patch, prefer: 'return=minimal',
    })
    return { contact_id: plan.id, created: false, held: plan.held }
  }

  const created = await supaFetch('email_contacts', {
    method: 'POST',
    body: { profile_id: profileId, ...plan.row },
  })
  const row = Array.isArray(created) ? created[0] : created
  return { contact_id: row?.id || null, created: true }
}

// Fire-and-forget activity event. Never allowed to fail an intake: a lead
// that was saved must not 500 because the timeline insert hiccuped.
export async function logContactActivity({ profileId, contactId, eventType, payload }) {
  return supaFetch('rpc/log_activity', {
    method: 'POST',
    body: {
      p_profile_id: profileId,
      p_contact_id: contactId,
      p_event_type: eventType,
      p_payload: payload || {},
      p_source: 'webhook',
    },
  }).catch(() => null)
}
