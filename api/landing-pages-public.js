// PUBLIC — fetch a published landing page by slug for the renderer.
// GET /api/landing-pages-public?slug=<slug>&p=<profile_id?>
import { setCors, supaFetch } from './_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const slug = req.query.slug
    const profileId = req.query.p
    if (!slug) return res.status(400).json({ error: 'slug required' })

    const path = profileId
      ? `landing_pages?slug=eq.${encodeURIComponent(slug)}&profile_id=eq.${profileId}&is_published=eq.true&select=id,name,slug,sections,meta,profile_id&limit=1`
      : `landing_pages?slug=eq.${encodeURIComponent(slug)}&is_published=eq.true&select=id,name,slug,sections,meta,profile_id&limit=1`
    const rows = await supaFetch(path)
    const page = rows?.[0]
    if (!page) return res.status(404).json({ error: 'Page not found or not published' })

    // Hydrate brand styling for the renderer
    const profRows = await supaFetch(`profiles?id=eq.${page.profile_id}&select=business_name,brand_primary_color,brand_secondary_color,logo_url`)
    return res.status(200).json({ page, brand: profRows?.[0] || null })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
