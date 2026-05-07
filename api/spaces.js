// /api/spaces — CRUD for content-workflow canvases.
import { setCors, requireUser, supaFetch, assertProfileAccess } from './_lib/supabase.js'

const ALLOWED = new Set(['name','description','nodes','edges','last_run'])

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const id = req.query.id
      if (id) {
        const rows = await supaFetch(`spaces?id=eq.${id}&select=*`)
        const space = rows?.[0]
        if (!space) return res.status(404).json({ error: 'Not found' })
        await assertProfileAccess(auth.user.id, space.profile_id)
        return res.status(200).json({ space })
      }
      const profileId = req.query.profile_id
      if (!profileId) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profileId)
      const rows = await supaFetch(
        `spaces?profile_id=eq.${profileId}&order=updated_at.desc&select=id,name,description,updated_at,created_at`
      )
      return res.status(200).json({ spaces: rows || [] })
    }

    if (req.method === 'POST') {
      const body = req.body || {}

      // ── Duplicate / clone an existing space into the same or a different
      //    brand profile owned by the same user. Higher-tier plan feature
      //    later; for now any authenticated user with access to both
      //    profiles can do it.
      if (req.query.action === 'duplicate' || body.action === 'duplicate') {
        const sourceId = body.source_id
        const targetProfileId = body.target_profile_id
        if (!sourceId || !targetProfileId) {
          return res.status(400).json({ error: 'source_id + target_profile_id required' })
        }
        const srcRows = await supaFetch(`spaces?id=eq.${sourceId}&select=*`)
        const src = srcRows?.[0]
        if (!src) return res.status(404).json({ error: 'Source space not found' })
        await assertProfileAccess(auth.user.id, src.profile_id)
        await assertProfileAccess(auth.user.id, targetProfileId)

        const crossProfile = src.profile_id !== targetProfileId
        // Reset every node to idle + drop transient run state. When cloning
        // across profiles, also scrub references that won't carry over
        // (avatar / look / image ids, watermark URLs, upload-post handles).
        const cleanedNodes = (src.nodes || []).map((n) => {
          const data = { ...(n.data || {}) }
          data.status = 'idle'; data.output = null; data.error = null
          const props = { ...(data.props || {}) }
          // Always reset auto_run so the clone doesn't immediately fire.
          if (data.type === 'auto_run') {
            props.active = false
            props.runs_used = 0
            props.last_run_at = null
          }
          if (crossProfile) {
            if (data.type === 'avatar_picker') {
              props.avatar_id = ''
              props.look_id = ''
              props.image_id = ''
            }
            if (data.type === 'video_polish') {
              props.watermark_image_url = null
            }
            if (data.type === 'audio_upload' || data.type === 'image_upload') {
              // URLs in these nodes point to the source profile's bucket
              // namespace. They still load (bucket is public) but the user
              // probably wants to swap them — leave them as a hint, no scrub.
            }
          }
          data.props = props
          return { ...n, data }
        })

        const created = await supaFetch('spaces', {
          method: 'POST',
          body: {
            profile_id: targetProfileId,
            name: body.name || `${src.name || 'Space'} (copy)`,
            description: src.description || null,
            nodes: cleanedNodes,
            edges: src.edges || [],
          },
        })
        const space = Array.isArray(created) ? created[0] : created
        return res.status(201).json({ space, cross_profile: crossProfile })
      }

      if (!body.profile_id) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, body.profile_id)
      const created = await supaFetch('spaces', {
        method: 'POST',
        body: {
          profile_id: body.profile_id,
          name: body.name || 'Untitled space',
          description: body.description || null,
          nodes: body.nodes || [],
          edges: body.edges || [],
        },
      })
      return res.status(201).json({ space: Array.isArray(created) ? created[0] : created })
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const id = req.query.id || (req.body && req.body.id)
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`spaces?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      const updates = {}
      for (const [k, v] of Object.entries(req.body || {})) if (ALLOWED.has(k)) updates[k] = v
      const updated = await supaFetch(`spaces?id=eq.${id}`, { method: 'PATCH', body: updates })
      return res.status(200).json({ space: Array.isArray(updated) ? updated[0] : updated })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`spaces?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      await supaFetch(`spaces?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
