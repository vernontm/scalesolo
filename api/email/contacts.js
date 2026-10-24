// Subscribers for one brand: list, search, add, edit, unsubscribe, delete.
//
// Routes:
//   GET    ?profile_id=<uuid>&q=&status=&tag=&limit=&offset=   { contacts, total, counts }
//   POST   { profile_id, email, name?, tags?, source? }        add one   { contact }
//   PATCH  ?id=<uuid> { name?, tags?, status? }                edit      { contact }
//   POST   ?action=import { profile_id, rows: [...] }          bulk add  { added, skipped, suppressed }
//   DELETE ?id=<uuid>                                          remove
//
// A suppressed address (hard bounce or complaint, from either provider's
// webhook) is never re-added as active by an import. Re-adding one would
// resume mailing an address that already bounced, which is how a sending
// reputation dies.

import { setCors, requireUser, supaFetch, assertProfileAccess, assertMinRole, isUuid } from '../_lib/supabase.js'

const enc = encodeURIComponent
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const STATUSES = ['active', 'unsubscribed', 'bounced', 'complained']

const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max)
const normEmail = (v) => clean(v, 320).toLowerCase()

function normTags(input) {
  const raw = Array.isArray(input)
    ? input
    : String(input || '').split(',')
  return [...new Set(raw.map((t) => clean(t, 40).toLowerCase()).filter(Boolean))].slice(0, 20)
}

// PostgREST's or= filter takes a comma-separated list, so a search term
// containing a comma or paren would break out of the filter. Strip them.
function safeSearch(q) {
  return clean(q, 80).replace(/[,()*\\]/g, ' ').trim()
}

