// /api/profiles/music-tracks
//   GET    ?profile_id=...                  → { tracks: [...] }
//   POST   { profile_id, url, name }        → { track }  (appends)
//   DELETE ?profile_id=...&id=...           → { ok: true }
//
// Each track is { id, url, name, added_at }. Stored as a jsonb array on
// profiles.music_tracks so the brand owns its music library. The
// Finish video node (video_polish) reads this list and lets the user
// pick a specific track or "randomize" (pick a fresh one each render).
//
// We don't host the audio file here — the upload happens via supabase
// storage on the client and the resulting public URL gets appended via
// POST. This endpoint just maintains the metadata list.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'

export const config = { maxDuration: 30 }

const MAX_TRACKS = 50

function newTrackId() {
  return `mt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  const profile_id = req.query.profile_id || req.body?.profile_id
  if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
  await assertProfileAccess(auth.user.id, profile_id)

  try {
    if (req.method === 'GET') {
      const rows = await supaFetch(`profiles?id=eq.${profile_id}&select=music_tracks`)
      const tracks = Array.isArray(rows?.[0]?.music_tracks) ? rows[0].music_tracks : []
      return res.status(200).json({ tracks })
    }

    if (req.method === 'POST') {
      const { url, name } = req.body || {}
      if (!url || !/^https?:\/\//.test(url)) {
        return res.status(400).json({ error: 'url (publicly fetchable) required' })
      }
      const rows = await supaFetch(`profiles?id=eq.${profile_id}&select=music_tracks`)
      const tracks = Array.isArray(rows?.[0]?.music_tracks) ? rows[0].music_tracks : []
      if (tracks.length >= MAX_TRACKS) {
        return res.status(400).json({ error: `Max ${MAX_TRACKS} tracks per brand. Remove one first.` })
      }
      const track = {
        id: newTrackId(),
        url,
        name: String(name || '').trim().slice(0, 80) || 'Untitled track',
        added_at: new Date().toISOString(),
      }
      const next = [...tracks, track]
      await supaFetch(`profiles?id=eq.${profile_id}`, {
        method: 'PATCH',
        body: { music_tracks: next },
        prefer: 'return=minimal',
      })
      return res.status(201).json({ track })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`profiles?id=eq.${profile_id}&select=music_tracks`)
      const tracks = Array.isArray(rows?.[0]?.music_tracks) ? rows[0].music_tracks : []
      const next = tracks.filter((t) => t.id !== id)
      await supaFetch(`profiles?id=eq.${profile_id}`, {
        method: 'PATCH',
        body: { music_tracks: next },
        prefer: 'return=minimal',
      })
      return res.status(200).json({ ok: true })
    }

    if (req.method === 'PATCH') {
      // Rename a track in-place. Body: { id, name }
      const { id, name } = req.body || {}
      if (!id || !name) return res.status(400).json({ error: 'id + name required' })
      const rows = await supaFetch(`profiles?id=eq.${profile_id}&select=music_tracks`)
      const tracks = Array.isArray(rows?.[0]?.music_tracks) ? rows[0].music_tracks : []
      const next = tracks.map((t) => t.id === id ? { ...t, name: String(name).trim().slice(0, 80) } : t)
      await supaFetch(`profiles?id=eq.${profile_id}`, {
        method: 'PATCH',
        body: { music_tracks: next },
        prefer: 'return=minimal',
      })
      return res.status(200).json({ ok: true })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    console.error('music-tracks error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
