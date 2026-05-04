// PUBLIC (no auth) — fetch a published form by slug for the renderer.
// GET /api/forms-public?slug=<slug>&p=<profile_id?>
import { setCors, supaFetch } from './_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const slug = req.query.slug
    const profileId = req.query.p
    if (!slug) return res.status(400).json({ error: 'slug required' })

    // Slug is unique per profile, so we need profile_id to disambiguate.
    // If not provided, return the first match (single-tenant for now).
    const path = profileId
      ? `forms?slug=eq.${encodeURIComponent(slug)}&profile_id=eq.${profileId}&is_published=eq.true&select=id,name,slug,sections,confirmation,profile_id&limit=1`
      : `forms?slug=eq.${encodeURIComponent(slug)}&is_published=eq.true&select=id,name,slug,sections,confirmation,profile_id&limit=1`
    const rows = await supaFetch(path)
    const form = rows?.[0]
    if (!form) return res.status(404).json({ error: 'Form not found or not published' })

    return res.status(200).json({ form })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
