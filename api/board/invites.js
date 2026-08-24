// Editor management for the board. An owner/admin invites a video editor by
// email and toggles which brands that editor can access. Access = a
// profile_access row (role='contributor', allowed_pages=['board']) per brand;
// board_invites is the management record (email <-> brand <-> status). Editors
// log in passwordlessly via a magic link. One editor => one unified board
// showing their assigned cards across every brand they've been granted.
//
//   GET                                  -> editors across the requester's manageable brands
//   POST { email, profile_ids[] }        -> invite: grant/pending each brand + email a magic link
//   POST ?action=grant  { email, profile_id }
//   POST ?action=revoke { email, profile_id }
//   POST ?action=resend { email }        -> re-send the magic link
//   DELETE ?email=                       -> revoke the editor from all the requester's brands
import { setCors, requireUser, supaFetch, assertMinRole, fmtErr, isUuid } from '../_lib/supabase.js'
import { brandedEmail, ctaButton, sendEmail } from '../_lib/email.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const APP_URL = (process.env.APP_URL || 'https://www.scalesolo.ai').replace(/\/$/, '')
const ALLOWED_PAGES = ['board', 'payouts']

async function authAdmin(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const text = await r.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!r.ok) { const e = new Error(`auth admin ${r.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`); e.status = r.status; throw e }
  return body
}

// Scan the auth users for an exact email (GoTrue admin has no exact-email GET).
async function findUserByEmail(email) {
  for (let page = 1; page <= 5; page++) {
    const body = await authAdmin(`users?page=${page}&per_page=200`)
    const users = body?.users || []
    const hit = users.find((u) => (u.email || '').toLowerCase() === email)
    if (hit) return hit
    if (users.length < 200) break
  }
  return null
}

// Generate a passwordless login link (magiclink for existing users, invite for
// new ones — invite also creates the account). Returns the action_link.
async function loginLink(email, isNew) {
  const type = isNew ? 'invite' : 'magiclink'
  const body = await authAdmin('generate_link', {
    method: 'POST',
    body: JSON.stringify({ type, email, options: { redirect_to: `${APP_URL}/auth/callback` } }),
  })
  return body?.action_link || body?.properties?.action_link || null
}

async function sendInviteEmail(email, link, brandNames) {
  const brands = brandNames.filter(Boolean)
  const who = brands.length ? brands.join(', ') : 'a brand'
  const html = brandedEmail({
    preheader: `You've been added as an editor on ScaleSolo`,
    body: `<p style="margin:0 0 10px;font-size:17px;font-weight:700;color:#0c0c0d;">You're set up as an editor</p>
<p style="margin:0 0 4px;">You've been given editor access to the production board for <strong>${who}</strong> on ScaleSolo.</p>
<p style="margin:0 0 4px;">Click below to log in — no password needed. You'll land on your board with the videos assigned to you.</p>
${ctaButton({ label: 'Open your board', url: link })}
<p style="margin:12px 0 0;font-size:12px;color:#74747a;">This link signs you in directly. If you didn't expect this, you can ignore this email.</p>`,
  })
  await sendEmail({ to: email, subject: 'Your ScaleSolo editor access', html })
}

// The brands (profile_ids) the requester can manage editors for (owner/admin).
async function manageableBrandIds(userId) {
  const rows = await supaFetch(`profile_access?user_id=eq.${userId}&select=profile_id,role`)
  return (rows || []).filter((r) => ['owner', 'admin'].includes(r.role)).map((r) => r.profile_id)
}

