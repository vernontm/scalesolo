import { setCors, requireUser, supaFetch } from './_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const access = await supaFetch(
      `profile_access?user_id=eq.${auth.user.id}&select=role,allowed_pages,profile:profiles(id,business_name,industry,brand_primary_color,logo_url,is_active)`
    )
    return res.status(200).json({
      user: {
        id: auth.user.id,
        email: auth.user.email,
        metadata: auth.user.user_metadata || {},
      },
      profiles: (access || []).map((row) => ({
        ...(row.profile || {}),
        role: row.role,
        allowed_pages: row.allowed_pages,
      })),
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
