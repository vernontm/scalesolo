// Board card versions — the raw footage + edited renditions of a production
// card, all stored in our own landing-media bucket.
//   GET    ?card_id=...                                          → versions (newest first)
//   POST   { card_id, video_url, thumbnail_url?, kind?, note? }  → append a version
//   PATCH  ?id=... { note?, thumbnail_url? }
//   DELETE ?id=...
// Uploading a fresh edit to an already approved/scheduled card repoints its
// final_version_id to that new cut, so send-to-schedule ships the latest edit
// (e.g. a re-voiced replacement) instead of the originally-approved version.
import { setCors, requireUser, supaFetch, assertProfileAccess, fmtErr } from '../_lib/supabase.js'

// Uploader display identity for the activity thread (see comments.js).
function authorFrom(user) {
  const m = user?.user_metadata || {}
  return {
    author_name: m.full_name || m.name || user?.email || 'User',
    author_avatar: m.avatar_url || m.picture || null,
  }
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const cardId = req.query.card_id
      if (!cardId) return res.status(400).json({ error: 'card_id required' })
      const cardRows = await supaFetch(`board_cards?id=eq.${cardId}&select=profile_id`)
      const profileId = cardRows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Card not found' })
      await assertProfileAccess(auth.user.id, profileId)
      const rows = await supaFetch(`board_card_versions?card_id=eq.${cardId}&order=version_no.desc&select=*`)
      return res.status(200).json({ versions: rows || [] })
    }

    if (req.method === 'POST') {
      const body = req.body || {}
      if (!body.card_id || !body.video_url) return res.status(400).json({ error: 'card_id + video_url required' })
      const cardRows = await supaFetch(`board_cards?id=eq.${body.card_id}&select=profile_id,stage,assigned_editor`)
      const card = cardRows?.[0]
      if (!card) return res.status(404).json({ error: 'Card not found' })
      const role = await assertProfileAccess(auth.user.id, card.profile_id)
      if (role === 'contributor' && card.assigned_editor !== auth.user.id) {
        return res.status(403).json({ error: 'Forbidden' })
      }
      const existing = await supaFetch(
        `board_card_versions?card_id=eq.${body.card_id}&select=version_no&order=version_no.desc&limit=1`
      )
      const nextNo = (existing?.[0]?.version_no || 0) + 1
      const kind = body.kind === 'raw' ? 'raw' : 'edit'
      const created = await supaFetch('board_card_versions', {
        method: 'POST',
        body: {
          card_id: body.card_id,
          profile_id: card.profile_id,
          version_no: nextNo,
          video_url: body.video_url,
          thumbnail_url: body.thumbnail_url || null,
          kind,
          note: body.note || null,
          uploaded_by: auth.user.id,
          ...authorFrom(auth.user),
        },
      })
      const version = Array.isArray(created) ? created[0] : created
      // Bump the card's updated_at so it sorts as recently touched; the user
      // drives the columns by dragging (no auto stage move).
      const cardPatch = { updated_at: new Date().toISOString() }
      // If the card is already approved or scheduled, a freshly uploaded edit
      // becomes the version that ships. send-to-schedule reads final_version_id,
      // so without this a re-upload to a finished card (e.g. a re-voiced cut)
      // would leave the OLD approved version as the one that schedules + posts.
      if (kind === 'edit' && ['approved', 'scheduled'].includes(card.stage)) {
        cardPatch.final_version_id = version.id
      }
      await supaFetch(`board_cards?id=eq.${body.card_id}`, {
        method: 'PATCH', body: cardPatch, prefer: 'return=minimal',
      })
      return res.status(201).json({ version })
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`board_card_versions?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      const updates = {}
      for (const k of ['note', 'thumbnail_url']) if (k in (req.body || {})) updates[k] = req.body[k]
      const updated = await supaFetch(`board_card_versions?id=eq.${id}`, { method: 'PATCH', body: updates })
      return res.status(200).json({ version: Array.isArray(updated) ? updated[0] : updated })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`board_card_versions?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      await supaFetch(`board_card_versions?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: fmtErr(err) })
  }
}
