// Amazon SES (v2 API) client for marketing + campaign email.
//
// Transactional product mail (billing receipts, board invites) still goes
// through Resend in email.js. This module is the brand-facing sender:
// campaigns, test sends, and the per-brand "verify your own domain" flow.
//
// Env (set in Vercel, never committed):
//   SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY   IAM user scalesolo-vercel-ses.
//     Named SES_* on purpose: Vercel reserves the AWS_* names.
//   SES_REGION              us-east-2 (the VTM project's only region)
//   SES_CONFIGURATION_SET   scalesolo (event destination -> SNS -> webhook)
//   SES_SHARED_DOMAIN       mail.scalesolo.ai (brands without their own domain)
//
// Every brand's own domain is a separate SES identity created at runtime
// through createDomainIdentity(); it inherits the same configuration set so
// bounces and complaints flow through the one webhook.

import { SESv2Client, SendEmailCommand, CreateEmailIdentityCommand, GetEmailIdentityCommand,
  DeleteEmailIdentityCommand, PutEmailIdentityMailFromAttributesCommand,
  PutEmailIdentityConfigurationSetAttributesCommand, GetAccountCommand } from '@aws-sdk/client-sesv2'

export const SES_REGION = process.env.SES_REGION || 'us-east-2'
export const SES_CONFIGURATION_SET = process.env.SES_CONFIGURATION_SET || 'scalesolo'
export const SHARED_DOMAIN = (process.env.SES_SHARED_DOMAIN || 'mail.scalesolo.ai').toLowerCase()

let _client = null
function client() {
  if (_client) return _client
  const accessKeyId = process.env.SES_ACCESS_KEY_ID
  const secretAccessKey = process.env.SES_SECRET_ACCESS_KEY
  if (!accessKeyId || !secretAccessKey) throw new Error('SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY not configured')
  _client = new SESv2Client({ region: SES_REGION, credentials: { accessKeyId, secretAccessKey } })
  return _client
}

export function isConfigured() {
  return Boolean(process.env.SES_ACCESS_KEY_ID && process.env.SES_SECRET_ACCESS_KEY)
}

// RFC 5322 display-name quoting. Names with quotes or commas would otherwise
// break the From header and SES rejects the message.
function formatAddress(email, name) {
  if (!name) return email
  const clean = String(name).replace(/["\\\r\n]/g, '').trim()
  return clean ? `"${clean}" <${email}>` : email
}

// Send one message. Returns the SES MessageId. Throws on any failure; the
// caller decides whether that is terminal (bad address) or transient
// (throttle) and must NOT retry blindly: a retry loop double-sends.
export async function sendEmail({ from, fromName, to, replyTo, subject, html, text, headers = [], tags = {}, configurationSet = SES_CONFIGURATION_SET }) {
  if (!from || !to || !subject || !html) throw new Error('from, to, subject, html required')
  const cmd = new SendEmailCommand({
    FromEmailAddress: formatAddress(from, fromName),
    Destination: { ToAddresses: Array.isArray(to) ? to : [to] },
    ReplyToAddresses: replyTo ? [replyTo] : undefined,
    ConfigurationSetName: configurationSet,
    EmailTags: Object.entries(tags).filter(([, v]) => v != null && v !== '').map(([Name, Value]) => ({ Name, Value: String(Value).slice(0, 256) })),
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: html, Charset: 'UTF-8' },
          ...(text ? { Text: { Data: text, Charset: 'UTF-8' } } : {}),
        },
        Headers: headers.filter((h) => h?.Name && h?.Value),
      },
    },
  })
  const out = await client().send(cmd)
  return out.MessageId
}

// Classify an SES error so the worker knows whether to give up on this
// recipient (permanent) or pause and let the next tick continue (transient).
export function classifySendError(err) {
  const name = err?.name || ''
  const msg = String(err?.message || '')
  if (name === 'TooManyRequestsException' || name === 'Throttling' || name === 'ThrottlingException' || /rate exceeded|throttl/i.test(msg)) return 'throttled'
  if (name === 'AccountSuspendedException' || name === 'SendingPausedException') return 'paused'
  if (/not verified|Email address is not verified/i.test(msg)) return 'unverified'
  if (name === 'BadRequestException' || name === 'MessageRejected' || /Invalid|address/i.test(msg)) return 'rejected'
  return 'unknown'
}

