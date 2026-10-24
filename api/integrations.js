// VTM CRM integration endpoint.
//
//   POST /api/integrations?op=overview   token.pid=<brand>      -> one brand's status summary
//   POST /api/integrations?op=clients     token.pid="*" (admin)  -> all brands + sync status
//   POST /api/integrations?op=act         token.act=<action>     -> a role-gated write
//
// Auth is a signed token in the Authorization header (see api/_lib/vtm-integration.js).
// The acting VTM user's role is inside that token; ScaleSolo re-checks role ->
// capability here, scopes every action to the token's profile, and audits writes.
// Inert (503) until VTM_INTEGRATION_SECRET is set, so this ships safely.

import { setCors, supaFetch, isUuid, fmtErr } from './_lib/supabase.js'
import { verifyToken, canRead, canDo, audit, isConfigured, PHASE2_ACTIONS } from './_lib/vtm-integration.js'

const STAGES = ['raw', 'editing', 'in_review', 'needs_revisions', 'approved', 'scheduled']
const APPROVED_STAGES = new Set(['approved', 'scheduled'])

function tallyBy(rows, key) {
  const out = {}
  for (const r of rows || []) { const k = r?.[key] || 'unknown'; out[k] = (out[k] || 0) + 1 }
  return out
}

// Connected platform ids from an Upload-Post user profile's social_accounts
// (twitter normalized to x). Used by connect-link to report live state.
function platformsFromProfile(profile) {
  const social = profile?.social_accounts || profile?.profile?.social_accounts || {}
  const alias = (k) => (String(k).toLowerCase() === 'twitter' ? 'x' : String(k).toLowerCase())
  const out = new Set()
  if (social && typeof social === 'object' && !Array.isArray(social)) {
    for (const [k, v] of Object.entries(social)) {
      if (v === true || v?.connected || v?.access_token || v?.username) out.add(alias(k))
    }
  }
  for (const p of (profile?.platforms || profile?.connected_platforms || [])) out.add(alias(p))
  return [...out]
}

async function brandRow(pid) {
  const rows = await supaFetch(
    `profiles?id=eq.${pid}&select=id,business_name,timezone,default_platforms,uploadpost_platforms,tiktok_force_direct_post&limit=1`,
  )
  return Array.isArray(rows) ? rows[0] : null
}

// contact_email / external_ref arrive with migration 0079. Read them separately
// and best-effort so overview/clients keep working if the migration is not
// applied yet (a bare select of a missing column would 400 the whole query).
async function linkFields(filter) {
  const rows = await supaFetch(`profiles?${filter}&select=id,contact_email,external_ref`).catch(() => null)
  if (!Array.isArray(rows)) return new Map()
  return new Map(rows.map((r) => [r.id, { contact_email: r.contact_email || null, external_ref: r.external_ref || null }]))
}

