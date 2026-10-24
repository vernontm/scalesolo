// Mailgun client for marketing + campaign email.
//
// Mirrors the interface of ses.js on purpose: same function names, same
// arguments, same return shapes, so api/_lib/email-provider.js can hand the
// callers either one without them knowing which is in play.
//
// Why both exist: SES is roughly ten times cheaper but its production access
// was denied on 2026-10-22 (case 179269796600754), so that account is capped
// at 200 messages a day to verified addresses only. Mailgun verified
// mg.scalesolo.ai and delivered to a real inbox the same day. Keep SES wired
// up; if the appeal lands, brands can be moved back one at a time.
//
// Env (set in Vercel, never committed):
//   MAILGUN_API_KEY             private API key; rotate it if it ever leaks
//   MAILGUN_BASE_URL            https://api.mailgun.net (use api.eu.mailgun.net for the EU region)
//   MAILGUN_SHARED_DOMAIN       mg.scalesolo.ai (brands without their own domain)
//   MAILGUN_WEBHOOK_SIGNING_KEY used by api/email/mailgun-webhook.js to verify callbacks

import { normalizeDomain, domainOf } from './email-domain.js'
import { normalizeMessageId } from './email-events.js'

export { normalizeDomain, domainOf }

export const BASE_URL = (process.env.MAILGUN_BASE_URL || 'https://api.mailgun.net').replace(/\/$/, '')
export const SHARED_DOMAIN = (process.env.MAILGUN_SHARED_DOMAIN || 'mg.scalesolo.ai').toLowerCase()

// SES routes events through a named configuration set. Mailgun has no such
// concept: events come from account-level webhooks. The export exists so the
// shared callers do not have to special-case a provider.
export const SES_CONFIGURATION_SET = null

export function isConfigured() {
  return Boolean(process.env.MAILGUN_API_KEY)
}

function authHeader() {
  const key = process.env.MAILGUN_API_KEY
  if (!key) throw new Error('MAILGUN_API_KEY not configured')
  return `Basic ${Buffer.from(`api:${key}`).toString('base64')}`
}

// An HTTP failure carries the status so classifySendError can tell a bad
// address (give up on this contact) from a throttle (pause and continue).
class MailgunError extends Error {
  constructor(message, status, body) {
    super(message)
    this.name = 'MailgunError'
    this.status = status
    this.body = body
  }
}

async function call(path, { method = 'GET', form, query } = {}) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : ''
  const res = await fetch(`${BASE_URL}${path}${qs}`, {
    method,
    headers: { Authorization: authHeader(), Accept: 'application/json' },
    body: form,
  })
  const raw = await res.text()
  let body = null
  try { body = raw ? JSON.parse(raw) : null } catch { body = { message: raw } }
  if (!res.ok) {
    throw new MailgunError(body?.message || `Mailgun ${method} ${path} failed (${res.status})`, res.status, body)
  }
  return body
}

