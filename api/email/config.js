// Per-brand sender settings (email_config): from name, from address,
// reply-to, and the postal address that goes in every footer.
//
//   GET ?profile_id   { config, suggested, shared_domain, domains, account }
//   PUT { profile_id, from_name, from_email, reply_to_email, postal_address }
//
// The from address must be on the shared domain or on one of the brand's
// own domains. Verification is checked at send time, not here, so a brand
// can fill in its settings while DNS propagates.

import { setCors, requireUser, supaFetch, assertProfileAccess, assertMinRole, isUuid } from '../_lib/supabase.js'
import { SHARED_DOMAIN, domainOf, isConfigured, getAccountStatus } from '../_lib/ses.js'
import { sharedLocalPart } from '../_lib/email-render.js'

const enc = encodeURIComponent
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const auth = await requireUser(req, res)
  if (!auth) return
  const userId = auth.user.id

  try {
    if (req.method === 'GET') {
      const profileId = req.query.profile_id
      if (!isUuid(profileId)) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(userId, profileId)
      const [profiles, configs, domains] = await Promise.all([
        supaFetch(`profiles?id=eq.${enc(profileId)}&select=business_name,website_url,location`),
        supaFetch(`email_config?profile_id=eq.${enc(profileId)}&select=id,from_name,from_email,reply_to_email,postal_address,email_provider,daily_limit,updated_at&limit=1`),
        supaFetch(`email_domains?profile_id=eq.${enc(profileId)}&select=domain,status&order=created_at.asc`),
      ])
      const profile = profiles?.[0] || {}
      let account = null
      if (isConfigured()) account = await getAccountStatus().catch((e) => ({ error: e?.message || 'unavailable' }))
      return res.status(200).json({
        config: configs?.[0] || null,
        suggested: {
          from_name: profile.business_name || '',
          from_email: `${sharedLocalPart(profile.business_name)}@${SHARED_DOMAIN}`,
          postal_address: profile.location || '',
        },
        shared_domain: SHARED_DOMAIN,
        domains: domains || [],
        configured: isConfigured(),
        account,
      })
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      const body = req.body || {}
      if (!isUuid(body.profile_id)) return res.status(400).json({ error: 'profile_id required' })
      await assertMinRole(userId, body.profile_id, 'admin')

      const fromEmail = String(body.from_email || '').trim().toLowerCase()
      if (!EMAIL_RE.test(fromEmail)) return res.status(400).json({ error: 'Enter a valid from address.' })
      const d = domainOf(fromEmail)
      if (d !== SHARED_DOMAIN) {
        const own = await supaFetch(`email_domains?profile_id=eq.${enc(body.profile_id)}&domain=eq.${enc(d)}&select=id&limit=1`)
        if (!own?.length) return res.status(400).json({ error: `Add ${d} under Sending domains before using it as a from address, or use an address on ${SHARED_DOMAIN}.` })
      }
      const replyTo = body.reply_to_email ? String(body.reply_to_email).trim().toLowerCase() : null
      if (replyTo && !EMAIL_RE.test(replyTo)) return res.status(400).json({ error: 'Reply-to is not a valid email.' })

      const row = {
        profile_id: body.profile_id,
        email_provider: 'ses',
        from_name: String(body.from_name || '').trim().slice(0, 120),
        from_email: fromEmail,
        reply_to_email: replyTo,
        postal_address: body.postal_address ? String(body.postal_address).trim().slice(0, 300) : null,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      }
      const saved = await supaFetch('email_config?on_conflict=profile_id', {
        method: 'POST', body: row, headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      })
      return res.status(200).json({ config: Array.isArray(saved) ? saved[0] : saved })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (e) {
    if (e?.status === 403) return res.status(403).json({ error: e.message || 'Forbidden' })
    console.error('[email/config]', e)
    return res.status(500).json({ error: e?.message || 'Internal error' })
  }
}
