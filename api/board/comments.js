// Board card feedback thread.
//   GET    ?card_id=...       → comments (oldest first)
//   POST   { card_id, body }  → add a comment
//   DELETE ?id=...
import { setCors, requireUser, supaFetch, assertProfileAccess, fmtErr } from '../_lib/supabase.js'

// Display identity for the activity thread, pulled from the signed-in user's
// metadata (Google/OAuth fills full_name + avatar_url). Denormalized onto the
// row so the feed renders without joining to auth.users.
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
      const rows = await supaFetch(`board_card_comments?card_id=eq.${cardId}&order=created_at.asc&select=*`)
      return res.status(200).json({ comments: rows || [] })
    }

    if (req.method === 'POST') {
      const body = req.body || {}
      if (!body.card_id || !String(body.body || '').trim()) {
        return res.status(400).json({ error: 'card_id + body required' })
      }
      const cardRows = await supaFetch(`board_cards?id=eq.${body.card_id}&select=profile_id,assigned_editor`)
      const card = cardRows?.[0]
      const profileId = card?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Card not found' })
      const role = await assertProfileAccess(auth.user.id, profileId)
      if (role === 'contributor' && card.assigned_editor !== auth.user.id) {
        return res.status(403).json({ error: 'Forbidden' })
      }
      const created = await supaFetch('board_card_comments', {
        method: 'POST',
        body: {
          card_id: body.card_id,
          profile_id: profileId,
          author_id: auth.user.id,
          body: String(body.body).trim().slice(0, 4000),
          target_version_id: body.target_version_id || null,
          parent_comment_id: body.parent_comment_id || null,
          ...authorFrom(auth.user),
        },
      })
      return res.status(201).json({ comment: Array.isArray(created) ? created[0] : created })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`board_card_comments?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      await supaFetch(`board_card_comments?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: fmtErr(err) })
  }
}
