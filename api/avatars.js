// Avatars CRUD.
import { setCors, requireUser, supaFetch, assertProfileAccess } from './_lib/supabase.js'
import { MODELS } from './_lib/heygen.js'

const ALLOWED = new Set([
  'name','heygen_group_id','elevenlabs_voice_id','voice_owner','model_version',
  // ElevenLabs voice tuning — see migrations 0024, 0026.
  'voice_settings','voice_model_id','voice_language',
  'talking_photo_id','photo_url','thumbnail_url','training_status','training_error',
  'logo_url','logo_position','logo_size_pct','caption_style','title_style',
  'default_music_url','default_volume','default_fade_secs',
])

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const id = req.query.id
      if (id) {
        const rows = await supaFetch(`avatars?id=eq.${id}&select=*,looks:avatar_looks(*,images:avatar_look_images(*))`)
        const a = rows?.[0]
        if (!a) return res.status(404).json({ error: 'Not found' })
        await assertProfileAccess(auth.user.id, a.profile_id)
        return res.status(200).json({ avatar: a })
      }
      const profileId = req.query.profile_id
      if (!profileId) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profileId)
      const rows = await supaFetch(
        `avatars?profile_id=eq.${profileId}&order=created_at.desc&select=*,looks:avatar_looks(id,name,kind,images:avatar_look_images(id,image_url,name,order_index))`
      )

      // Default avatars (admin-curated, shared across every user). We
      // attach a per-user voice override if the user has one — that
      // lets the user-side dropdown show their preferred voice without
      // a second round trip. Tagged with is_default=true so the
      // /avatars page can render them read-only.
      let defaults = []
      try {
        const [defaultRows, overrideRows] = await Promise.all([
          supaFetch(
            'default_avatars?is_active=eq.true' +
            '&select=id,name,description,heygen_group_id,elevenlabs_voice_id,default_voice_label,preview_image_url,sort_order,looks:default_avatar_looks(id,image_url,label,heygen_look_id,angle_order)' +
            '&order=sort_order.asc,created_at.asc'
          ),
          supaFetch(
            `default_avatar_voice_overrides?user_id=eq.${auth.user.id}` +
            '&select=default_avatar_id,elevenlabs_voice_id,voice_label'
          ).catch(() => []),
        ])
        const overrideByAvatarId = {}
        for (const o of overrideRows || []) overrideByAvatarId[o.default_avatar_id] = o
        defaults = (defaultRows || []).map((d) => {
          const ov = overrideByAvatarId[d.id]
          return {
            ...d,
            is_default: true,
            voice_override: ov ? { elevenlabs_voice_id: ov.elevenlabs_voice_id, voice_label: ov.voice_label || null } : null,
            // Effective voice = user override > admin default.
            effective_voice_id:    ov?.elevenlabs_voice_id   || d.elevenlabs_voice_id || null,
            effective_voice_label: ov?.voice_label           || d.default_voice_label  || null,
          }
        })
      } catch { /* defaults are best-effort; never block the response */ }

      return res.status(200).json({
        avatars: rows || [],
        default_avatars: defaults,
        models: MODELS,
      })
    }

    if (req.method === 'POST') {
      const body = req.body || {}
      if (!body.profile_id || !body.name) {
        return res.status(400).json({ error: 'profile_id + name required' })
      }
      await assertProfileAccess(auth.user.id, body.profile_id)
      const row = { profile_id: body.profile_id }
      for (const [k, v] of Object.entries(body)) if (ALLOWED.has(k)) row[k] = v
      const created = await supaFetch('avatars', { method: 'POST', body: row })
      return res.status(201).json({ avatar: Array.isArray(created) ? created[0] : created })
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`avatars?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      const updates = {}
      for (const [k, v] of Object.entries(req.body || {})) if (ALLOWED.has(k)) updates[k] = v
      const updated = await supaFetch(`avatars?id=eq.${id}`, { method: 'PATCH', body: updates })
      return res.status(200).json({ avatar: Array.isArray(updated) ? updated[0] : updated })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`avatars?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      await supaFetch(`avatars?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
