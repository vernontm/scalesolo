// A brand's own sending domains, verified through SES Easy DKIM.
//
//   GET    ?profile_id              { domains: [{ ...row, records: [...] }] }
//   POST   { profile_id, domain }   create the SES identity, return DNS records
//   POST   ?action=verify { id }    re-read status from SES now
//   DELETE ?id                      remove identity + row
//
// SES marks the domain verified once the three DKIM CNAMEs resolve; the
// MAIL FROM (MX + SPF on bounce.<domain>) is tracked separately and only
// affects SPF alignment, not whether we can send.

import { setCors, requireUser, supaFetch, assertProfileAccess, assertMinRole, isUuid } from '../_lib/supabase.js'
import { createDomainIdentity, getDomainIdentity, deleteDomainIdentity, dnsRecordsFor, verifyDomain, sharedDomain, isConfigured, providerNameFor } from '../_lib/email-provider.js'
import { normalizeDomain } from '../_lib/email-domain.js'

const enc = encodeURIComponent
const RECHECK_AFTER_MS = 60 * 1000
const RESERVED = new Set([
  sharedDomain('ses'), sharedDomain('mailgun'),
  'scalesolo.ai', 'www.scalesolo.ai', 'amazonses.com', 'mailgun.org',
])

function statusFrom(identity) {
  if (identity.verified && identity.dkimStatus === 'SUCCESS') return 'verified'
  if (['FAILED', 'TEMPORARY_FAILURE'].includes(identity.dkimStatus)) return 'failed'
  return 'pending'
}

function withRecords(row, provider) {
  return {
    ...row,
    provider,
    records: dnsRecordsFor({
      domain: row.domain,
      dkimTokens: row.dkim_tokens || [],
      sendingDnsRecords: Array.isArray(row.dkim_tokens) ? row.dkim_tokens : [],
      mailFromDomain: row.mail_from_domain,
    }, provider),
  }
}

async function refresh(row, provider) {
  const identity = await getDomainIdentity(row.domain, provider)
  const status = statusFrom(identity)
  const fields = {
    status,
    dkim_tokens: identity.dkimTokens,
    dkim_status: identity.dkimStatus,
    mail_from_domain: identity.mailFromDomain,
    mail_from_status: identity.mailFromStatus,
    last_checked_at: new Date().toISOString(),
    verified_at: status === 'verified' ? (row.verified_at || new Date().toISOString()) : null,
    updated_at: new Date().toISOString(),
  }
  const rows = await supaFetch(`email_domains?id=eq.${enc(row.id)}`, { method: 'PATCH', body: fields })
  return rows?.[0] || { ...row, ...fields }
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const auth = await requireUser(req, res)
  if (!auth) return
  const userId = auth.user.id
  const action = String(req.query?.action || '')

  try {
    if (req.method === 'GET') {
      const profileId = req.query.profile_id
      if (!isUuid(profileId)) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(userId, profileId)
      const provider = providerNameFor((await supaFetch(`email_config?profile_id=eq.${enc(profileId)}&select=email_provider&limit=1`))?.[0]?.email_provider)
      let rows = await supaFetch(`email_domains?profile_id=eq.${enc(profileId)}&select=*&order=created_at.asc`) || []
      if (isConfigured(provider)) {
        rows = await Promise.all(rows.map(async (r) => {
          const stale = !r.last_checked_at || Date.now() - new Date(r.last_checked_at).getTime() > RECHECK_AFTER_MS
          if (r.status !== 'verified' && stale) return refresh(r, provider).catch(() => r)
          return r
        }))
      }
      return res.status(200).json({ domains: rows.map((r) => withRecords(r, provider)), shared_domain: sharedDomain(provider), provider })
    }

    if (req.method === 'POST' && !action) {
      const body = req.body || {}
      if (!isUuid(body.profile_id)) return res.status(400).json({ error: 'profile_id required' })
      await assertMinRole(userId, body.profile_id, 'admin')
      if (!isConfigured()) return res.status(503).json({ error: 'Email sending is not configured on the server yet.' })
      let domain
      try { domain = normalizeDomain(body.domain) } catch (e) { return res.status(400).json({ error: e.message }) }
      if (RESERVED.has(domain) || domain.endsWith('.scalesolo.ai')) return res.status(400).json({ error: 'That domain is reserved. Use your own business domain.' })
      const taken = await supaFetch(`email_domains?domain=eq.${enc(domain)}&select=id,profile_id&limit=1`)
      if (taken?.length) {
        if (taken[0].profile_id === body.profile_id) return res.status(409).json({ error: 'That domain is already on this brand.' })
        return res.status(409).json({ error: 'That domain is already claimed by another brand. Contact support if it is yours.' })
      }
      const identity = await createDomainIdentity(domain)
      const created = await supaFetch('email_domains', {
        method: 'POST',
        body: {
          profile_id: body.profile_id, domain, status: statusFrom(identity),
          dkim_tokens: identity.dkimTokens, dkim_status: identity.dkimStatus,
          mail_from_domain: identity.mailFromDomain, mail_from_status: identity.mailFromStatus,
          last_checked_at: new Date().toISOString(),
        },
      })
      const row = Array.isArray(created) ? created[0] : created
      return res.status(201).json({ domain: withRecords(row) })
    }

    if (req.method === 'POST' && action === 'verify') {
      const id = req.body?.id
      if (!isUuid(id)) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`email_domains?id=eq.${enc(id)}&select=*`)
      const row = rows?.[0]
      if (!row) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(userId, row.profile_id)
      if (!isConfigured()) return res.status(503).json({ error: 'Email sending is not configured on the server yet.' })
      const fresh = await refresh(row)
      return res.status(200).json({ domain: withRecords(fresh) })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!isUuid(id)) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`email_domains?id=eq.${enc(id)}&select=*`)
      const row = rows?.[0]
      if (!row) return res.status(404).json({ error: 'Not found' })
      await assertMinRole(userId, row.profile_id, 'admin')
      if (isConfigured()) await deleteDomainIdentity(row.domain).catch((e) => console.warn('[email/domains] SES delete failed', e?.message))
      await supaFetch(`email_domains?id=eq.${enc(id)}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (e) {
    if (e?.status === 403) return res.status(403).json({ error: e.message || 'Forbidden' })
    console.error('[email/domains]', e)
    return res.status(500).json({ error: e?.message || 'Internal error' })
  }
}
