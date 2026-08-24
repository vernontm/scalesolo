// Editor payouts — compensation tracking + the USDT-on-Solana send (Phase B).
//   GET                                → the signed-in editor's own earnings / quota / rate / wallet
//   PATCH { solana_address }           → editor sets their OWN payout wallet address
//   GET  ?action=admin                 → owner/admin: every editor owed, across their brands
//   POST ?action=set-comp { email, monthly_amount?, monthly_quota?, solana_address? }  → owner/admin sets an editor's deal / wallet
//   POST ?action=pay { email, dry_run|confirm, manual?, note? }  → preview or release an editor's unpaid videos
//   POST ?action=test-send { to, amount, dry_run|confirm }       → smoke-test the rail with a small amount
//   POST ?action=void-payout { payout_id }                       → release a failed/pending (never-sent) payout's cards
//
// Money-OUT safety: a real send happens ONLY on `confirm: true` (dry_run is the
// default). Cards are reserved before the send and released again only on a
// clean PRE-broadcast failure; an ambiguous failure holds the cards so a retry
// can't double-pay. Nothing auto-fires — an owner/admin clicks release.
import { setCors, requireUser, supaFetch, fmtErr } from './_lib/supabase.js'
import { preflight, sendUsdt, validateAddress, explorerTxUrl } from './_lib/solana.js'

export const config = { maxDuration: 60 }

// Error codes from solana.js that are raised BEFORE anything is broadcast — safe
// to release a reservation and let the admin retry. Anything else is treated as
// ambiguous (the tx may have landed) and holds the cards.
const PRE_BROADCAST_CODES = new Set(['bad_recipient', 'insufficient_usdt', 'no_wallet_key', 'bad_wallet_key', 'zero_amount'])

const perVideoRate = (comp) => {
  const amt = Number(comp?.monthly_amount || 0)
  const q = Number(comp?.monthly_quota || 0)
  return q > 0 ? amt / q : 0
}
const round6 = (n) => Number(Number(n).toFixed(6))
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

