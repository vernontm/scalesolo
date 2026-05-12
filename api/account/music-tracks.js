// /api/account/music-tracks
//   GET                          → { tracks: [...] }
//   POST   { url, name }         → { track }   (appends)
//   PATCH  { id, name }          → { ok: true } (rename)
//   DELETE ?id=...               → { ok: true }
//
// User-scoped music library. Lives on user_profiles.music_tracks so the
// same tracks are available across every brand profile the user owns
// (or has access to). The Finish video node reads this list and lets
// the user pick a specific track or "randomize" across the whole
// library.
//
// We don't host the audio file here — the upload happens via supabase
// storage on the client and the resulting public URL gets appended via
// POST.

import { setCors, requireUser, supaFetch } from '../_lib/supabase.js'

export const config = { maxDuration: 30 }

const MAX_TRACKS = 100

function newTrackId() {
  return `mt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

async function readTracks(userId) {
  const rows = await supaFetch(`user_profiles?id=eq.${userId}&select=music_tracks`)
  return Array.isArray(rows?.[0]?.music_tracks) ? rows[0].music_tracks : []
}
async function writeTracks(userId, tracks) {
  await supaFetch(`user_profiles?id=eq.${userId}`, {
    method: 'PATCH',
    body: { music_tracks: tracks },
    prefer: 'return=minimal',
  })
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return
  const userId = auth.user.id

  try {
    if (req.method === 'GET') {
      const tracks = await readTracks(userId)
      return res.status(200).json({ tracks })
    }

    if (req.method === 'POST') {
      const { url, name } = req.body || {}
      if (!url || !/^https?:\/\//.test(url)) {
        return res.status(400).json({ error: 'url (publicly fetchable) required' })
      }
      const tracks = await readTracks(userId)
      if (tracks.length >= MAX_TRACKS) {
        return res.status(400).json({ error: `Max ${MAX_TRACKS} tracks per account. Remove one first.` })
      }
      const track = {
        id: newTrackId(),
        url,
        name: String(name || '').trim().slice(0, 80) || 'Untitled track',
        added_at: new Date().toISOString(),
      }
      await writeTracks(userId, [...tracks, track])
      return res.status(201).json({ track })
    }

    if (req.method === 'PATCH') {
      const { id, name } = req.body || {}
      if (!id || !name) return res.status(400).json({ error: 'id + name required' })
      const tracks = await readTracks(userId)
      await writeTracks(userId, tracks.map((t) => t.id === id ? { ...t, name: String(name).trim().slice(0, 80) } : t))
      return res.status(200).json({ ok: true })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const tracks = await readTracks(userId)
      await writeTracks(userId, tracks.filter((t) => t.id !== id))
      return res.status(200).json({ ok: true })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    console.error('account/music-tracks error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