// Grant one editor access to one brand: profile_access + board_invites record.
// `existingUser` is the full auth user object (or null). `name` is optional and
// only overwrites when provided (a toggle-on passes null so it won't wipe it).
async function grantBrand(email, profileId, invitedBy, existingUser, name) {
  const status = existingUser ? 'accepted' : 'pending'
  await supaFetch('board_invites', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: { email, profile_id: profileId, role: 'contributor', invited_by: invitedBy, status, ...(name ? { name } : {}), accepted_at: existingUser ? new Date().toISOString() : null },
  })
  if (existingUser) {
    // Grant access now (idempotent upsert on the PK (user_id, profile_id)).
    await supaFetch('profile_access', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: { user_id: existingUser.id, profile_id: profileId, role: 'contributor', allowed_pages: ALLOWED_PAGES },
    })
    // Set their display name if they don't have one yet.
    const hasName = existingUser.user_metadata?.full_name || existingUser.user_metadata?.name
    if (name && !hasName) {
      try { await authAdmin(`users/${existingUser.id}`, { method: 'PUT', body: JSON.stringify({ user_metadata: { ...(existingUser.user_metadata || {}), full_name: name } }) }) } catch { /* best-effort */ }
    }
  }
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const action = String(req.query.action || '')

    // ── GET ?action=brand_editors&profile_id= : that brand's editors (for the card assignee picker) ──
    if (req.method === 'GET' && action === 'brand_editors') {
      const profileId = req.query.profile_id
      if (!isUuid(profileId)) return res.status(400).json({ error: 'profile_id required' })
      await assertMinRole(auth.user.id, profileId, 'admin')
      const [rows, invRows] = await Promise.all([
        supaFetch(`profile_access?profile_id=eq.${profileId}&role=eq.contributor&select=user_id`),
        supaFetch(`board_invites?profile_id=eq.${profileId}&select=email,name`),
      ])
      const nameByEmail = new Map((invRows || []).filter((i) => i.name).map((i) => [i.email, i.name]))
      const editors = []
      for (const r of (rows || [])) {
        try {
          const u = await authAdmin(`users/${r.user_id}`)
          const em = u?.email || null
          const nm = u?.user_metadata?.full_name || u?.user_metadata?.name || (em ? nameByEmail.get(em) : null) || null
          editors.push({ user_id: r.user_id, email: em, name: nm })
        } catch { editors.push({ user_id: r.user_id, email: null, name: null }) }
      }
      return res.status(200).json({ editors })
    }

    // ── GET: editors across every brand the requester manages ──
    if (req.method === 'GET') {
      const brandIds = await manageableBrandIds(auth.user.id)
      if (!brandIds.length) return res.status(200).json({ editors: [], brands: [] })
      const [invites, brands] = await Promise.all([
        supaFetch(`board_invites?profile_id=in.(${brandIds.join(',')})&order=created_at.asc&select=email,name,profile_id,status`),
        supaFetch(`profiles?id=in.(${brandIds.join(',')})&select=id,business_name`),
      ])
      // Group by email → { email, name, brands: { [profile_id]: status } }
      const byEmail = new Map()
      for (const iv of (invites || [])) {
        if (iv.status === 'revoked') continue
        if (!byEmail.has(iv.email)) byEmail.set(iv.email, { email: iv.email, name: iv.name || null, brands: {} })
        const e = byEmail.get(iv.email)
        if (iv.name && !e.name) e.name = iv.name
        e.brands[iv.profile_id] = iv.status
      }
      return res.status(200).json({ editors: [...byEmail.values()], brands: brands || [] })
    }

    // ── POST ?action=resend ──
    if (req.method === 'POST' && action === 'resend') {
      const email = String(req.body?.email || '').trim().toLowerCase()
      if (!email) return res.status(400).json({ error: 'email required' })
      const brandIds = await manageableBrandIds(auth.user.id)
      const rows = await supaFetch(`board_invites?email=eq.${encodeURIComponent(email)}&profile_id=in.(${brandIds.join(',')})&status=neq.revoked&select=profile_id`)
      if (!rows?.length) return res.status(404).json({ error: 'No active invite for that editor' })
      const user = await findUserByEmail(email)
      const link = await loginLink(email, !user)
      if (!link) return res.status(502).json({ error: 'Could not generate a login link' })
      const brands = await supaFetch(`profiles?id=in.(${rows.map((r) => r.profile_id).join(',')})&select=business_name`)
      await sendInviteEmail(email, link, (brands || []).map((b) => b.business_name))
      return res.status(200).json({ ok: true })
    }

    // ── POST ?action=grant / revoke (single brand toggle) ──
    if (req.method === 'POST' && (action === 'grant' || action === 'revoke')) {
      const email = String(req.body?.email || '').trim().toLowerCase()
      const profileId = req.body?.profile_id
      if (!email || !isUuid(profileId)) return res.status(400).json({ error: 'email + profile_id required' })
      await assertMinRole(auth.user.id, profileId, 'admin')
      if (action === 'revoke') {
        await supaFetch(`board_invites?email=eq.${encodeURIComponent(email)}&profile_id=eq.${profileId}`, { method: 'PATCH', body: { status: 'revoked' }, prefer: 'return=minimal' })
        const user = await findUserByEmail(email)
        if (user) await supaFetch(`profile_access?user_id=eq.${user.id}&profile_id=eq.${profileId}&role=eq.contributor`, { method: 'DELETE', prefer: 'return=minimal' })
        return res.status(200).json({ ok: true })
      }
      const user = await findUserByEmail(email)
      await grantBrand(email, profileId, auth.user.id, user, null)
      return res.status(200).json({ ok: true, pending: !user })
    }

    // ── POST: invite (grant one or more brands + email a magic link) ──
    if (req.method === 'POST') {
      const email = String(req.body?.email || '').trim().toLowerCase()
      const name = (req.body?.name || '').trim() || null
      const profileIds = Array.isArray(req.body?.profile_ids) ? req.body.profile_ids.filter(isUuid) : []
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'A valid email is required' })
      if (!profileIds.length) return res.status(400).json({ error: 'Pick at least one brand to grant' })
      for (const pid of profileIds) await assertMinRole(auth.user.id, pid, 'admin')
      const user = await findUserByEmail(email)
      for (const pid of profileIds) await grantBrand(email, pid, auth.user.id, user, name)
      const link = await loginLink(email, !user)
      if (!link) return res.status(502).json({ error: 'Access granted, but the login link failed to generate. Use Resend.' })
      const brands = await supaFetch(`profiles?id=in.(${profileIds.join(',')})&select=business_name`)
      await sendInviteEmail(email, link, (brands || []).map((b) => b.business_name))
      return res.status(200).json({ ok: true, pending: !user })
    }

    // ── DELETE: remove the editor from all of the requester's brands ──
    if (req.method === 'DELETE') {
      const email = String(req.query.email || '').trim().toLowerCase()
      if (!email) return res.status(400).json({ error: 'email required' })
      const brandIds = await manageableBrandIds(auth.user.id)
      if (!brandIds.length) return res.status(403).json({ error: 'Forbidden' })
      await supaFetch(`board_invites?email=eq.${encodeURIComponent(email)}&profile_id=in.(${brandIds.join(',')})`, { method: 'PATCH', body: { status: 'revoked' }, prefer: 'return=minimal' })
      const user = await findUserByEmail(email)
      if (user) await supaFetch(`profile_access?user_id=eq.${user.id}&profile_id=in.(${brandIds.join(',')})&role=eq.contributor`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(200).json({ ok: true })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: fmtErr(err) })
  }
}
