// Editor payouts — compensation tracking. Phase A records manual payments
// ("mark paid"); Phase B will add the USDT-on-Solana send.
//   GET                                → the signed-in editor's own earnings / quota / rate / wallet
//   PATCH { solana_address }           → editor sets their OWN payout wallet address
//   GET  ?action=admin                 → owner/admin: every editor owed, across their brands
//   POST ?action=set-comp { email, monthly_amount, monthly_quota }  → owner/admin sets an editor's deal
//   POST ?action=pay { email, note? }  → owner/admin records a payout for the editor's unpaid videos
import { setCors, requireUser, supaFetch, fmtErr } from './_lib/supabase.js'

const perVideoRate = (comp) => {
  const amt = Number(comp?.monthly_amount || 0)
  const q = Number(comp?.monthly_quota || 0)
  return q > 0 ? amt / q : 0
}
const monthKey = (d) => { const dt = new Date(d); return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}` }
const monthsSince = (started) => {
  const s = new Date(started); const now = new Date()
  return (now.getUTCFullYear() - s.getUTCFullYear()) * 12 + (now.getUTCMonth() - s.getUTCMonth()) + 1
}

async function manageableBrandIds(userId) {
  const rows = await supaFetch(`profile_access?user_id=eq.${userId}&select=profile_id,role`)
  return (rows || []).filter((r) => ['owner', 'admin'].includes(r.role)).map((r) => r.profile_id)
}

// Derive an editor's numbers from their approved cards + comp + payouts.
function summarize(comp, cards, payouts) {
  const rate = perVideoRate(comp)
  const approved = (cards || []).filter((c) => c.approved_at)
  const total = approved.length
  const nowKey = monthKey(new Date())
  const thisMonth = approved.filter((c) => monthKey(c.approved_at) === nowKey).length
  const unpaid = approved.filter((c) => !c.payout_id).length
  const quota = Number(comp?.monthly_quota || 0)
  const expected = comp ? monthsSince(comp.started_on) * quota : 0
  const owedVideos = Math.max(0, expected - total) // rollover: behind by this many videos
  const paid = (payouts || []).reduce((s, p) => s + Number(p.amount_usdt || 0), 0)
  return {
    rate, monthly_amount: Number(comp?.monthly_amount || 0), monthly_quota: quota,
    started_on: comp?.started_on || null, solana_address: comp?.solana_address || null,
    total_approved: total, this_month: thisMonth, owed_videos: owedVideos,
    unpaid_count: unpaid, earned: total * rate, paid, outstanding: unpaid * rate,
  }
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const auth = await requireUser(req, res)
  if (!auth) return
  const email = String(auth.user?.email || '').trim().toLowerCase()

  try {
    const action = String(req.query.action || '')

    // ── admin: every editor owed, across the requester's brands ──
    if (req.method === 'GET' && action === 'admin') {
      const brandIds = await manageableBrandIds(auth.user.id)
      if (!brandIds.length) return res.status(200).json({ editors: [] })
      const [cards, comps, payouts] = await Promise.all([
        supaFetch(`board_cards?profile_id=in.(${brandIds.join(',')})&approved_at=not.is.null&select=assigned_editor_email,assigned_editor_name,approved_at,payout_id`),
        supaFetch('editor_comp?select=*'),
        supaFetch('editor_payouts?select=editor_email,amount_usdt'),
      ])
      const compByEmail = new Map((comps || []).map((c) => [c.email, c]))
      const paidByEmail = new Map()
      for (const p of (payouts || [])) paidByEmail.set(p.editor_email, (paidByEmail.get(p.editor_email) || 0) + Number(p.amount_usdt || 0))
      const byEmail = new Map()
      for (const c of (cards || [])) {
        if (!c.assigned_editor_email) continue
        if (!byEmail.has(c.assigned_editor_email)) byEmail.set(c.assigned_editor_email, [])
        byEmail.get(c.assigned_editor_email).push(c)
      }
      for (const c of (comps || [])) if (!byEmail.has(c.email)) byEmail.set(c.email, [])
      const editors = [...byEmail.entries()].map(([em, cs]) => {
        const s = summarize(compByEmail.get(em), cs, [])
        const name = cs.find((c) => c.assigned_editor_name)?.assigned_editor_name || null
        return { email: em, name, rate: s.rate, monthly_amount: s.monthly_amount, monthly_quota: s.monthly_quota, solana_address: s.solana_address, unpaid_count: s.unpaid_count, outstanding: s.outstanding, total_approved: s.total_approved, this_month: s.this_month, paid: paidByEmail.get(em) || 0 }
      }).sort((a, b) => b.outstanding - a.outstanding)
      return res.status(200).json({ editors })
    }

    // ── editor: their own numbers ──
    if (req.method === 'GET') {
      if (!email) return res.status(200).json({ summary: null, payouts: [] })
      const [comps, cards, payouts] = await Promise.all([
        supaFetch(`editor_comp?email=eq.${encodeURIComponent(email)}&select=*`),
        supaFetch(`board_cards?assigned_editor_email=eq.${encodeURIComponent(email)}&approved_at=not.is.null&select=approved_at,payout_id`),
        supaFetch(`editor_payouts?editor_email=eq.${encodeURIComponent(email)}&order=created_at.desc&select=amount_usdt,video_count,status,created_at,tx_signature,note`),
      ])
      return res.status(200).json({ summary: summarize(comps?.[0] || null, cards || [], payouts || []), payouts: payouts || [] })
    }

    // ── editor: set my own wallet address ──
    if (req.method === 'PATCH') {
      if (!email) return res.status(400).json({ error: 'No email on account' })
      const addr = (req.body?.solana_address || '').trim() || null
      await supaFetch('editor_comp', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: { email, solana_address: addr, updated_at: new Date().toISOString() },
      })
      return res.status(200).json({ ok: true })
    }

    // ── admin: set an editor's deal ──
    if (req.method === 'POST' && action === 'set-comp') {
      const brandIds = await manageableBrandIds(auth.user.id)
      if (!brandIds.length) return res.status(403).json({ error: 'Forbidden' })
      const em = String(req.body?.email || '').trim().toLowerCase()
      if (!em) return res.status(400).json({ error: 'email required' })
      const monthly_amount = Number(req.body?.monthly_amount)
      const monthly_quota = Math.trunc(Number(req.body?.monthly_quota))
      if (!Number.isFinite(monthly_amount) || monthly_amount < 0) return res.status(400).json({ error: 'invalid monthly_amount' })
      if (!Number.isFinite(monthly_quota) || monthly_quota < 0) return res.status(400).json({ error: 'invalid monthly_quota' })
      await supaFetch('editor_comp', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: { email: em, monthly_amount, monthly_quota, updated_by: auth.user.id, updated_at: new Date().toISOString() },
      })
      return res.status(200).json({ ok: true })
    }

    // ── admin: record a payout for an editor's unpaid approved videos (Phase A: mark paid) ──
    if (req.method === 'POST' && action === 'pay') {
      const brandIds = await manageableBrandIds(auth.user.id)
      if (!brandIds.length) return res.status(403).json({ error: 'Forbidden' })
      const em = String(req.body?.email || '').trim().toLowerCase()
      if (!em) return res.status(400).json({ error: 'email required' })
      const [comps, cards] = await Promise.all([
        supaFetch(`editor_comp?email=eq.${encodeURIComponent(em)}&select=*`),
        supaFetch(`board_cards?profile_id=in.(${brandIds.join(',')})&assigned_editor_email=eq.${encodeURIComponent(em)}&approved_at=not.is.null&payout_id=is.null&select=id`),
      ])
      const rate = perVideoRate(comps?.[0] || null)
      const ids = (cards || []).map((c) => c.id)
      if (!ids.length) return res.status(400).json({ error: 'Nothing owed to this editor.', code: 'nothing_owed' })
      const created = await supaFetch('editor_payouts', {
        method: 'POST',
        body: { editor_email: em, amount_usdt: ids.length * rate, video_count: ids.length, status: 'sent', note: String(req.body?.note || 'manual').slice(0, 200), created_by: auth.user.id },
      })
      const payout = Array.isArray(created) ? created[0] : created
      await supaFetch(`board_cards?id=in.(${ids.join(',')})`, { method: 'PATCH', body: { payout_id: payout.id }, prefer: 'return=minimal' })
      return res.status(200).json({ ok: true, video_count: ids.length, amount: ids.length * rate, payout_id: payout.id })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: fmtErr(err) })
  }
}
