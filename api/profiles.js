import { setCors, requireUser, supaFetch, assertProfileAccess } from './_lib/supabase.js'
import { indexBrandBible } from './_lib/embeddings.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return
  const userId = auth.user.id

  try {
    if (req.method === 'GET') {
      const access = await supaFetch(
        `profile_access?user_id=eq.${userId}&select=role,allowed_pages,profile:profiles(*)`
      )
      const list = (access || []).map((row) => ({ ...(row.profile || {}), role: row.role, allowed_pages: row.allowed_pages }))
      return res.status(200).json({ profiles: list })
    }

    if (req.method === 'POST') {
      const body = req.body || {}
      if (!body.business_name) return res.status(400).json({ error: 'business_name required' })
      const created = await supaFetch('profiles', {
        method: 'POST',
        body: {
          business_name: body.business_name,
          industry: body.industry || null,
          owner_name: body.owner_name || null,
          brand_primary_color: body.brand_primary_color || null,
          is_active: true,
        },
      })
      const profile = Array.isArray(created) ? created[0] : created
      await supaFetch('profile_access', {
        method: 'POST',
        body: {
          user_id: userId,
          profile_id: profile.id,
          role: 'owner',
          allowed_pages: ['*'],
        },
      })
      return res.status(201).json({ profile })
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const id = req.query.id || (req.body && req.body.id)
      if (!id) return res.status(400).json({ error: 'id required' })
      const role = await assertProfileAccess(userId, id)
      if (!['owner', 'admin'].includes(role)) return res.status(403).json({ error: 'Forbidden' })
      // Whitelist columns that are safe to PATCH on profiles. Anything else
      // (incl. context-side helpers like _role / _allowed_pages, and joined
      // access cols) is silently dropped.
      const ALLOWED = new Set([
        'business_name','owner_name','industry','business_type','website_url',
        'brand_bible','brand_bible_summary','brand_cta','brand_primary_color','brand_secondary_color',
        'brand_colors','brand_fonts','logo_url',
        'timezone','synced_platforms','posting_schedule',
        'preferred_tone','target_audience','core_hashtags','location','timezone',
        'instagram_handle','tiktok_handle','facebook_handle','threads_handle',
        'youtube_handle','linkedin_handle','x_handle',
        'instagram_id','tiktok_id','facebook_id','threads_id','youtube_id','linkedin_id',
        'uploadpost_user','uploadpost_platforms','autodm_reply_message',
        'carousel_templates','threads_style','enabled_pages',
        'agent_aggressiveness','is_active',
      ])
      const updates = {}
      for (const [k, v] of Object.entries(req.body || {})) {
        if (k === 'id') continue
        if (ALLOWED.has(k)) updates[k] = v
      }
      const brandBibleChanged = Object.prototype.hasOwnProperty.call(updates, 'brand_bible')
      const updated = await supaFetch(`profiles?id=eq.${id}`, {
        method: 'PATCH',
        body: updates,
      })
      const profile = Array.isArray(updated) ? updated[0] : updated
      // Re-embed brand bible chunks if it changed. Don't fail the save on
      // embedding errors — users can manually retrigger via /api/agent/index-brand-bible.
      if (brandBibleChanged) {
        indexBrandBible(id, profile?.brand_bible || '').catch((err) => {
          console.warn('[profiles] brand bible reindex failed:', err.message)
        })
      }
      return res.status(200).json({ profile })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const role = await assertProfileAccess(userId, id)
      if (role !== 'owner') return res.status(403).json({ error: 'Owner only' })
      await supaFetch(`profiles?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
