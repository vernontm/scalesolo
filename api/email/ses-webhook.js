// SES event webhook, fed by SNS (topic scalesolo-ses-events, configuration
// set "scalesolo"). Keeps email_sends, email_contacts and the campaign
// counters in step with what actually happened to each message.
//
//   Bounce (permanent)  send -> bounced, contact -> bounced, global suppression
//   Complaint           send -> complained, contact -> complained, global suppression
//   Delivery / Open / Click / Reject / RenderingFailure   row + counters
//
// Every SNS message is signature-checked against Amazon's signing cert
// before anything is written, and the topic must match SES_SNS_TOPIC_ARN
// when that is set. Public endpoint, no auth header.

import { createVerify } from 'node:crypto'
import { supaFetch } from '../_lib/supabase.js'

const enc = encodeURIComponent
const EXPECTED_TOPIC = process.env.SES_SNS_TOPIC_ARN || ''
const certCache = new Map()

async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return JSON.stringify(req.body)
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8')
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function canonicalString(msg) {
  const fields = msg.Type === 'Notification'
    ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type']
  let s = ''
  for (const f of fields) {
    if (msg[f] === undefined || msg[f] === null) continue
    s += `${f}\n${msg[f]}\n`
  }
  return s
}

async function fetchCert(url) {
  let u
  try { u = new URL(url) } catch { throw new Error('bad SigningCertURL') }
  if (u.protocol !== 'https:' || !/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname) || !u.pathname.endsWith('.pem')) {
    throw new Error('SigningCertURL is not an SNS host')
  }
  if (certCache.has(url)) return certCache.get(url)
  const r = await fetch(url)
  if (!r.ok) throw new Error(`cert fetch ${r.status}`)
  const pem = await r.text()
  certCache.set(url, pem)
  return pem
}

async function verifySignature(msg) {
  if (!msg?.Signature || !msg?.SigningCertURL) return false
  const pem = await fetchCert(msg.SigningCertURL)
  const algo = msg.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1'
  const v = createVerify(algo)
  v.update(canonicalString(msg), 'utf8')
  return v.verify(pem, msg.Signature, 'base64')
}

async function bump(campaignId, col, n = 1) {
  if (!campaignId) return
  await supaFetch('rpc/bump_email_campaign_counter', { method: 'POST', body: { p_campaign: campaignId, p_col: col, p_n: n }, prefer: 'return=minimal' })
    .catch((e) => console.warn('[ses-webhook] bump failed', col, e?.message))
}

async function suppress({ email, reason, source }) {
  await supaFetch('email_suppressions', {
    method: 'POST', prefer: 'return=minimal',
    body: { profile_id: null, email: String(email).toLowerCase(), reason, source },
  }).catch((e) => { if (e?.status !== 409) console.warn('[ses-webhook] suppress failed', e?.message) })
}

async function markContacts(emails, status) {
  if (!emails.length) return
  const list = emails.map((e) => `"${String(e).toLowerCase().replace(/"/g, '')}"`).join(',')
  await supaFetch(`email_contacts?email=in.(${list})&status=eq.active`, {
    method: 'PATCH', body: { status, updated_at: new Date().toISOString() }, prefer: 'return=minimal',
  }).catch((e) => console.warn('[ses-webhook] contact status failed', e?.message))
}