async function overview(pid) {
  const brand = await brandRow(pid)
  if (!brand) { const e = new Error('Brand not found'); e.status = 404; throw e }
  const ex = (await linkFields(`id=eq.${pid}&limit=1`)).get(pid) || { contact_email: null, external_ref: null }

  const posts = await supaFetch(
    `content_scripts?profile_id=eq.${pid}&select=status,scheduled_datetime&limit=2000`,
  ).catch(() => [])
  const byStatus = tallyBy(posts, 'status')
  const nowIso = new Date().toISOString()
  const futureScheduled = (posts || [])
    .filter((p) => p.status === 'scheduled' && p.scheduled_datetime && p.scheduled_datetime > nowIso)
    .map((p) => p.scheduled_datetime).sort()
  const postedTimes = (posts || [])
    .filter((p) => p.status === 'posted' && p.scheduled_datetime)
    .map((p) => p.scheduled_datetime).sort()

  const cards = await supaFetch(
    `board_cards?profile_id=eq.${pid}&archived_at=is.null&select=stage,assigned_editor_name,assigned_editor_email&limit=1000`,
  ).catch(() => [])
  const boardByStage = tallyBy(cards, 'stage')
  const editors = {}
  for (const c of cards || []) {
    const name = c.assigned_editor_name || c.assigned_editor_email
    if (name) editors[name] = (editors[name] || 0) + 1
  }

  const connected = Array.isArray(brand.uploadpost_platforms) ? brand.uploadpost_platforms.filter(Boolean) : []
  return {
    profile_id: brand.id,
    business_name: brand.business_name,
    contact_email: ex.contact_email,
    external_ref: ex.external_ref,
    timezone: brand.timezone || null,
    synced: connected.length > 0 || (posts || []).length > 0,
    connected_platforms: connected,
    default_platforms: Array.isArray(brand.default_platforms) ? brand.default_platforms : [],
    tiktok_force_direct_post: !!brand.tiktok_force_direct_post,
    posts: {
      draft: byStatus.draft || 0,
      caption_ready: byStatus.caption_ready || 0,
      scheduled: byStatus.scheduled || 0,
      posted: byStatus.posted || 0,
      failed: byStatus.failed || 0,
    },
    next_scheduled_at: futureScheduled[0] || null,
    last_posted_at: postedTimes[postedTimes.length - 1] || null,
    board: {
      editing: boardByStage.editing || 0,
      in_review: boardByStage.in_review || 0,
      needs_revisions: boardByStage.needs_revisions || 0,
      approved: boardByStage.approved || 0,
      scheduled: boardByStage.scheduled || 0,
    },
    awaiting_review: boardByStage.in_review || 0,
    editors: Object.entries(editors).map(([name, assigned_cards]) => ({ name, assigned_cards })),
    updated_at: new Date().toISOString(),
  }
}

async function clients() {
  const rows = await supaFetch(
    'profiles?select=id,business_name,uploadpost_platforms&order=business_name.asc&limit=1000',
  ).catch(() => [])
  const ex = await linkFields('limit=1000')
  return (rows || []).map((b) => {
    const connected = Array.isArray(b.uploadpost_platforms) ? b.uploadpost_platforms.filter(Boolean) : []
    const link = ex.get(b.id) || { contact_email: null, external_ref: null }
    return {
      profile_id: b.id,
      business_name: b.business_name,
      contact_email: link.contact_email,
      external_ref: link.external_ref,
      connected_platforms: connected,
      synced: connected.length > 0,
    }
  })
}

