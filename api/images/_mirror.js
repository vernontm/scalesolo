// Mirror a remote image (KIE tempfile, etc.) into our Supabase storage so the
// browser can render and download it without CORS pain. Falls back to the
// original URL if the mirror fails.

export async function mirrorToStorage(url, profileId) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return url
    const r = await fetch(url)
    if (!r.ok) return url
    const buf = await r.arrayBuffer()
    const ct = r.headers.get('content-type') || 'image/png'
    const ext = ct.includes('jpeg') ? 'jpg' : ct.includes('webp') ? 'webp' : 'png'
    const path = `${profileId || 'shared'}/spaces/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const upload = await fetch(
      `${process.env.SUPABASE_URL}/storage/v1/object/landing-media/${encodeURI(path)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': ct,
          'x-upsert': 'true',
        },
        body: buf,
      }
    )
    if (!upload.ok) return url
    return `${process.env.SUPABASE_URL}/storage/v1/object/public/landing-media/${path}`
  } catch {
    return url
  }
}