// RFC 5322 display-name quoting. A name containing a quote or comma would
// otherwise break the From header.
function formatAddress(email, name) {
  if (!name) return email
  const clean = String(name).replace(/["\\\r\n]/g, '').trim()
  return clean ? `"${clean}" <${email}>` : email
}

// Send one message. Returns Mailgun's message id. Throws on any failure; the
// caller decides whether that is terminal or transient and must NOT retry
// blindly, because a retry loop double-sends.
export async function sendEmail({ from, fromName, to, replyTo, subject, html, text, headers = [], tags = {} }) {
  if (!from || !to || !subject || !html) throw new Error('from, to, subject, html required')
  // Mail goes out through the domain the From address belongs to, so a brand
  // on its own verified domain sends from its own reputation.
  const sendingDomain = domainOf(from) || SHARED_DOMAIN

  const form = new FormData()
  form.append('from', formatAddress(from, fromName))
  for (const addr of (Array.isArray(to) ? to : [to])) form.append('to', addr)
  if (replyTo) form.append('h:Reply-To', replyTo)
  form.append('subject', subject)
  form.append('html', html)
  if (text) form.append('text', text)

  for (const h of headers) {
    if (h?.Name && h?.Value) form.append(`h:${h.Name}`, String(h.Value))
  }
  // Mailgun splits these: o:tag is a flat label you can filter logs by, while
  // v:* custom variables come back on every webhook event, which is what the
  // event handler needs to attribute a bounce to a campaign.
  for (const [k, v] of Object.entries(tags)) {
    if (v == null || v === '') continue
    form.append('v:' + k, String(v).slice(0, 256))
  }
  if (tags.campaign_id) form.append('o:tag', `campaign:${tags.campaign_id}`)
  if (tags.profile_id) form.append('o:tag', `brand:${tags.profile_id}`)

  const out = await call(`/v3/${encodeURIComponent(sendingDomain)}/messages`, { method: 'POST', form })
  // Mailgun answers with <id@domain> here but reports the id bare on every
  // webhook event. Store the bare form so a bounce can find its send row;
  // otherwise suppression silently never happens.
  return normalizeMessageId(out?.id)
}

// Classify a Mailgun failure the same way ses.js does, so the send worker's
// logic is identical whichever provider is behind it.
export function classifySendError(err) {
  const status = err?.status
  const msg = String(err?.message || '')
  if (status === 429 || /rate limit|too many/i.test(msg)) return 'throttled'
  // 403 on a send is Mailgun refusing the account or the domain: an
  // unactivated account, or a sandbox domain reaching a non-authorized
  // recipient. Sending more will not help until a human fixes it.
  if (status === 403 || /not allowed to send|activate your mailgun account/i.test(msg)) return 'paused'
  if (status === 401) return 'paused'
  if (/not a valid|invalid.*address|parse error/i.test(msg)) return 'rejected'
  if (status === 400) return 'rejected'
  if (status >= 500) return 'throttled'
  return 'unknown'
}

// Add a brand's sending domain. Mailgun generates DKIM itself and returns the
// records to publish. Idempotent: an existing domain is read back instead of
// erroring, matching createDomainIdentity in ses.js.
export async function createDomainIdentity(domain) {
  const d = normalizeDomain(domain)
  const form = new FormData()
  form.append('name', d)
  form.append('web_scheme', 'https')
  try {
    await call('/v4/domains', { method: 'POST', form })
  } catch (e) {
    // Mailgun answers 400 "domain already exists" rather than a dedicated code.
    if (!(e.status === 400 && /already exist/i.test(String(e.message)))) throw e
  }
  return getDomainIdentity(d)
}

export async function getDomainIdentity(domain) {
  const d = normalizeDomain(domain)
  const g = await call(`/v4/domains/${encodeURIComponent(d)}`)
  const sending = g?.sending_dns_records || []
  const dkim = sending.find((r) => r.record_type === 'TXT' && /_domainkey/.test(r.name || ''))
  return {
    domain: d,
    verified: (g?.domain?.state || '') === 'active',
    state: g?.domain?.state || 'unknown',
    // Interface parity with SES, which hands back bare CNAME tokens. Mailgun
    // needs the whole record set, so that is what goes in: it is persisted to
    // email_domains.dkim_tokens (jsonb) and read back by dnsRecordsFor.
    dkimTokens: sending,
    dkimStatus: dkim?.valid === 'valid' ? 'SUCCESS' : 'PENDING',
    mailFromDomain: d,
    mailFromStatus: (g?.domain?.state || '') === 'active' ? 'SUCCESS' : 'PENDING',
    sendingDnsRecords: sending,
  }
}

// Ask Mailgun to re-check the published DNS. Returns the same shape as
// getDomainIdentity so the Sender tab can poll one call.
export async function verifyDomain(domain) {
  const d = normalizeDomain(domain)
  await call(`/v4/domains/${encodeURIComponent(d)}/verify`, { method: 'PUT' })
  return getDomainIdentity(d)
}

export async function deleteDomainIdentity(domain) {
  const d = normalizeDomain(domain)
  try {
    await call(`/v3/domains/${encodeURIComponent(d)}`, { method: 'DELETE' })
  } catch (e) {
    if (e.status !== 404) throw e
  }
}

// Mailgun has no sandbox/production split the way SES does, and exposes no
// quota endpoint, so this reports what can actually be checked: whether the
// key works and how many custom domains the plan is currently carrying. A
// 401 here is the clearest signal the key is wrong or revoked.
export async function getAccountStatus() {
  try {
    const out = await call('/v4/domains', { query: { limit: '100' } })
    const items = out?.items || []
    const custom = items.filter((x) => x.type !== 'sandbox')
    return {
      productionAccess: true,
      sendingEnabled: true,
      max24HourSend: null,
      maxSendRate: null,
      sentLast24Hours: null,
      enforcement: null,
      customDomains: custom.length,
      domains: custom.map((x) => ({ name: x.name, state: x.state })),
    }
  } catch (e) {
    return {
      productionAccess: false,
      sendingEnabled: false,
      max24HourSend: null,
      maxSendRate: null,
      sentLast24Hours: null,
      enforcement: e.status === 401 ? 'bad_api_key' : 'unreachable',
      customDomains: 0,
      domains: [],
    }
  }
}

// The DNS a brand has to publish. Mailgun hands back the exact records, so
// prefer those; the fallback only applies before the domain has been created.
export function dnsRecordsFor({ domain, sendingDnsRecords = [] }) {
  const d = normalizeDomain(domain)
  if (sendingDnsRecords.length) {
    return sendingDnsRecords.map((r) => ({
      purpose: /_domainkey/.test(r.name || '') ? 'DKIM' : r.record_type === 'CNAME' ? 'Tracking' : 'SPF',
      type: r.record_type,
      host: r.name,
      value: r.value,
      valid: r.valid || null,
    })).concat([
      { purpose: 'DMARC (recommended)', type: 'TXT', host: `_dmarc.${d}`, value: 'v=DMARC1; p=none;', optional: true },
    ])
  }
  return [
    { purpose: 'SPF', type: 'TXT', host: d, value: 'v=spf1 include:mailgun.org ~all' },
    { purpose: 'Tracking', type: 'CNAME', host: `email.${d}`, value: 'mailgun.org' },
    { purpose: 'DMARC (recommended)', type: 'TXT', host: `_dmarc.${d}`, value: 'v=DMARC1; p=none;', optional: true },
  ]
}