// ── write actions (Phase 1: pure DB state, no live upload-post submit) ──────
async function act(action, pid, body) {
  if (action === 'edit-caption') {
    const id = body?.target_id
    if (!isUuid(id)) { const e = new Error('target_id required'); e.status = 400; throw e }
    const rows = await supaFetch(`content_scripts?id=eq.${id}&select=id,profile_id,status&limit=1`)
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row || row.profile_id !== pid) { const e = new Error('Post not found for this brand'); e.status = 404; throw e }
    if (['scheduled', 'posted'].includes(row.status)) {
      const e = new Error('Editing a live post is not available in phase 1'); e.status = 409; e.code = 'phase2'; throw e
    }
    const patch = {}
    if (typeof body.caption === 'string') patch.caption = body.caption
    if (typeof body.hashtags === 'string') patch.hashtags = body.hashtags
    if (!Object.keys(patch).length) { const e = new Error('caption or hashtags required'); e.status = 400; throw e }
    await supaFetch(`content_scripts?id=eq.${id}`, { method: 'PATCH', body: patch, prefer: 'return=minimal' })
    return { ok: true, target_id: id, updated: Object.keys(patch) }
  }

  if (action === 'set-defaults') {
    const patch = {}
    if (Array.isArray(body.default_platforms)) patch.default_platforms = body.default_platforms.map(String)
    if (typeof body.tiktok_force_direct_post === 'boolean') patch.tiktok_force_direct_post = body.tiktok_force_direct_post
    if (!Object.keys(patch).length) { const e = new Error('default_platforms or tiktok_force_direct_post required'); e.status = 400; throw e }
    await supaFetch(`profiles?id=eq.${pid}`, { method: 'PATCH', body: patch, prefer: 'return=minimal' })
    return { ok: true, profile_id: pid, updated: Object.keys(patch) }
  }

  if (action === 'approve-card' || action === 'move-card') {
    const cardId = body?.card_id
    if (!isUuid(cardId)) { const e = new Error('card_id required'); e.status = 400; throw e }
    const rows = await supaFetch(`board_cards?id=eq.${cardId}&select=id,profile_id,stage,approved_at&limit=1`)
    const card = Array.isArray(rows) ? rows[0] : null
    if (!card || card.profile_id !== pid) { const e = new Error('Card not found for this brand'); e.status = 404; throw e }
    const stage = action === 'approve-card' ? 'approved' : body?.stage
    if (!STAGES.includes(stage)) { const e = new Error('invalid stage'); e.status = 400; throw e }
    const patch = { stage, updated_at: new Date().toISOString() }
    if (APPROVED_STAGES.has(stage) && !card.approved_at) patch.approved_at = new Date().toISOString()
    await supaFetch(`board_cards?id=eq.${cardId}`, { method: 'PATCH', body: patch, prefer: 'return=minimal' })
    return { ok: true, card_id: cardId, stage }
  }

  if (action === 'set-external-ref') {
    const raw = body?.external_ref
    const clearing = raw === null || raw === undefined || raw === ''   // unlink
    if (!clearing && (typeof raw !== 'string' || raw.length > 200)) { const e = new Error('external_ref must be a string up to 200 chars'); e.status = 400; throw e }
    const ref = clearing ? null : raw.trim()
    try {
      // A ref must point at exactly one brand. If another brand already holds
      // it, refuse rather than create the ambiguity the CRM is avoiding.
      if (ref) {
        const held = await supaFetch(`profiles?external_ref=eq.${encodeURIComponent(ref)}&select=id&limit=2`)
        const other = (Array.isArray(held) ? held : []).find((r) => r.id !== pid)
        if (other) { const e = new Error('external_ref is already linked to another brand'); e.status = 409; e.code = 'ref_conflict'; throw e }
      }
      await supaFetch(`profiles?id=eq.${pid}`, { method: 'PATCH', body: { external_ref: ref }, prefer: 'return=minimal' })
    } catch (e) {
      if (e.status === 409) throw e
      // Column not there yet (migration 0079 unapplied): say so clearly.
      if (/external_ref|column/i.test(String(e.message || ''))) { const ne = new Error('external_ref is unavailable until migration 0079 is applied'); ne.status = 503; ne.code = 'needs_migration'; throw ne }
      throw e
    }
    return { ok: true, profile_id: pid, external_ref: ref }
  }

  if (action === 'create-brand') {
    // The CRM creates a brand up front and stores the returned profile_id, so
    // the link is exact from the first second. pid is not used (no brand yet).
    const ownerId = process.env.VTM_INTEGRATION_OWNER_USER_ID
    if (!ownerId) { const e = new Error('Brand creation is not configured (owner user id missing)'); e.status = 503; e.code = 'not_configured'; throw e }
    const name = typeof body?.business_name === 'string' ? body.business_name.trim() : ''
    if (!name) { const e = new Error('business_name required'); e.status = 400; throw e }
    const insert = { business_name: name.slice(0, 200), is_active: true }
    if (typeof body.timezone === 'string' && body.timezone) insert.timezone = body.timezone
    if (typeof body.contact_email === 'string' && body.contact_email) insert.contact_email = body.contact_email.trim()
    if (typeof body.external_ref === 'string' && body.external_ref) insert.external_ref = body.external_ref.trim()
    if (insert.external_ref) {
      const held = await supaFetch(`profiles?external_ref=eq.${encodeURIComponent(insert.external_ref)}&select=id&limit=1`).catch(() => [])
      if (Array.isArray(held) && held.length) { const e = new Error('external_ref is already linked to another brand'); e.status = 409; e.code = 'ref_conflict'; throw e }
    }
    let created
    try {
      const rows = await supaFetch('profiles', { method: 'POST', body: insert })
      created = Array.isArray(rows) ? rows[0] : rows
    } catch (e) {
      if (/contact_email|external_ref|column/i.test(String(e.message || ''))) { const ne = new Error('contact_email / external_ref need migration 0079 applied first'); ne.status = 503; ne.code = 'needs_migration'; throw ne }
      throw e
    }
    if (!created?.id) { const e = new Error('Brand creation failed'); e.status = 502; throw e }
    // Grant the ScaleSolo account owner access so the brand shows up in the app.
    await supaFetch('profile_access', { method: 'POST', prefer: 'return=minimal', body: { user_id: ownerId, profile_id: created.id, role: 'owner', allowed_pages: ['*'] } }).catch(() => {})
    return {
      ok: true, profile_id: created.id, business_name: created.business_name,
      contact_email: insert.contact_email || null, external_ref: insert.external_ref || null,
      synced: false, connected_platforms: [],
    }
  }

  if (action === 'connect-link') {
    // Mint the Upload-Post connect link for this brand so the CRM can send it
    // to the client. Requires the brand to exist (token scoped to its pid).
    const { resolveUploadpostUser, uploadpostEnsureUserProfile, uploadpostGenerateJwt } = await import('./_lib/uploadpost.js')
    const username = await resolveUploadpostUser(pid)
    const profile = await uploadpostEnsureUserProfile(username)
    const jwt = await uploadpostGenerateJwt(username, {
      redirect_url: body?.redirect_url,
      connect_title: 'Connect your social accounts',
      connect_description: 'Link the platforms we should publish to.',
    })
    return { ok: true, profile_id: pid, access_url: jwt.access_url, duration: jwt.duration, connected_platforms: platformsFromProfile(profile) }
  }

  const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!isConfigured()) return res.status(503).json({ error: 'Integration not configured', code: 'not_configured' })

  let claims
  try {
    claims = verifyToken(req.headers.authorization || req.headers['x-vtm-token'])
  } catch (e) {
    return res.status(e.status || 401).json({ error: fmtErr(e) })
  }

  const op = String(req.query.op || '')
  const body = req.body || {}
  try {
    if (op === 'overview') {
      if (!canRead(claims.role)) return res.status(403).json({ error: 'Role cannot read' })
      if (!isUuid(claims.pid)) return res.status(400).json({ error: 'Token is not scoped to a brand' })
      return res.status(200).json(await overview(claims.pid))
    }
    if (op === 'clients') {
      if (claims.role !== 'admin') return res.status(403).json({ error: 'Admin role required to list brands' })
      return res.status(200).json({ clients: await clients() })
    }
    if (op === 'act') {
      const action = String(claims.act || body.action || '')
      if (PHASE2_ACTIONS.has(action)) {
        return res.status(501).json({ error: `Action "${action}" is not available yet (phase 2)`, code: 'phase2' })
      }
      if (!canDo(claims.role, action)) {
        await audit(supaFetch, { actorId: claims.aid, role: claims.role, action, profileId: claims.pid, result: 'denied' })
        return res.status(403).json({ error: `Role "${claims.role}" cannot perform "${action}"` })
      }
      // create-brand has no brand yet, so it is the one action not scoped to a pid.
      if (action !== 'create-brand' && !isUuid(claims.pid)) return res.status(400).json({ error: 'Token is not scoped to a brand' })
      const out = await act(action, claims.pid, body)
      await audit(supaFetch, { actorId: claims.aid, role: claims.role, action, profileId: isUuid(claims.pid) ? claims.pid : (out.profile_id || null), targetId: out.target_id || out.card_id || out.profile_id || null, result: 'ok' })
      return res.status(200).json(out)
    }
    return res.status(400).json({ error: 'Unknown op. Use overview, clients, or act.' })
  } catch (e) {
    // Record failed writes for the audit trail.
    if (op === 'act') {
      await audit(supaFetch, { actorId: claims.aid, role: claims.role, action: String(claims.act || body.action || ''), profileId: claims.pid, result: 'error', meta: { message: fmtErr(e) } })
    }
    return res.status(e.status || 500).json({ error: fmtErr(e), ...(e.code ? { code: e.code } : {}) })
  }
}
