// Per-brand ingest keys for POST /api/email/subscribe.
//
// A key is scoped to exactly ONE brand, which is the whole point: the only
// existing way for an outside system to add a tagged contact was the internal
// secret, and that impersonates a user across every brand on the account. You
// cannot hand that to a client's website or a Zapier zap. A key here can write
// contacts to its own list and nothing else.
//
// Only the SHA-256 of the key is stored, so a database leak does not hand
// anyone a working key, and nobody (including us) can read a key back after
// it is created. The prefix is kept purely so the UI can show which key is
// which. Losing a key means issuing a new one, which is the correct tradeoff
// for a credential that writes to a client's mailing list.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { supaFetch } from './supabase.js'

const enc = encodeURIComponent

export const KEY_PREFIX = 'ssk_live_'

export const hashKey = (key) => createHash('sha256').update(String(key), 'utf8').digest('hex')

// 32 random bytes, base64url, so there is nothing to confuse in a copy and
// paste: no padding, no +/ characters.
export function generateKey() {
  const body = randomBytes(32).toString('base64url')
  const key = `${KEY_PREFIX}${body}`
  return { key, hash: hashKey(key), prefix: key.slice(0, KEY_PREFIX.length + 6) }
}

// Accept the key from a dedicated header or a bearer token. Deliberately NOT
// from the query string: a key in a URL ends up in access logs, proxy logs and
// browser history, and this one can write to a client's list.
export function keyFromRequest(req) {
  const header = req.headers?.['x-api-key']
  if (header) return String(header).trim()
  const auth = req.headers?.authorization || ''
  const m = /^Bearer\s+(.+)$/i.exec(String(auth).trim())
  return m ? m[1].trim() : ''
}

// Constant-time compare of two hex digests, so a wrong key cannot be found
// byte by byte from response timing.
export function hashesEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8')
  const bb = Buffer.from(String(b || ''), 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export function isMissingTable(e) {
  const code = e?.data?.code || ''
  if (code === '42P01' || code === 'PGRST205') return true
  return /relation .* does not exist|schema cache/i.test(String(e?.message || ''))
}

// Resolve a presented key to its brand. Returns null for anything that is not
// a live key, with no detail about which part failed.
export async function resolveKey(presented) {
  const key = String(presented || '').trim()
  if (!key.startsWith(KEY_PREFIX)) return null
  const rows = await supaFetch(
    `email_api_keys?key_hash=eq.${enc(hashKey(key))}&active=is.true&select=id,profile_id,name,key_hash&limit=1`,
  )
  const row = rows?.[0]
  if (!row) return null
  // The lookup was by hash already; this is belt and braces against a future
  // change to the query that could make it a prefix match.
  if (!hashesEqual(row.key_hash, hashKey(key))) return null
  return { id: row.id, profileId: row.profile_id, name: row.name }
}

// Stamp last_used_at, at most once a minute per key per warm container, so a
// busy zap does not spend a write on every single lead.
const lastStamp = new Map()
export async function touchKey(id) {
  const now = Date.now()
  if (now - (lastStamp.get(id) || 0) < 60_000) return
  lastStamp.set(id, now)
  await supaFetch(`email_api_keys?id=eq.${enc(id)}`, {
    method: 'PATCH', body: { last_used_at: new Date().toISOString() }, prefer: 'return=minimal',
  }).catch(() => {})
}
