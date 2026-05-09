// /api/spaces — CRUD for content-workflow canvases.
//
// Templates: a space row with is_template=true is a starting point users can
// clone. Public templates (curated) are visible to everyone; private templates
// are visible only to their creator. Templates have profile_id=NULL when public
// (system-owned) so they don't dangle off a single user's brand profile.
//   GET  ?action=templates              → list templates the caller can see
//   POST ?action=use_template           → clone a template into a target profile
//   POST ?action=save_as_template       → flag a copy of a space as a private template
import { setCors, requireUser, supaFetch, assertProfileAccess } from './_lib/supabase.js'

const ALLOWED = new Set(['name','description','nodes','edges','last_run'])

// Strip transient run state and (when cloning across profiles) brand-specific
// references that won't carry over. Used by both the duplicate action and the
// template clone path.
function scrubNodes(nodes, { crossProfile, isFromTemplate } = {}) {
  return (nodes || []).map((n) => {
    const data = { ...(n.data || {}) }
    data.status = 'idle'
    data.output = null
    data.error = null
    const props = { ...(data.props || {}) }
    // Always reset auto_run so the clone doesn't immediately fire.
    if (data.type === 'auto_run') {
      props.active = false
      props.runs_used = 0
      props.last_run_at = null
    }
    // Templates already had brand-specific values cleared at seed time, but
    // a defensive scrub here keeps user-saved private templates safe too.
    if (crossProfile || isFromTemplate) {
      if (data.type === 'avatar_picker') {
        props.avatar_id = ''
        props.look_id = ''
        props.image_id = ''
        props.image_url = ''
      }
      if (data.type === 'video_polish') {
        props.watermark_image_url = null
      }
    }
    data.props = props
    return { ...n, data }
  })
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      // ── List templates visible to caller ──
      if (req.query.action === 'templates') {
        // Public templates: anyone. Private: only those created by the caller.
        // PostgREST `or=` syntax does the union in one round trip. Order by
        // admin-set sort_order first (lower = pinned higher) then most-
        // recently-updated. Plan-gate is included so the client can show
        // a lock badge on tiers the user doesn't have.
        const filter =
          `or=(template_visibility.eq.public,and(template_visibility.eq.private,created_by.eq.${auth.user.id}))`
        const rows = await supaFetch(
          `spaces?is_template=eq.true&${filter}&order=template_sort_order.asc,template_visibility.asc,updated_at.desc&select=id,name,description,template_summary,template_visibility,template_guide,template_plan_gate,template_sort_order,nodes,edges,created_by,updated_at`
        )
        return res.status(200).json({ templates: rows || [] })
      }

      const id = req.query.id
      if (id) {
        const rows = await supaFetch(`spaces?id=eq.${id}&select=*`)
        const space = rows?.[0]
        if (!space) return res.status(404).json({ error: 'Not found' })
        // Templates are readable to anyone (public) or the creator (private).
        if (space.is_template) {
          if (space.template_visibility === 'private' && space.created_by !== auth.user.id) {
            return res.status(404).json({ error: 'Not found' })
          }
          return res.status(200).json({ space })
        }
        await assertProfileAccess(auth.user.id, space.profile_id)
        return res.status(200).json({ space })
      }
      const profileId = req.query.profile_id
      if (!profileId) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profileId)
      const rows = await supaFetch(
        // Hide template rows from the per-profile list so the user's "spaces"
        // tab stays clean even if they save private templates anchored to a
        // brand. The Templates tab is the one place templates surface.
        `spaces?profile_id=eq.${profileId}&is_template=is.false&order=updated_at.desc&select=id,name,description,updated_at,created_at`
      )
      return res.status(200).json({ spaces: rows || [] })
    }

    if (req.method === 'POST') {
      const body = req.body || {}
      const action = req.query.action || body.action

      // ── Use a template: clone it into a target profile owned by caller ──
      if (action === 'use_template') {
        const templateId = body.template_id
        const targetProfileId = body.target_profile_id
        if (!templateId || !targetProfileId) {
          return res.status(400).json({ error: 'template_id + target_profile_id required' })
        }
        const tplRows = await supaFetch(`spaces?id=eq.${templateId}&select=*`)
        const tpl = tplRows?.[0]
        if (!tpl || !tpl.is_template) return res.status(404).json({ error: 'Template not found' })
        // Visibility check: public is open to everyone; private only to creator.
        if (tpl.template_visibility === 'private' && tpl.created_by !== auth.user.id) {
          return res.status(404).json({ error: 'Template not found' })
        }
        await assertProfileAccess(auth.user.id, targetProfileId)

        const cleanedNodes = scrubNodes(tpl.nodes, { crossProfile: true, isFromTemplate: true })
        const created = await supaFetch('spaces', {
          method: 'POST',
          body: {
            profile_id: targetProfileId,
            name: body.name || tpl.name || 'Untitled space',
            description: tpl.description || null,
            nodes: cleanedNodes,
            edges: tpl.edges || [],
            // Copy the guide onto the clone so the side panel shows up again
            // every time the user re-opens this space, not just on first run.
            template_guide: tpl.template_guide || null,
          },
        })
        const space = Array.isArray(created) ? created[0] : created
        return res.status(201).json({
          space,
          template_guide: tpl.template_guide || null,
          template_id: tpl.id,
        })
      }

      // ── Save a copy of an existing space as a (private) template owned by caller ──
      if (action === 'save_as_template') {
        const sourceId = body.source_id
        if (!sourceId) return res.status(400).json({ error: 'source_id required' })
        const srcRows = await supaFetch(`spaces?id=eq.${sourceId}&select=*`)
        const src = srcRows?.[0]
        if (!src) return res.status(404).json({ error: 'Source space not found' })
        // Caller must have access to the source's profile. We deliberately do
        // not allow public templates from this endpoint — that's an admin op.
        if (src.profile_id) await assertProfileAccess(auth.user.id, src.profile_id)

        const cleanedNodes = scrubNodes(src.nodes, { crossProfile: true, isFromTemplate: false })
        const created = await supaFetch('spaces', {
          method: 'POST',
          body: {
            profile_id: null,
            name: body.name || `${src.name || 'Workflow'} template`,
            description: src.description || null,
            nodes: cleanedNodes,
            edges: src.edges || [],
            is_template: true,
            template_visibility: 'private',
            template_summary: body.summary || src.description || null,
            template_guide: body.guide || null,
            created_by: auth.user.id,
          },
        })
        return res.status(201).json({ template: Array.isArray(created) ? created[0] : created })
      }

      // ── Duplicate / clone an existing space into the same or a different
      //    brand profile owned by the same user. Higher-tier plan feature
      //    later; for now any authenticated user with access to both
      //    profiles can do it.
      if (action === 'duplicate') {
        const sourceId = body.source_id
        const targetProfileId = body.target_profile_id
        if (!sourceId || !targetProfileId) {
          return res.status(400).json({ error: 'source_id + target_profile_id required' })
        }
        const srcRows = await supaFetch(`spaces?id=eq.${sourceId}&select=*`)
        const src = srcRows?.[0]
        if (!src) return res.status(404).json({ error: 'Source space not found' })
        if (src.profile_id) await assertProfileAccess(auth.user.id, src.profile_id)
        await assertProfileAccess(auth.user.id, targetProfileId)

        const crossProfile = src.profile_id !== targetProfileId
        const cleanedNodes = scrubNodes(src.nodes, { crossProfile, isFromTemplate: false })

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
      const rows = await supaFetch(`spaces?id=eq.${id}&select=profile_id,is_template,template_visibility,created_by`)
      const row = rows?.[0]
      if (!row) return res.status(404).json({ error: 'Not found' })
      // Templates: only the creator can edit. Public templates require admin
      // (no admin role in the current model — locked out via created_by check).
      if (row.is_template) {
        if (row.created_by !== auth.user.id) return res.status(403).json({ error: 'Forbidden' })
      } else {
        if (!row.profile_id) return res.status(404).json({ error: 'Not found' })
        await assertProfileAccess(auth.user.id, row.profile_id)
      }
      const updates = {}
      for (const [k, v] of Object.entries(req.body || {})) if (ALLOWED.has(k)) updates[k] = v
      const updated = await supaFetch(`spaces?id=eq.${id}`, { method: 'PATCH', body: updates })
      return res.status(200).json({ space: Array.isArray(updated) ? updated[0] : updated })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`spaces?id=eq.${id}&select=profile_id,is_template,created_by`)
      const row = rows?.[0]
      if (!row) return res.status(404).json({ error: 'Not found' })
      if (row.is_template) {
        if (row.created_by !== auth.user.id) return res.status(403).json({ error: 'Forbidden' })
      } else {
        if (!row.profile_id) return res.status(404).json({ error: 'Not found' })
        await assertProfileAccess(auth.user.id, row.profile_id)
      }
      await supaFetch(`spaces?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