async function handleEvent(ev) {
  const type = String(ev.eventType || ev.notificationType || '').toLowerCase()
  const messageId = ev.mail?.messageId
  if (!messageId) return { ignored: 'no messageId' }
  const isTest = Array.isArray(ev.mail?.tags?.test) && ev.mail.tags.test.includes('1')

  const rows = await supaFetch(`email_sends?ses_message_id=eq.${enc(messageId)}&select=id,campaign_id,status,email,opened_at,clicked_at,delivered_at&limit=1`)
  const send = rows?.[0] || null
  const campaignId = send?.campaign_id || ev.mail?.tags?.campaign_id?.[0] || null
  const now = new Date().toISOString()
  const patchSend = (fields) => send
    ? supaFetch(`email_sends?id=eq.${enc(send.id)}`, { method: 'PATCH', body: { ...fields, updated_at: now }, prefer: 'return=minimal' })
    : Promise.resolve()

  switch (type) {
    case 'bounce': {
      const recipients = (ev.bounce?.bouncedRecipients || []).map((r) => r.emailAddress).filter(Boolean)
      const permanent = ev.bounce?.bounceType === 'Permanent'
      const detail = `${ev.bounce?.bounceType || ''}/${ev.bounce?.bounceSubType || ''}`.replace(/^\/|\/$/g, '')
      if (permanent) {
        for (const email of recipients) await suppress({ email, reason: 'bounce', source: `ses:${detail}` })
        await markContacts(recipients, 'bounced')
      }
      if (send && send.status !== 'bounced') {
        await patchSend({ status: permanent ? 'bounced' : send.status, error: `bounce ${detail}` })
        if (permanent && !isTest) await bump(campaignId, 'bounced_count')
      }
      return { bounce: detail, recipients: recipients.length }
    }
    case 'complaint': {
      const recipients = (ev.complaint?.complainedRecipients || []).map((r) => r.emailAddress).filter(Boolean)
      for (const email of recipients) await suppress({ email, reason: 'complaint', source: `ses:${ev.complaint?.complaintFeedbackType || 'complaint'}` })
      await markContacts(recipients, 'complained')
      if (send && send.status !== 'complained') {
        await patchSend({ status: 'complained', error: `complaint ${ev.complaint?.complaintFeedbackType || ''}`.trim() })
        if (!isTest) await bump(campaignId, 'complained_count')
      }
      return { complaint: recipients.length }
    }
    case 'delivery': {
      if (send && !send.delivered_at) {
        await patchSend({ status: send.status === 'sent' ? 'delivered' : send.status, delivered_at: now })
        if (!isTest) await bump(campaignId, 'delivered_count')
      }
      return { delivered: true }
    }
    case 'open': {
      if (send && !send.opened_at) {
        await patchSend({ opened_at: now })
        if (!isTest) await bump(campaignId, 'opened_count')
      }
      return { open: true }
    }
    case 'click': {
      if (send && !send.clicked_at) {
        await patchSend({ clicked_at: now, opened_at: send.opened_at || now })
        if (!isTest) {
          await bump(campaignId, 'clicked_count')
          if (!send.opened_at) await bump(campaignId, 'opened_count')
        }
      }
      return { click: true }
    }
    case 'reject':
    case 'renderingfailure': {
      if (send && !['failed', 'bounced', 'complained'].includes(send.status)) {
        await patchSend({ status: 'failed', error: ev.reject?.reason || ev.failure?.errorMessage || type })
        if (!isTest) await bump(campaignId, 'failed_count')
      }
      return { failed: type }
    }
    default:
      return { ignored: type }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  let msg
  try {
    msg = JSON.parse(await readRawBody(req))
  } catch {
    return res.status(400).json({ error: 'invalid JSON' })
  }

  try {
    if (!(await verifySignature(msg))) return res.status(403).json({ error: 'bad signature' })
  } catch (e) {
    console.warn('[ses-webhook] signature check failed', e?.message)
    return res.status(403).json({ error: 'signature check failed' })
  }
  if (EXPECTED_TOPIC && msg.TopicArn !== EXPECTED_TOPIC) return res.status(403).json({ error: 'unexpected topic' })

  if (msg.Type === 'SubscriptionConfirmation') {
    const r = await fetch(msg.SubscribeURL).catch(() => null)
    console.log('[ses-webhook] subscription confirmed', r?.status)
    return res.status(200).json({ ok: true, confirmed: Boolean(r?.ok) })
  }
  if (msg.Type !== 'Notification') return res.status(200).json({ ok: true, ignored: msg.Type })

  let event
  try { event = JSON.parse(msg.Message) } catch { return res.status(200).json({ ok: true, ignored: 'non-JSON message' }) }

  try {
    const out = await handleEvent(event)
    return res.status(200).json({ ok: true, ...out })
  } catch (e) {
    // 200 on purpose: SNS would otherwise retry for hours and the failure is
    // ours to fix, not a transient one.
    console.error('[ses-webhook] handler error', e)
    return res.status(200).json({ ok: false, error: e?.message })
  }
}
