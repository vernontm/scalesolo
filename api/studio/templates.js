// GET /api/studio/templates
//
// Returns the list of available visual templates. The Studio "new
// video" form renders these as cards in a gallery picker. Auth-gated
// like every other Studio endpoint.
//
// Response shape is the template object pruned to fields the picker
// actually needs (id, name, description, when_to_use, tags, primary
// accent for the swatch). The full spec stays server-side — the
// segmentation prompt + render pipeline read it from the constants
// directly, the client doesn't need it.

import { setCors, requireUser } from '../_lib/supabase.js'
import { gateStudio } from './_lib/gate.js'
import { TEMPLATES } from './_lib/templates.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    gateStudio(auth.user.id)
    const out = TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      when_to_use: t.when_to_use,
      tags: t.tags || [],
      primary_accent: t.colors?.primary_accent,
      composition_pool: t.composition_pool || [],
    }))
    return res.status(200).json({ templates: out })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
