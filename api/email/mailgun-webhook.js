// Mailgun event webhook. The Mailgun half of what api/email/ses-webhook.js
// does for SES: keeps email_sends, email_contacts, email_suppressions and the
// campaign counters honest.
//
// Point Mailgun at https://www.scalesolo.ai/api/email/mailgun-webhook for
// delivered, permanent_fail, temporary_fail, complained, unsubscribed, opened
// and clicked.
//
// Mapping to the SES semantics already in use:
//   permanent_fail  send -> bounced,    contact -> bounced,    global suppression
//   complained      send -> complained, contact -> complained, global suppression
//   unsubscribed    send -> unchanged,  contact -> unsubscribed
//   temporary_fail  recorded on the send only; the address stays mailable
//
// Env: MAILGUN_WEBHOOK_SIGNING_KEY (Mailgun dashboard, NOT the sending key)

import { createHmac, timingSafeEqual } from 'node:crypto'
import { setCors } from '../_lib/supabase.js'
import { bumpCampaign, suppress, markContacts, findSend, sendPatcher } from '../_lib/email-events.js'

const TAG = 'mailgun-webhook'

// Mailgun signs timestamp + token with the signing key. Without this check
// anyone who learns the URL could mark a brand's whole list as bounced.
export function verifySignature(sig) {
  const key = process.env.MAILGUN_WEBHOOK_SIGNING_KEY
  if (!key) return { ok: false, reason: 'MAILGUN_WEBHOOK_SIGNING_KEY not configured' }
  const { timestamp, token, signature } = sig || {}
  if (!timestamp || !token || !signature) return { ok: false, reason: 'missing signature fields' }

  // Reject anything older than 15 minutes so a captured callback cannot be
  // replayed later.
  const ageSec = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (!Number.isFinite(ageSec) || ageSec > 15 * 60) return { ok: false, reason: 'stale timestamp' }

  const expected = createHmac('sha256', key).update(`${timestamp}${token}`).digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(String(signature), 'utf8')
  if (a.length !== b.length) return { ok: false, reason: 'bad signature' }
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'bad signature' }
}

async function handleEvent(ev) {
  const type = String(ev?.event || '').toLowerCase()
  const severity = String(ev?.severity || '').toLowerCase()
  const recipient = String(ev?.recipient || '').toLowerCase()
  // Mailgun returns the id bare here but wrapped in angle brackets from the
  // send call, so both go through normalizeMessageId inside findSend.
  const messageId = ev?.message?.headers?.['message-id'] || ev?.['message-id'] || null

  const send = await findSend(messageId)
  const patchSend = sendPatcher(send, TAG)
  // Custom variables ride along on every event, which is how an event still
  // attributes to a campaign when the send row was never written.
  const vars = ev?.['user-variables'] || {}
  const campaignId = send?.campaign_id || vars.campaign_id || null
  const isTest = String(vars.test || '') === '1'
  const now = new Date().toISOString()

  switch (type) {
    case 'delivered': {
      if (send && !send.delivered_at) {
        await patchSend({ status: send.status === 'sent' ? 'delivered' : send.status, delivered_at: now })
        if (!isTest) await bumpCampaign(campaignId, 'delivered_count', 1, TAG)
      }
      return { delivered: recipient }
    }

    case 'failed': {
      const reason = [ev?.reason, ev?.['delivery-status']?.message || ev?.['delivery-status']?.description]
        .filter(Boolean).join(': ').slice(0, 500)
      // Only a permanent failure retires the address. A temporary one is
      // recorded and left mailable, matching how SES treats a soft bounce.
      if (severity === 'permanent') {
        if (recipient) {
          await suppress({ email: recipient, reason: 'bounce', source: `mailgun:${ev?.reason || 'permanent'}` }, TAG)
          await markContacts([recipient], 'bounced', TAG)
        }
        if (send && send.status !== 'bounced') {
          await patchSend({ status: 'bounced', error: reason || 'permanent failure' })
          if (!isTest) await bumpCampaign(campaignId, 'bounced_count', 1, TAG)
        }
        return { bounced: recipient, reason }
      }
      await patchSend({ error: `temporary: ${reason}`.slice(0, 500) })
      return { deferred: recipient, reason }
    }

    case 'complained': {
      if (recipient) {
        await suppress({ email: recipient, reason: 'complaint', source: 'mailgun:complained' }, TAG)
        await markContacts([recipient], 'complained', TAG)
      }
      if (send && send.status !== 'complained') {
        await patchSend({ status: 'complained', error: 'spam complaint' })
        if (!isTest) await bumpCampaign(campaignId, 'complained_count', 1, TAG)
      }
      return { complained: recipient }
    }

    case 'unsubscribed': {
      // Mailgun's own unsubscribe link. ScaleSolo's one-click footer goes
      // through api/email/unsubscribe.js instead, so this covers the case
      // where a recipient uses the provider's List-Unsubscribe instead.
      if (recipient) await markContacts([recipient], 'unsubscribed', TAG)
      return { unsubscribed: recipient }
    }

    case 'opened': {
      if (send && !send.opened_at) {
        await patchSend({ opened_at: now })
        if (!isTest) await bumpCampaign(campaignId, 'opened_count', 1, TAG)
      }
      return { opened: recipient }
    }

    case 'clicked': {
      if (send && !send.clicked_at) {
        await patchSend({ clicked_at: now })
        if (!isTest) await bumpCampaign(campaignId, 'clicked_count', 1, TAG)
      }
      return { clicked: recipient }
    }

    default:
      return { ignored: type || 'unknown' }
  }
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body || {}
  const check = verifySignature(body.signature)
  if (!check.ok) {
    console.warn(`[${TAG}] rejected:`, check.reason)
    // 401 rather than 200: Mailgun retries on failure, and a config mistake
    // should be loud and recoverable instead of silently dropping events.
    return res.status(401).json({ error: 'invalid signature' })
  }

  try {
    const out = await handleEvent(body['event-data'] || {})
    // 200 so Mailgun stops retrying. Anything we could not attribute is
    // logged rather than retried forever.
    return res.status(200).json({ ok: true, ...out })
  } catch (e) {
    console.error(`[${TAG}] handler failed`, e?.message)
    // 500 makes Mailgun retry, which is what we want for a transient
    // database blip: the alternative is losing a suppression.
    return res.status(500).json({ error: 'handler failed' })
  }
}
