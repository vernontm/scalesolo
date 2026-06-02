// GET /api/r/:asset?c=<contact_id>&src=email|welcome|...
//
// Trackable download redirect. Every magnet / playbook / content-pack
// download flows through this endpoint instead of the raw Supabase URL,
// so we know who downloaded what, when, and from where.
//
// Flow:
//   1. Look up the canonical URL for the requested asset.
//   2. Log to contact_activity (event_type = 'asset_downloaded') with
//      contact_id (if known), asset slug, source, user agent, IP.
//   3. Fire server-side Meta CAPI 'CustomizeProduct' / custom event
//      (best effort, never blocks the redirect).
//   4. 302-redirect to the real asset URL so the browser fetches the file.
//
// Why a server redirect (not just GA4 events):
//   - Click in an email opens in the user's mail client which then opens
//     a browser tab navigating to OUR URL. GA4 and Pixel cannot run in
//     the mail client. The only way to catch the email click is to make
//     the click go through our server.
//   - Server-side log is the canonical record. Browser events can be
//     blocked by ad blockers, but a 302 still gets logged.

import { setCors, supaFetch } from '../_lib/supabase.js'

const ASSETS = {
  blueprint: process.env.BLUEPRINT_DOWNLOAD_URL
    || 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/faceless-ai-brand-blueprint.pdf',
  playbook: process.env.TRIPWIRE_DOWNLOAD_URL
    || 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/build-your-ai-empire.pdf',
  pack: process.env.BUMP_DOWNLOAD_URL
    || 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/faceless-content-pack.zip',
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  // The [asset] dynamic param surfaces as req.query.asset on Vercel.
  // Fall back to parsing the URL in case of weird routing.
  const asset = (req.query?.asset || '').toString().toLowerCase()
    || (req.url || '').split('?')[0].split('/').filter(Boolean).pop() || ''
  const url = ASSETS[asset]
  if (!url) return res.status(404).json({ error: 'unknown asset' })

  // Best-effort activity log. Never blocks the redirect.
  const contactId = (req.query?.c || '').toString() || null
  const source    = (req.query?.src || '').toString() || ''
  const email     = (req.query?.e || '').toString().toLowerCase() || null
  const profileId = process.env.FUNNEL_PROFILE_ID

  if (profileId) {
    // If we got an email but no contact_id, try to resolve.
    let resolvedContactId = contactId
    if (!resolvedContactId && email) {
      try {
        const rows = await supaFetch(
          `email_contacts?profile_id=eq.${profileId}&email=eq.${encodeURIComponent(email)}&select=id&limit=1`
        )
        resolvedContactId = rows?.[0]?.id || null
      } catch { /* swallow */ }
    }
    if (resolvedContactId) {
      // MUST await — fire-and-forget on Vercel serverless loses the
      // log row because the function terminates the moment we send
      // the 302 response. ~50ms added latency, fine for a download
      // click. Wrapped so a Supabase outage cannot stop the file
      // from reaching the user.
      try {
        await supaFetch('rpc/log_activity', {
          method: 'POST',
          body: {
            p_profile_id: profileId,
            p_contact_id: resolvedContactId,
            p_event_type: 'asset_downloaded',
            p_payload: {
              asset,
              source: source || null,
              user_agent: (req.headers['user-agent'] || '').slice(0, 200),
              ip: ((req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim() || null,
            },
            p_source: 'redirect',
          },
        })
      } catch (e) {
        console.warn('[r] activity log failed:', e?.message || e)
      }
    }
  }

  // 302 to the real file. Cache-Control headers ensure the redirect
  // itself is not cached so click counts stay accurate.
  res.setHeader('Cache-Control', 'no-store, max-age=0')
  return res.redirect(302, url)
}
