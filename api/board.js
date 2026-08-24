// Video production board — cards CRUD + drag-move + send-to-schedule.
//   GET    ?profile_id=...                          → cards (+versions, +comment counts) for a brand
//   POST   { profile_id, title, stage?, raw_video_url? }  → create card (+ optional first raw version)
//   PATCH  ?id=... { title?, assigned_editor?, final_version_id?, source_note?, stage?, position? }
//   POST   ?id=...&action=move { stage, position }  → drag persist
//   POST   ?id=...&action=send-to-schedule          → spawn a content_scripts draft (owner/admin)
//   DELETE ?id=...
//
// Each card becomes a scheduled post by spawning a normal content_scripts draft
// (same shape bulk upload uses) that flows into the existing scheduler — no new
// posting code lives here.
import { setCors, requireUser, supaFetch, assertProfileAccess, fmtErr } from './_lib/supabase.js'

const STAGES = ['raw', 'editing', 'in_review', 'needs_revisions', 'approved', 'scheduled']

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    // ── GET: cards for one brand, or (no profile_id) the unified board across
    // every brand the user can access. Each card carries its brand + versions +
    // comment count. The versions embed names its FK explicitly because
    // board_cards has TWO relationships to board_card_versions (card_id and the
    // final_version_id back-ref).
    if (req.method === 'GET') {
      const profileId = req.query.profile_id
      const select = '*,brand:profiles(id,business_name),' +
        'versions:board_card_versions!board_card_versions_card_id_fkey(id,version_no,video_url,thumbnail_url,kind,note,uploaded_by,created_at),' +
        'comments:board_card_comments(count)'
      let filter
      if (profileId) {
        await assertProfileAccess(auth.user.id, profileId)
        filter = `profile_id=eq.${profileId}`
      } else {
        const access = await supaFetch(`profile_access?user_id=eq.${auth.user.id}&select=profile_id`)
        const ids = (access || []).map((a) => a.profile_id).filter(Boolean)
        if (!ids.length) return res.status(200).json({ cards: [] })
        filter = `profile_id=in.(${ids.join(',')})`
      }
      const cards = await supaFetch(`board_cards?${filter}&order=position.asc,created_at.asc&select=${select}`)
      return res.status(200).json({ cards: cards || [] })
    }

    // ── POST ?action=move ── drag persist
    if (req.method === 'POST' && req.query.action === 'move') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const body = req.body || {}
      if (!body.stage || !STAGES.includes(body.stage)) return res.status(400).json({ error: 'valid stage required' })
      const rows = await supaFetch(`board_cards?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      const updated = await supaFetch(`board_cards?id=eq.${id}`, {
        method: 'PATCH',
        body: { stage: body.stage, position: body.position ?? 0, updated_at: new Date().toISOString() },
      })
      return res.status(200).json({ card: Array.isArray(updated) ? updated[0] : updated })
    }

    // ── POST ?action=send-to-schedule ── spawn a content_scripts draft
    if (req.method === 'POST' && req.query.action === 'send-to-schedule') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(
        `board_cards?id=eq.${id}&select=*,versions:board_card_versions!board_card_versions_card_id_fkey(id,video_url,version_no,created_at)`
      )
      const cardRow = rows?.[0]
      if (!cardRow) return res.status(404).json({ error: 'Not found' })
      const role = await assertProfileAccess(auth.user.id, cardRow.profile_id)
      if (!['owner', 'admin'].includes(role)) {
        return res.status(403).json({ error: 'Only an owner or admin can send a card to scheduling.' })
      }
      // Idempotent: if this card already spawned a draft, return it.
      if (cardRow.content_script_id) {
        return res.status(200).json({ card: cardRow, content_id: cardRow.content_script_id, already: true })
      }
      // Resolve the final video: explicit final_version_id, else the newest version.
      const versions = Array.isArray(cardRow.versions) ? cardRow.versions.slice() : []
      versions.sort((a, b) => (b.version_no || 0) - (a.version_no || 0))
      const finalV = cardRow.final_version_id
        ? versions.find((v) => v.id === cardRow.final_version_id)
        : versions[0]
      if (!finalV?.video_url) {
        return res.status(400).json({ error: 'This card has no uploaded video to schedule yet.', code: 'no_media' })
      }
      // Create a content_scripts draft — same shape bulk upload uses. Platforms
      // are left empty so the Schedule page fills the brand defaults at schedule
      // time; captions get written there by the (frame-first) generator.
      const created = await supaFetch('content_scripts', {
        method: 'POST',
        body: {
          profile_id: cardRow.profile_id,
          title: (cardRow.title || 'Untitled').slice(0, 200),
          media_urls: [finalV.video_url],
          media_type: 'video',
          post_type: 'video',
          status: 'draft',
          generated_by: 'board',
        },
      })
      const draft = Array.isArray(created) ? created[0] : created
      if (!draft?.id) return res.status(502).json({ error: 'Failed to create the schedule draft.' })
      const updated = await supaFetch(`board_cards?id=eq.${id}`, {
        method: 'PATCH',
        body: { content_script_id: draft.id, stage: 'scheduled', updated_at: new Date().toISOString() },
      })
      return res.status(200).json({ card: Array.isArray(updated) ? updated[0] : updated, content_id: draft.id })
    }

    // ── POST: create a card (+ optional first raw version) ──
    if (req.method === 'POST') {
      const body = req.body || {}
      if (!body.profile_id) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, body.profile_id)
      const stage = STAGES.includes(body.stage) ? body.stage : 'raw'
      const created = await supaFetch('board_cards', {
        method: 'POST',
        body: {
          profile_id: body.profile_id,
          title: (body.title || 'Untitled').slice(0, 200),
          stage,
          position: body.position ?? 0,
          source_note: body.source_note || null,
          created_by: auth.user.id,
        },
      })
      const cardRow = Array.isArray(created) ? created[0] : created
      cardRow.versions = []
      cardRow.comments = [{ count: 0 }]
      // Optional first (raw) version uploaded at creation time.
      if (cardRow?.id && body.raw_video_url) {
        const v = await supaFetch('board_card_versions', {
          method: 'POST',
          body: {
            card_id: cardRow.id,
            profile_id: body.profile_id,
            version_no: 1,
            video_url: body.raw_video_url,
            thumbnail_url: body.thumbnail_url || null,
            kind: 'raw',
            note: body.version_note || null,
            uploaded_by: auth.user.id,
          },
        })
        cardRow.versions = Array.isArray(v) ? v : [v]
      }
      return res.status(201).json({ card: cardRow })
    }

    // ── PATCH: update card fields ──
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`board_cards?id=eq.${id}&select=profile_id`)
      const currentProfile = rows?.[0]?.profile_id
      if (!currentProfile) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, currentProfile)
      const allowed = ['title', 'assigned_editor', 'final_version_id', 'source_note', 'stage', 'position', 'profile_id']
      const updates = {}
      for (const k of allowed) if (k in (req.body || {})) updates[k] = req.body[k]
      if (updates.stage && !STAGES.includes(updates.stage)) return res.status(400).json({ error: 'invalid stage' })
      // Reassigning a card to a different brand: authorize the target and
      // cascade the denormalized profile_id onto its versions + comments so
      // their RLS stays consistent with the card.
      const newProfile = updates.profile_id
      const brandChanged = newProfile && newProfile !== currentProfile
      if (brandChanged) await assertProfileAccess(auth.user.id, newProfile)
      updates.updated_at = new Date().toISOString()
      const updated = await supaFetch(`board_cards?id=eq.${id}`, { method: 'PATCH', body: updates })
      if (brandChanged) {
        await supaFetch(`board_card_versions?card_id=eq.${id}`, { method: 'PATCH', body: { profile_id: newProfile }, prefer: 'return=minimal' })
        await supaFetch(`board_card_comments?card_id=eq.${id}`, { method: 'PATCH', body: { profile_id: newProfile }, prefer: 'return=minimal' })
      }
      return res.status(200).json({ card: Array.isArray(updated) ? updated[0] : updated })
    }

    // ── DELETE ──
    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`board_cards?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      await supaFetch(`board_cards?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: fmtErr(err) })
  }
}
