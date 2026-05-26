// Voiceover upload — two-phase signed-URL flow that bypasses
// Vercel's 4.5MB body limit. Same pattern as the per-segment avatar
// uploader at api/studio/segments/upload-avatar.js but scoped to a
// PROFILE rather than an existing segment (no segment exists yet at
// this point — the segments get created by /api/studio/voiceover/segment
// AFTER the upload finalizes).
//
// Phase 1 — POST ?mode=init
//   Body: { profile_id, filename, content_type }
//   Returns: { signed_url, path, token, content_type }
//
// Phase 2 — Browser PUTs the file to signed_url directly.
//
// Phase 3 — POST ?mode=finalize
//   Body: { profile_id, path }
//   Verifies the file landed at the expected prefix and returns the
//   final public URL the client passes into /voiceover/segment.

import { setCors, requireUser, assertProfileAccess } from '../../_lib/supabase.js'
import { gateStudio } from '../_lib/gate.js'
import { isolateAudio, resolveByoApiKey } from '../../_lib/elevenlabs.js'

const STUDIO_BUCKET = 'studio-media'
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

// Hard cap on file size we attempt to clean via ElevenLabs. Above this
// we skip cleanup and return the raw upload — keeps the serverless
// function from blowing memory on a multi-hundred-MB upload, and the
// EL endpoint gets slow + flaky on huge files anyway. 50 MB easily
// covers a 30+ minute voiceover at typical bitrates.
const MAX_CLEAN_BYTES = 50 * 1024 * 1024

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    gateStudio(auth.user.id)
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: 'Supabase storage not configured on the server.' })
    }
    const body = req.body || {}
    const profileId = body.profile_id
    if (!profileId) return res.status(400).json({ error: 'profile_id required' })
    await assertProfileAccess(auth.user.id, profileId)

    const mode = req.query.mode || 'init'

    // ── Phase 1: mint signed upload URL ────────────────────────────
    if (mode === 'init') {
      const contentType = body.content_type || 'audio/mpeg'
      // Audio formats Scribe + downstream ffmpeg accept.
      if (!/^audio\/(mpeg|mp3|wav|x-wav|x-m4a|mp4|aac|ogg|flac|webm)$/i.test(contentType)) {
        return res.status(415).json({
          error: `Unsupported content type "${contentType}". Upload MP3, WAV, M4A, AAC, OGG, or FLAC.`,
        })
      }
      const ext = (contentType.split('/')[1] || 'mp3').replace('mpeg', 'mp3').replace('x-', '').slice(0, 4)
      const path = `${profileId}/studio/voiceover/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const signResp = await fetch(
        `${SUPABASE_URL}/storage/v1/object/upload/sign/${STUDIO_BUCKET}/${encodeURI(path)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        },
      )
      if (!signResp.ok) {
        const detail = await signResp.text().catch(() => '')
        return res.status(500).json({ error: `Could not sign upload URL (${signResp.status}): ${detail.slice(0, 200)}` })
      }
      const signed = await signResp.json()
      const absUrl = `${SUPABASE_URL}/storage/v1${signed.url}`
      return res.status(200).json({
        signed_url: absUrl,
        path,
        token: signed.token,
        content_type: contentType,
      })
    }

    // ── Phase 2: finalize — clean via ElevenLabs Voice Isolator,
    //   then return the cleaned URL (or the raw one if cleanup
    //   couldn't run / failed). Errors here NEVER block the upload —
    //   the user always gets a usable voiceover_url back.
    if (mode === 'finalize') {
      const path = body.path
      if (!path) return res.status(400).json({ error: 'path required' })
      if (!path.startsWith(`${profileId}/studio/voiceover/`)) {
        return res.status(400).json({ error: 'path does not belong to this profile' })
      }
      const rawUrl = `${SUPABASE_URL}/storage/v1/object/public/${STUDIO_BUCKET}/${path}`

      // Try cleanup. If anything goes wrong we still return rawUrl so
      // the user's upload is never lost. cleaned=false in the response
      // tells the client (and lets us surface a "raw audio used" note
      // in the UI if we want to in the future).
      let voiceoverUrl = rawUrl
      let cleanedPath = null
      let cleanError = null
      try {
        const rawResp = await fetch(rawUrl)
        if (!rawResp.ok) throw new Error(`Could not re-download upload (${rawResp.status})`)
        const contentLength = Number(rawResp.headers.get('content-length') || 0)
        if (contentLength && contentLength > MAX_CLEAN_BYTES) {
          throw new Error(`File too large to clean (${Math.round(contentLength / 1024 / 1024)} MB > 50 MB cap)`)
        }
        const rawBuf = Buffer.from(await rawResp.arrayBuffer())
        if (rawBuf.length > MAX_CLEAN_BYTES) {
          throw new Error(`File too large to clean (${Math.round(rawBuf.length / 1024 / 1024)} MB > 50 MB cap)`)
        }
        // Prefer the user's BYOK ElevenLabs key when they've connected
        // one — keeps the usage on their account. Fall back to our
        // master key otherwise.
        const byoKey = await resolveByoApiKey(profileId)
        const sourceMime = req.body?.content_type || 'audio/mpeg'
        const cleanedBuf = await isolateAudio(
          rawBuf,
          path.split('/').pop() || 'voiceover.mp3',
          sourceMime,
          byoKey ? { apiKey: byoKey } : {},
        )

        // Upload the cleaned MP3 next to the raw file with -cleaned.mp3
        // suffix. We keep the raw upload around so we can re-run
        // cleanup later or fall back if a render shows artifacts.
        const cleanedFilename = path
          .replace(/\.[^./]+$/, '')
          .concat('-cleaned.mp3')
        const putResp = await fetch(
          `${SUPABASE_URL}/storage/v1/object/${STUDIO_BUCKET}/${encodeURI(cleanedFilename)}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
              'Content-Type': 'audio/mpeg',
              'x-upsert': 'true',
            },
            body: cleanedBuf,
          },
        )
        if (!putResp.ok) {
          const detail = await putResp.text().catch(() => '')
          throw new Error(`Storage upload of cleaned audio failed (${putResp.status}): ${detail.slice(0, 200)}`)
        }
        cleanedPath = cleanedFilename
        voiceoverUrl = `${SUPABASE_URL}/storage/v1/object/public/${STUDIO_BUCKET}/${cleanedFilename}`
      } catch (e) {
        cleanError = e?.message || String(e)
        console.warn(`[voiceover/upload] cleanup failed, returning raw audio: ${cleanError}`)
      }

      return res.status(200).json({
        ok: true,
        voiceover_url: voiceoverUrl,
        path: cleanedPath || path,
        raw_url: rawUrl,
        raw_path: path,
        cleaned: !!cleanedPath,
        clean_error: cleanError,
      })
    }

    return res.status(400).json({ error: `Unknown mode "${mode}". Use init or finalize.` })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || String(err) })
  }
}