async function suppressedSet(emails) {
  const list = [...new Set(emails.filter(Boolean))]
  if (!list.length) return new Set()
  const inList = list.map((e) => `"${e.replace(/"/g, '')}"`).join(',')
  const rows = await supaFetch(`email_suppressions?email=in.(${inList})&select=email`).catch(() => [])
  return new Set((rows || []).map((r) => String(r.email).toLowerCase()))
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return
  const userId = auth.user.id

  try {
    // ── list ────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const profileId = req.query.profile_id
      if (!isUuid(profileId)) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(userId, profileId)

      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200)
      const offset = Math.max(Number(req.query.offset) || 0, 0)
      let where = `profile_id=eq.${enc(profileId)}`

      const status = clean(req.query.status, 20)
      if (status && STATUSES.includes(status)) where += `&status=eq.${enc(status)}`

      const tag = clean(req.query.tag, 40).toLowerCase()
      if (tag) where += `&tags=cs.${enc(JSON.stringify([tag]))}`

      const q = safeSearch(req.query.q)
      if (q) where += `&or=(email.ilike.*${enc(q)}*,name.ilike.*${enc(q)}*)`

      const [rows, counts] = await Promise.all([
        supaFetch(`email_contacts?${where}&order=created_at.desc&limit=${limit}&offset=${offset}` +
          '&select=id,email,name,tags,status,source,created_at,signed_up_at'),
        // One row per status so the tab can show the split without pulling
        // every contact down just to count them.
        supaFetch(`email_contacts?profile_id=eq.${enc(profileId)}&select=status`),
      ])
      const byStatus = {}
      for (const r of (counts || [])) byStatus[r.status || 'active'] = (byStatus[r.status || 'active'] || 0) + 1

      return res.status(200).json({
        contacts: rows || [],
        total: (counts || []).length,
        counts: byStatus,
        limit,
        offset,
      })
    }

    // ── bulk import ─────────────────────────────────────────────────────
    if (req.method === 'POST' && req.query.action === 'import') {
      const body = req.body || {}
      if (!isUuid(body.profile_id)) return res.status(400).json({ error: 'profile_id required' })
      await assertMinRole(userId, body.profile_id, 'editor')
      const rows = Array.isArray(body.rows) ? body.rows.slice(0, 5000) : []
      if (!rows.length) return res.status(400).json({ error: 'Nothing to import.' })

      const seen = new Set()
      const candidates = []
      let invalid = 0
      for (const r of rows) {
        const email = normEmail(r?.email ?? r)
        if (!EMAIL_RE.test(email)) { invalid++; continue }
        if (seen.has(email)) continue
        seen.add(email)
        candidates.push({
          profile_id: body.profile_id,
          email,
          name: clean(r?.name, 120) || '',
          tags: normTags(r?.tags),
          source: clean(body.source || r?.source, 60) || 'import',
          status: 'active',
          signed_up_at: new Date().toISOString(),
        })
      }

      // Never resurrect an address that already bounced or complained.
      const blocked = await suppressedSet(candidates.map((c) => c.email))
      const toInsert = candidates.filter((c) => !blocked.has(c.email))

      let added = 0
      if (toInsert.length) {
        // merge-duplicates leaves an existing contact alone rather than
        // flipping an unsubscribed person back to active.
        const out = await supaFetch('email_contacts', {
          method: 'POST', body: toInsert, prefer: 'resolution=merge-duplicates,return=representation',
        }).catch((e) => { throw new Error(`Import failed: ${e?.message || e}`) })
        added = Array.isArray(out) ? out.length : 0
      }
      return res.status(200).json({
        added,
        skipped_invalid: invalid,
        skipped_suppressed: blocked.size,
        duplicates_in_file: rows.length - candidates.length - invalid,
      })
    }

    // ── add one ─────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const body = req.body || {}
      if (!isUuid(body.profile_id)) return res.status(400).json({ error: 'profile_id required' })
      await assertMinRole(userId, body.profile_id, 'editor')
      const email = normEmail(body.email)
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' })

      const blocked = await suppressedSet([email])
      if (blocked.has(email)) {
        return res.status(409).json({
          error: 'That address bounced or reported spam before, so it stays suppressed. Adding it back would damage your sending reputation.',
          code: 'suppressed',
        })
      }
      const existing = await supaFetch(`email_contacts?profile_id=eq.${enc(body.profile_id)}&email=eq.${enc(email)}&select=id&limit=1`)
      if (existing?.length) return res.status(409).json({ error: 'That address is already on this list.' })

      const created = await supaFetch('email_contacts', {
        method: 'POST',
        body: {
          profile_id: body.profile_id, email,
          name: clean(body.name, 120) || '',
          tags: normTags(body.tags),
          source: clean(body.source, 60) || 'manual',
          status: 'active',
          signed_up_at: new Date().toISOString(),
        },
      })
      return res.status(201).json({ contact: Array.isArray(created) ? created[0] : created })
    }

    // ── edit ────────────────────────────────────────────────────────────
    if (req.method === 'PATCH') {
      const id = req.query.id
      if (!isUuid(id)) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`email_contacts?id=eq.${enc(id)}&select=profile_id,email,status`)
      const row = rows?.[0]
      if (!row) return res.status(404).json({ error: 'Not found' })
      await assertMinRole(userId, row.profile_id, 'editor')

      const patch = { updated_at: new Date().toISOString() }
      if (body_has(req, 'name')) patch.name = clean(req.body.name, 120)
      if (body_has(req, 'tags')) patch.tags = normTags(req.body.tags)
      if (body_has(req, 'status')) {
        const next = clean(req.body.status, 20)
        if (!STATUSES.includes(next)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` })
        // Reactivating someone who bounced or complained is how a domain
        // gets blocklisted, so it is refused rather than quietly allowed.
        if (next === 'active' && ['bounced', 'complained'].includes(row.status)) {
          return res.status(409).json({
            error: `This address ${row.status === 'bounced' ? 'hard bounced' : 'reported spam'}, so it cannot be set back to active.`,
            code: 'suppressed',
          })
        }
        patch.status = next
      }
      const updated = await supaFetch(`email_contacts?id=eq.${enc(id)}`, { method: 'PATCH', body: patch })
      return res.status(200).json({ contact: Array.isArray(updated) ? updated[0] : updated })
    }

    // ── delete ──────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!isUuid(id)) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`email_contacts?id=eq.${enc(id)}&select=profile_id`)
      const row = rows?.[0]
      if (!row) return res.status(404).json({ error: 'Not found' })
      await assertMinRole(userId, row.profile_id, 'admin')
      await supaFetch(`email_contacts?id=eq.${enc(id)}`, { method: 'DELETE', prefer: 'return=minimal' })
      // Deleting the contact does NOT clear a suppression: the address stays
      // on the global list so a later import cannot bring it back.
      return res.status(200).json({ ok: true })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (e) {
    const status = e?.status && Number.isInteger(e.status) ? e.status : 500
    return res.status(status).json({ error: e?.message || 'Request failed' })
  }
}

function body_has(req, key) {
  return req.body && Object.prototype.hasOwnProperty.call(req.body, key)
}