// Create a brand's domain identity with Easy DKIM (2048-bit) and a custom
// MAIL FROM subdomain, attached to the shared configuration set. Idempotent
// enough for our use: if the identity already exists we just read it back.
export async function createDomainIdentity(domain) {
  const d = normalizeDomain(domain)
  try {
    await client().send(new CreateEmailIdentityCommand({
      EmailIdentity: d,
      DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
      ConfigurationSetName: SES_CONFIGURATION_SET,
      Tags: [{ Key: 'app', Value: 'scalesolo' }, { Key: 'kind', Value: 'brand-domain' }],
    }))
  } catch (e) {
    if (e?.name !== 'AlreadyExistsException') throw e
    // Make sure an older identity still routes events through our set.
    await client().send(new PutEmailIdentityConfigurationSetAttributesCommand({ EmailIdentity: d, ConfigurationSetName: SES_CONFIGURATION_SET })).catch(() => {})
  }
  const mailFrom = `bounce.${d}`
  await client().send(new PutEmailIdentityMailFromAttributesCommand({ EmailIdentity: d, MailFromDomain: mailFrom, BehaviorOnMxFailure: 'USE_DEFAULT_VALUE' }))
  return getDomainIdentity(d)
}

export async function getDomainIdentity(domain) {
  const d = normalizeDomain(domain)
  const g = await client().send(new GetEmailIdentityCommand({ EmailIdentity: d }))
  return {
    domain: d,
    verified: Boolean(g.VerifiedForSendingStatus),
    dkimTokens: g.DkimAttributes?.Tokens || [],
    dkimStatus: g.DkimAttributes?.Status || 'NOT_STARTED',
    mailFromDomain: g.MailFromAttributes?.MailFromDomain || null,
    mailFromStatus: g.MailFromAttributes?.MailFromDomainStatus || null,
  }
}

export async function deleteDomainIdentity(domain) {
  const d = normalizeDomain(domain)
  try {
    await client().send(new DeleteEmailIdentityCommand({ EmailIdentity: d }))
  } catch (e) {
    if (e?.name !== 'NotFoundException') throw e
  }
}

// Sandbox vs production, plus quota. Used by the Sender tab so Ray can see
// at a glance whether the account is still limited to verified recipients.
export async function getAccountStatus() {
  const a = await client().send(new GetAccountCommand({}))
  return {
    productionAccess: Boolean(a.ProductionAccessEnabled),
    sendingEnabled: Boolean(a.SendingEnabled),
    max24HourSend: a.SendQuota?.Max24HourSend ?? null,
    maxSendRate: a.SendQuota?.MaxSendRate ?? null,
    sentLast24Hours: a.SendQuota?.SentLast24Hours ?? null,
    enforcement: a.EnforcementStatus || null,
  }
}

// The DNS records a brand has to add for a domain. Same shape whether the
// identity was just created or is being re-displayed from stored tokens.
export function dnsRecordsFor({ domain, dkimTokens = [], mailFromDomain }) {
  const d = normalizeDomain(domain)
  const records = dkimTokens.map((t) => ({
    purpose: 'DKIM', type: 'CNAME', host: `${t}._domainkey.${d}`, value: `${t}.dkim.amazonses.com`,
  }))
  const mf = mailFromDomain || `bounce.${d}`
  records.push({ purpose: 'Bounce domain (MX)', type: 'MX', host: mf, value: `feedback-smtp.${SES_REGION}.amazonses.com`, priority: 10 })
  records.push({ purpose: 'Bounce domain (SPF)', type: 'TXT', host: mf, value: 'v=spf1 include:amazonses.com ~all' })
  records.push({ purpose: 'DMARC (recommended)', type: 'TXT', host: `_dmarc.${d}`, value: 'v=DMARC1; p=none;', optional: true })
  return records
}

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export function normalizeDomain(domain) {
  const d = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^@/, '')
  if (!DOMAIN_RE.test(d)) throw new Error('That does not look like a domain name (example: yourbusiness.com)')
  return d
}

export function domainOf(email) {
  return String(email || '').trim().toLowerCase().split('@')[1] || ''
}
