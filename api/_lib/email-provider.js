// Picks the email provider for a brand.
//
// Two are wired up and both work. SES is roughly ten times cheaper, and its
// production access was granted on 2026-10-29, so it is what a brand with
// nothing saved gets. Mailgun stays wired up rather than ripped out: every
// brand carries email_config.email_provider and this module hands the callers
// whichever it names, so one brand can be moved without touching the rest.
//
// The default matters more than it looks. A brand created with no row at all
// falls through to it, and on 2026-10-29 that silently built a client's
// sending domain at the wrong provider, which would have handed them DNS
// records that could never verify.
//
// Env:
//   EMAIL_PROVIDER   default for brands with nothing saved ('ses' or 'mailgun')

import * as ses from './ses.js'
import * as mailgun from './mailgun.js'

export { normalizeDomain, domainOf } from './email-domain.js'

const PROVIDERS = { ses, mailgun }

export const PROVIDER_NAMES = Object.keys(PROVIDERS)
export const DEFAULT_PROVIDER = PROVIDERS[(process.env.EMAIL_PROVIDER || '').toLowerCase()]
  ? (process.env.EMAIL_PROVIDER || '').toLowerCase()
  : 'ses'

// Falls back rather than throwing: a typo in one brand's row must not take
// down sending for every other brand.
export function providerFor(name) {
  const key = String(name || '').toLowerCase()
  return PROVIDERS[key] || PROVIDERS[DEFAULT_PROVIDER]
}

export function providerNameFor(name) {
  const key = String(name || '').toLowerCase()
  return PROVIDERS[key] ? key : DEFAULT_PROVIDER
}

// The domain a brand sends from when it has not verified its own.
export function sharedDomain(name) {
  return providerFor(name).SHARED_DOMAIN
}

// True when the server has credentials for that provider. Without a name,
// true if ANY provider is usable, which is what the cron needs to know.
export function isConfigured(name) {
  if (name) return providerFor(name).isConfigured()
  return Object.values(PROVIDERS).some((p) => p.isConfigured())
}

export async function sendEmail(args, name) {
  return providerFor(name).sendEmail(args)
}

export function classifySendError(err, name) {
  return providerFor(name).classifySendError(err)
}

export async function createDomainIdentity(domain, name) {
  return providerFor(name).createDomainIdentity(domain)
}

export async function getDomainIdentity(domain, name) {
  return providerFor(name).getDomainIdentity(domain)
}

export async function deleteDomainIdentity(domain, name) {
  return providerFor(name).deleteDomainIdentity(domain)
}

export async function getAccountStatus(name) {
  return providerFor(name).getAccountStatus()
}

export function dnsRecordsFor(args, name) {
  return providerFor(name).dnsRecordsFor(args)
}

// Mailgun re-checks DNS on demand; SES polls its own identity. Callers get a
// single entry point either way.
export async function verifyDomain(domain, name) {
  const p = providerFor(name)
  if (typeof p.verifyDomain === 'function') return p.verifyDomain(domain)
  return p.getDomainIdentity(domain)
}

// SES routes events through a named configuration set; Mailgun has no
// equivalent and returns null, which its sendEmail ignores.
export function configurationSetFor(name) {
  return providerFor(name).SES_CONFIGURATION_SET ?? null
}
