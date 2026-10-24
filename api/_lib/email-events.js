// Shared bookkeeping for email provider webhooks.
//
// SES and Mailgun describe the same events with completely different payloads,
// but what has to happen afterwards is identical: suppress the address, mark
// the contact, update the send row, move the campaign counter. That logic
// lives here so a fix to suppression cannot land in one webhook and silently
// miss the other. The provider-specific files only translate their payload
// into these calls.

import { supaFetch } from './supabase.js'

const enc = encodeURIComponent

export async function bumpCampaign(campaignId, col, n = 1, tag = 'email') {
  if (!campaignId) return
  await supaFetch('rpc/bump_email_campaign_counter', {
    method: 'POST', body: { p_campaign: campaignId, p_col: col, p_n: n }, prefer: 'return=minimal',
  }).catch((e) => console.warn(`[${tag}] bump failed`, col, e?.message))
}

// Global suppression: once an address bounces hard or complains anywhere, it
// is never mailed again for any brand. A 409 means it was already suppressed,
// which is the normal case on a repeat event and not worth logging.
export async function suppress({ email, reason, source }, tag = 'email') {
  await supaFetch('email_suppressions', {
    method: 'POST', prefer: 'return=minimal',
    body: { profile_id: null, email: String(email).toLowerCase(), reason, source },
  }).catch((e) => { if (e?.status !== 409) console.warn(`[${tag}] suppress failed`, e?.message) })
}

export async function markContacts(emails, status, tag = 'email') {
  const list = (emails || []).filter(Boolean)
  if (!list.length) return
  const inList = list.map((e) => `"${String(e).toLowerCase().replace(/"/g, '')}"`).join(',')
  await supaFetch(`email_contacts?email=in.(${inList})&status=eq.active`, {
    method: 'PATCH', body: { status, updated_at: new Date().toISOString() }, prefer: 'return=minimal',
  }).catch((e) => console.warn(`[${tag}] contact status failed`, e?.message))
}

// Find the send row a provider event belongs to. The column is named
// ses_message_id for historical reasons and now holds whichever provider's id
// sent the message. Mailgun reports its id wrapped in angle brackets on send
// and bare in webhooks, so both sides are normalized through here or the
// attribution silently misses and a bounce never suppresses.
export function normalizeMessageId(id) {
  return String(id || '').trim().replace(/^<|>$/g, '')
}

export async function findSend(messageId) {
  const id = normalizeMessageId(messageId)
  if (!id) return null
  const rows = await supaFetch(
    `email_sends?ses_message_id=eq.${enc(id)}&select=id,campaign_id,status,email,opened_at,clicked_at,delivered_at&limit=1`
  )
  return rows?.[0] || null
}

export function sendPatcher(send, tag = 'email') {
  const now = new Date().toISOString()
  return (fields) => send
    ? supaFetch(`email_sends?id=eq.${enc(send.id)}`, {
        method: 'PATCH', body: { ...fields, updated_at: now }, prefer: 'return=minimal',
      }).catch((e) => console.warn(`[${tag}] send patch failed`, e?.message))
    : Promise.resolve()
}
