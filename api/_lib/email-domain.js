// Pure domain-name helpers shared by every email provider.
//
// These used to live in ses.js, which meant mailgun.js would have had to
// import the whole AWS SDK just to lowercase a string. They are provider
// agnostic, so they live on their own.

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export function normalizeDomain(domain) {
  const d = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^@/, '')
  if (!DOMAIN_RE.test(d)) throw new Error('That does not look like a domain name (example: yourbusiness.com)')
  return d
}

export function domainOf(email) {
  return String(email || '').trim().toLowerCase().split('@')[1] || ''
}
