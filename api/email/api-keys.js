// Manage a brand's ingest keys (the ones POST /api/email/subscribe accepts).
//
//   GET    ?profile_id=<uuid>                 { keys: [...] }   never the key itself
//   POST   { profile_id, name }               { key, key_row }  the key, ONCE
//   DELETE ?id=<uuid>                         revoke
//
// Admin only, not editor: a key writes to a client's mailing list, and issuing
// one is closer to adding a user than to writing a campaign.
//
// Revoking sets active = false rather than deleting the row, so the audit
// trail of "this key existed and was last used then" survives. The hot-path
// index in migration 0084 is partial on active, so a revoked key stops
// costing anything on lookup.

import { setCors, requireUser, supaFetch, assertMinRole, isUuid } from '../_lib/supabase.js'
import { generateKey, isMissingTable } from '../_lib/email-api-key.js'

const enc = encodeURIComponent
const clean = (v, max = 60) => String(v ?? '').trim().slice(0, max)

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
      await assertMinRole(userId, profileId, 'admin')

      const keys = await supaFetch(
        `email_api_keys?profile_id=eq.${enc(profileId)}` +
        '&select=id,name,key_prefix,active,last_used_at,created_at&order=created_at.desc&limit=100',
      ) || []
      return res.status(200).json({ keys })
    }

    if (req.method === 'POST') {
      const body = req.body || {}
      if (!isUuid(body.profile_id)) return res.status(400).json({ error: 'profile_id required' })
      await assertMinRole(userId, body.profile_id, 'admin')

      const name = clean(body.name, 60)
      if (!name) return res.status(400).json({ error: 'Give the key a name, so you can tell it apart later.' })

      const { key, hash, prefix } = generateKey()
      const created = await supaFetch('email_api_keys', {
        method: 'POST',
        body: {
          profile_id: body.profile_id,
          name,
          key_hash: hash,
          key_prefix: prefix,
          created_by: userId,
        },
      })
      const row = Array.isArray(created) ? created[0] : created

      // The only time the key is ever returned. It is not stored anywhere we
      // can read, so there is no "show it again".
      return res.status(201).json({
        key,
        key_row: {
          id: row?.id, name, key_prefix: prefix, active: true,
          last_used_at: null, created_at: row?.created_at,
        },
        notice: 'Copy this key now. It is stored only as a hash, so it cannot be shown again.',
      })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!isUuid(id)) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`email_api_keys?id=eq.${enc(id)}&select=profile_id&limit=1`)
      const row = rows?.[0]
      if (!row) return res.status(404).json({ error: 'Not found' })
      await assertMinRole(userId, row.profile_id, 'admin')

      await supaFetch(`email_api_keys?id=eq.${enc(id)}`, {
        method: 'PATCH', body: { active: false }, prefer: 'return=minimal',
      })
      return res.status(200).json({ ok: true, revoked: id })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    if (isMissingTable(err)) {
      return res.status(503).json({
        error: 'Ingest keys are not switched on for this database yet. Apply migration 0084 and reload.',
        code: 'migration_pending',
      })
    }
    return res.status(err.status || 500).json({ error: err.message })
  }
}
