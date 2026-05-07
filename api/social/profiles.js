// Upload-Post user profile management for the active brand.
//
// GET  /api/social/profiles?profile_id=...
//      → { username, profile } — returns the white-label sub-account that
//        this ScaleSolo brand profile maps to. Auto-creates on Upload-Post
//        side if it doesn't exist yet, so the first call after sign-up works.
//
// POST /api/social/profiles/jwt
//      Body: { profile_id, redirect_url? }
//      → { access_url } — short-lived (48h) Upload-Post hosted page where
//        the user authenticates their TikTok / IG / etc. accounts.

import { setCors, requireUser, assertProfileAccess } from '../_lib/supabase.js'
import {
  resolveUploadpostUser, uploadpostEnsureUserProfile, uploadpostGenerateJwt,
} from '../_lib/uploadpost.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  const action = req.query.action || ''

  try {
    // POST /api/social/profiles?action=jwt
    if (req.method === 'POST' && action === 'jwt') {
      const { profile_id, redirect_url, branding } = req.body || {}
      if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profile_id)

      const username = await resolveUploadpostUser(profile_id)
      // Ensure the sub-account exists before requesting a JWT for it.
      await uploadpostEnsureUserProfile(username)
      const jwt = await uploadpostGenerateJwt(username, {
        redirect_url,
        connect_title: 'Connect your social accounts',
        connect_description: 'Link the platforms ScaleSolo should publish to.',
        ...(branding || {}),
      })
      return res.status(200).json({
        username,
        access_url: jwt.access_url,
        duration: jwt.duration,
      })
    }

    // GET /api/social/profiles?profile_id=...
    if (req.method === 'GET') {
      const profile_id = req.query.profile_id
      if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profile_id)

      const username = await resolveUploadpostUser(profile_id)
      const profile = await uploadpostEnsureUserProfile(username)
      // Normalize social_accounts into a sorted, lightweight shape.
      const social = profile?.social_accounts || {}
      const platforms = Object.entries(social).map(([id, info]) => ({
        id,
        connected: !!info && (info.connected || info.access_token || info === true),
        info,
      }))
      return res.status(200).json({ username, profile, platforms })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    console.error('social/profiles error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  }
}