const releaseCards = (ids) => ids.length
  ? supaFetch(`board_cards?id=in.(${ids.join(',')})`, { method: 'PATCH', body: { payout_id: null }, prefer: 'return=minimal' })
  : Promise.resolve()

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
      if (addr) {
        const v = validateAddress(addr)
        if (!v.ok) return res.status(400).json({ error: v.reason })
      }
      await supaFetch('editor_comp', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: { email, solana_address: addr, updated_at: new Date().toISOString() },
      })
      return res.status(200).json({ ok: true })
    }

    // ── admin: set an editor's deal and/or wallet ──
    if (req.method === 'POST' && action === 'set-comp') {
      const brandIds = await manageableBrandIds(auth.user.id)
      if (!brandIds.length) return res.status(403).json({ error: 'Forbidden' })
      const em = String(req.body?.email || '').trim().toLowerCase()
      if (!em) return res.status(400).json({ error: 'email required' })
      const patch = { email: em, updated_by: auth.user.id, updated_at: new Date().toISOString() }
      if ('monthly_amount' in (req.body || {})) {
        const monthly_amount = Number(req.body.monthly_amount)
        if (!Number.isFinite(monthly_amount) || monthly_amount < 0) return res.status(400).json({ error: 'invalid monthly_amount' })
        patch.monthly_amount = monthly_amount
      }
      if ('monthly_quota' in (req.body || {})) {
        const monthly_quota = Math.trunc(Number(req.body.monthly_quota))
        if (!Number.isFinite(monthly_quota) || monthly_quota < 0) return res.status(400).json({ error: 'invalid monthly_quota' })
        patch.monthly_quota = monthly_quota
      }
      if ('solana_address' in (req.body || {})) {
        const addr = String(req.body.solana_address || '').trim() || null
        if (addr) {
          const v = validateAddress(addr)
          if (!v.ok) return res.status(400).json({ error: v.reason })
        }
        patch.solana_address = addr
      }
      await supaFetch('editor_comp', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: patch,
      })
      return res.status(200).json({ ok: true })
    }

    // ── admin: release (or preview, or manually record) an editor's payout ──
    if (req.method === 'POST' && action === 'pay') {
      const brandIds = await manageableBrandIds(auth.user.id)
      if (!brandIds.length) return res.status(403).json({ error: 'Forbidden' })
      const em = String(req.body?.email || '').trim().toLowerCase()
      if (!em) return res.status(400).json({ error: 'email required' })
      const confirm = req.body?.confirm === true
      const manual = req.body?.manual === true

      const [comps, cards] = await Promise.all([
        supaFetch(`editor_comp?email=eq.${encodeURIComponent(em)}&select=*`),
        supaFetch(`board_cards?profile_id=in.(${brandIds.join(',')})&assigned_editor_email=eq.${encodeURIComponent(em)}&approved_at=not.is.null&payout_id=is.null&select=id`),
      ])
      const comp = comps?.[0] || null
      const rate = perVideoRate(comp)
      const ids = (cards || []).map((c) => c.id)
      if (!ids.length) return res.status(400).json({ error: 'Nothing owed to this editor.', code: 'nothing_owed' })
      const amount = round6(ids.length * rate)
      const wallet = comp?.solana_address || null

      // Manual record (paid off-platform) — no on-chain send.
      if (manual) {
        const created = await supaFetch('editor_payouts', {
          method: 'POST',
          body: { editor_email: em, amount_usdt: amount, video_count: ids.length, status: 'sent', note: String(req.body?.note || 'manual').slice(0, 200), created_by: auth.user.id },
        })
        const payout = Array.isArray(created) ? created[0] : created
        await supaFetch(`board_cards?id=in.(${ids.join(',')})`, { method: 'PATCH', body: { payout_id: payout.id }, prefer: 'return=minimal' })
        return res.status(200).json({ ok: true, manual: true, video_count: ids.length, amount, payout_id: payout.id })
      }

      // USDT send path needs a saved wallet.
      if (!wallet) return res.status(400).json({ error: 'This editor has no payout wallet saved.', code: 'no_wallet' })

      // Dry-run (default): read-only preview, no writes, no send.
      if (!confirm) {
        const pf = await preflight(wallet, amount)
        return res.status(200).json({ dry_run: true, editor_email: em, wallet, rate: round6(rate), video_count: ids.length, amount, preflight: pf })
      }

      // Real release — block if the wallet can't cover it.
      const pf = await preflight(wallet, amount)
      if (!pf.ok) return res.status(400).json({ error: 'Payout wallet is not ready.', code: 'preflight_failed', issues: pf.issues })

      // Reserve the cards to a pending payout BEFORE sending, so a concurrent
      // retry finds nothing owed and can't double-pay.
      const pending = await supaFetch('editor_payouts', {
        method: 'POST',
        body: { editor_email: em, amount_usdt: amount, video_count: ids.length, status: 'pending', note: String(req.body?.note || 'usdt').slice(0, 200), created_by: auth.user.id },
      })
      const payout = Array.isArray(pending) ? pending[0] : pending
      const claimed = await supaFetch(`board_cards?id=in.(${ids.join(',')})&payout_id=is.null`, { method: 'PATCH', body: { payout_id: payout.id } })
      const claimedIds = (Array.isArray(claimed) ? claimed : []).map((c) => c.id)

      try {
        const sent = await sendUsdt(wallet, amount)
        await supaFetch(`editor_payouts?id=eq.${payout.id}`, { method: 'PATCH', body: { status: 'sent', tx_signature: sent.signature }, prefer: 'return=minimal' })
        return res.status(200).json({ ok: true, sent: true, tx_signature: sent.signature, explorer: explorerTxUrl(sent.signature), video_count: claimedIds.length, amount, payout_id: payout.id })
      } catch (sendErr) {
        const preBroadcast = sendErr && PRE_BROADCAST_CODES.has(sendErr.code)
        await supaFetch(`editor_payouts?id=eq.${payout.id}`, { method: 'PATCH', body: { status: 'failed', note: `failed: ${fmtErr(sendErr)}`.slice(0, 200) }, prefer: 'return=minimal' })
        if (preBroadcast) {
          // Nothing hit the chain — safe to release the cards for a clean retry.
          await releaseCards(claimedIds)
          return res.status(400).json({ error: fmtErr(sendErr), code: sendErr.code, released: true, payout_id: payout.id })
        }
        // Ambiguous — the tx may have landed. HOLD the cards; the admin verifies
        // on-chain and voids the payout only if nothing sent.
        return res.status(502).json({ error: `Send failed after broadcast: ${fmtErr(sendErr)}`, code: 'send_ambiguous', held: true, payout_id: payout.id, video_count: claimedIds.length })
      }
    }

    // ── admin: smoke-test the rail with a small arbitrary amount ──
    if (req.method === 'POST' && action === 'test-send') {
      const brandIds = await manageableBrandIds(auth.user.id)
      if (!brandIds.length) return res.status(403).json({ error: 'Forbidden' })
      const to = String(req.body?.to || '').trim()
      const amount = round6(req.body?.amount ?? 1)
      const confirm = req.body?.confirm === true
      const v = validateAddress(to)
      if (!v.ok) return res.status(400).json({ error: v.reason })
      if (!(amount > 0)) return res.status(400).json({ error: 'amount must be greater than zero' })

      if (!confirm) {
        const pf = await preflight(to, amount)
        return res.status(200).json({ dry_run: true, wallet: to, amount, preflight: pf })
      }
      const pf = await preflight(to, amount)
      if (!pf.ok) return res.status(400).json({ error: 'Payout wallet is not ready.', code: 'preflight_failed', issues: pf.issues })
      try {
        const sent = await sendUsdt(to, amount)
        await supaFetch('editor_payouts', {
          method: 'POST',
          body: { editor_email: String(req.body?.email || 'test-send').trim().toLowerCase(), amount_usdt: amount, video_count: 0, status: 'sent', tx_signature: sent.signature, note: 'test send', created_by: auth.user.id },
          prefer: 'return=minimal',
        })
        return res.status(200).json({ ok: true, sent: true, tx_signature: sent.signature, explorer: explorerTxUrl(sent.signature), amount })
      } catch (sendErr) {
        return res.status(502).json({ error: fmtErr(sendErr), code: sendErr.code || 'send_failed' })
      }
    }

    // ── admin: void a never-sent payout (releases its held cards) ──
    if (req.method === 'POST' && action === 'void-payout') {
      const brandIds = await manageableBrandIds(auth.user.id)
      if (!brandIds.length) return res.status(403).json({ error: 'Forbidden' })
      const payoutId = String(req.body?.payout_id || '').trim()
      if (!payoutId) return res.status(400).json({ error: 'payout_id required' })
      const rows = await supaFetch(`editor_payouts?id=eq.${encodeURIComponent(payoutId)}&select=id,tx_signature,status`)
      const row = rows?.[0]
      if (!row) return res.status(404).json({ error: 'Payout not found' })
      if (row.tx_signature) return res.status(400).json({ error: 'This payout has an on-chain signature and cannot be voided.', code: 'already_sent' })
      const held = await supaFetch(`board_cards?payout_id=eq.${payoutId}&select=id`)
      const heldIds = (held || []).map((c) => c.id)
      await releaseCards(heldIds)
      await supaFetch(`editor_payouts?id=eq.${payoutId}`, { method: 'PATCH', body: { status: 'failed', note: 'voided' }, prefer: 'return=minimal' })
      return res.status(200).json({ ok: true, released: heldIds.length })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: fmtErr(err) })
  }
}
