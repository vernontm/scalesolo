// Campaign send worker. Called inline from "Send now" and every minute from
// api/cron/email-send.js until the campaign has no recipients left.
//
// The one rule that matters here is post-once: a contact must never get the
// same campaign twice. So the worker writes the email_sends row (status
// queued) BEFORE it calls SES, and the unique index on (campaign_id,
// contact_id) makes a second worker's insert fail instead of double-sending.
// A send that SES refuses is recorded as failed and never retried; only a
// throttle, where SES accepted nothing, releases the row for the next tick.

import { supaFetch } from './supabase.js'
import { sendEmail, classifySendError, configurationSetFor } from './email-provider.js'
import { resolveSender, renderCampaignEmail, mergeVarsFor, mergeTags, htmlToText, listUnsubscribeHeaders } from './email-render.js'

const PAGE = 100
const SEND_RATE = Math.max(1, Number(process.env.SES_SEND_RATE) || 8)   // messages per second
const STALE_QUEUED_MIN = 10
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const enc = encodeURIComponent
const inList = (vals) => `in.(${vals.map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')})`

// PostgREST filter for "contact has any of these tags". No tags = everyone.
export function tagFilterClause(tagFilter) {
  const tags = (Array.isArray(tagFilter) ? tagFilter : []).map((t) => String(t).trim()).filter(Boolean)
  if (!tags.length) return ''
  return `&or=(${tags.map((t) => `tags.cs.${enc(JSON.stringify([t]))}`).join(',')})`
}

// Supabase caps a single select at 1000 rows, so count in pages.
export async function countRecipients(profileId, tagFilter) {
  const base = `email_contacts?profile_id=eq.${enc(profileId)}&status=eq.active${tagFilterClause(tagFilter)}&select=id`
  let total = 0
  for (let offset = 0; offset < 200000; offset += 1000) {
    const rows = await supaFetch(`${base}&limit=1000&offset=${offset}`)
    const n = Array.isArray(rows) ? rows.length : 0
    total += n
    if (n < 1000) break
  }
  return total
}

async function bump(campaignId, col, n = 1) {
  await supaFetch('rpc/bump_email_campaign_counter', { method: 'POST', body: { p_campaign: campaignId, p_col: col, p_n: n }, prefer: 'return=minimal' })
    .catch((e) => console.warn('[email-worker] bump failed', col, e?.message))
}

async function patchCampaign(id, fields) {
  return supaFetch(`email_campaigns?id=eq.${enc(id)}`, { method: 'PATCH', body: { ...fields, updated_at: new Date().toISOString() } })
}

async function patchSend(id, fields) {
  return supaFetch(`email_sends?id=eq.${enc(id)}`, { method: 'PATCH', body: { ...fields, updated_at: new Date().toISOString() }, prefer: 'return=minimal' })
}

// Rows stuck in queued (worker died between insert and send) count as
// failed: we cannot know whether SES got the message, and guessing "no"
// risks a double send.
async function sweepStaleQueued(campaignId) {
  const cutoff = new Date(Date.now() - STALE_QUEUED_MIN * 60 * 1000).toISOString()
  const stale = await supaFetch(
    `email_sends?campaign_id=eq.${enc(campaignId)}&status=eq.queued&created_at=lt.${enc(cutoff)}&select=id`,
    { method: 'PATCH', body: { status: 'failed', error: 'worker timed out before SES confirmed the send', updated_at: new Date().toISOString() } },
  ).catch(() => [])
  if (Array.isArray(stale) && stale.length) await bump(campaignId, 'failed_count', stale.length)
}

/**
 * Send one campaign email to one contact, once.
 *
 * This is the only place anything writes a send row, and that is deliberate:
 * post-once lives here and nowhere else. The row is claimed (status queued)
 * BEFORE SES is called, and the UNIQUE index on (campaign_id, contact_id)
 * turns a second caller's claim into a 409 rather than a duplicate email.
 * The campaign worker calls this in a loop over a tag filter; the automation
 * runner calls it for one contact at a time. Both inherit the same guarantee.
 *
 * Counters on the campaign row are bumped here too, so a drip step's stats
 * add up the same way a broadcast's do.
 *
 * `suppressed` is passed in rather than looked up, because the worker already
 * checks a whole page of addresses against email_suppressions in one query.
 *
 * @returns {{ outcome: 'sent'|'skipped'|'failed'|'throttled'|'paused', messageId?: string, error?: string, kind?: string }}
 *   skipped   nothing was sent and nothing is owed: a bad address, a
 *             suppressed address, or a recipient already claimed
 *   throttled nothing was accepted and the claim was released; retry later
 *   paused    the provider is refusing everything; stop the run
 */
export async function sendCampaignToContact({ campaign, contact, sender, fromName, fromEmail, replyTo, suppressed = false }) {
  const { profile, config } = sender
  const email = String(contact.email || '').trim().toLowerCase()
  const base = { campaign_id: campaign.id, profile_id: campaign.profile_id, contact_id: contact.id, email }

  if (!email || !EMAIL_RE.test(email) || suppressed) {
    const reason = suppressed ? 'suppressed (unsubscribed, bounced or complained)' : 'invalid address'
    await supaFetch('email_sends', { method: 'POST', body: { ...base, status: 'failed', error: reason }, prefer: 'return=minimal' }).catch(() => {})
    await bump(campaign.id, 'failed_count')
    return { outcome: 'skipped', error: reason }
  }

  // Claim the recipient. 409 means this contact already has this email.
  let claimed
  try {
    claimed = await supaFetch('email_sends', { method: 'POST', body: { ...base, status: 'queued' } })
  } catch (e) {
    if (e?.status === 409) return { outcome: 'skipped', error: 'already sent' }
    throw e
  }
  const sendRow = Array.isArray(claimed) ? claimed[0] : claimed

  const vars = mergeVarsFor({ contact, profile, campaignId: campaign.id })
  const html = renderCampaignEmail({
    subject: campaign.subject, previewText: campaign.preview_text, body: campaign.html_body,
    fromName, profile, config, vars,
  })
  const subject = mergeTags(campaign.subject, vars)

  try {
    const messageId = await sendEmail({
      from: fromEmail, fromName, to: email, replyTo, subject, html, text: htmlToText(html),
      headers: listUnsubscribeHeaders(vars.unsubscribe_url),
      tags: { campaign_id: campaign.id, profile_id: campaign.profile_id },
      configurationSet: configurationSetFor(sender.provider),
    }, sender.provider)
    await patchSend(sendRow.id, { status: 'sent', ses_message_id: messageId, sent_at: new Date().toISOString() })
    await bump(campaign.id, 'sent_count')
    return { outcome: 'sent', messageId }
  } catch (e) {
    const kind = classifySendError(e, sender.provider)
    const error = String(e?.message || e)
    if (kind === 'throttled' || kind === 'paused') {
      await supaFetch(`email_sends?id=eq.${enc(sendRow.id)}`, { method: 'DELETE', prefer: 'return=minimal' }).catch(() => {})
      return { outcome: kind, kind, error }
    }
    await patchSend(sendRow.id, { status: 'failed', error: error.slice(0, 500) })
    await bump(campaign.id, 'failed_count')
    return { outcome: 'failed', kind, error }
  }
}

// Process one campaign for up to budgetMs. Returns { done, sent, failed, skipped, stopped }.
export async function processCampaign(campaignId, { budgetMs = 45000 } = {}) {
  const started = Date.now()
  const stats = { done: false, sent: 0, failed: 0, skipped: 0, stopped: null }

  const rows = await supaFetch(`email_campaigns?id=eq.${enc(campaignId)}&select=*`)
  const campaign = rows?.[0]
  if (!campaign || campaign.status !== 'sending') { stats.stopped = 'not-sending'; return stats }

  const sender = await resolveSender(campaign.profile_id)
  if (!sender.ok) {
    await patchCampaign(campaign.id, { status: 'failed', last_error: sender.reason })
    stats.stopped = 'sender'
    return stats
  }
  const { profile, config } = sender
  const fromEmail = campaign.from_email || config.from_email
  const fromName = campaign.from_name || config.from_name || profile.business_name
  const replyTo = campaign.reply_to || config.reply_to_email || null

  await sweepStaleQueued(campaign.id)

  const where = `email_contacts?profile_id=eq.${enc(campaign.profile_id)}&status=eq.active${tagFilterClause(campaign.tag_filter)}`
  let offset = 0
  let walkedAll = false

  while (true) {
    if (Date.now() - started > budgetMs) { stats.stopped = 'budget'; break }
    const contacts = await supaFetch(`${where}&select=id,email,name,tags&order=created_at.asc,id.asc&limit=${PAGE}&offset=${offset}`)
    if (!contacts?.length) { walkedAll = true; break }
    offset += contacts.length

    const ids = contacts.map((c) => c.id)
    const emails = contacts.map((c) => String(c.email || '').toLowerCase())
    const [already, suppressed] = await Promise.all([
      supaFetch(`email_sends?campaign_id=eq.${enc(campaign.id)}&contact_id=${inList(ids)}&select=contact_id`),
      supaFetch(`email_suppressions?email=${inList(emails)}&or=(profile_id.is.null,profile_id.eq.${enc(campaign.profile_id)})&select=email`),
    ])
    const doneIds = new Set((already || []).map((r) => r.contact_id))
    const suppressedEmails = new Set((suppressed || []).map((r) => String(r.email).toLowerCase()))

    for (const contact of contacts) {
      if (doneIds.has(contact.id)) continue
      if (Date.now() - started > budgetMs) { stats.stopped = 'budget'; break }

      // Re-check status so a cancel mid-send stops within one page.
      if (stats.sent + stats.failed > 0 && (stats.sent + stats.failed) % 50 === 0) {
        const fresh = await supaFetch(`email_campaigns?id=eq.${enc(campaign.id)}&select=status`)
        if (fresh?.[0]?.status !== 'sending') { stats.stopped = 'cancelled'; break }
      }

      const r = await sendCampaignToContact({
        campaign, contact, sender, fromName, fromEmail, replyTo,
        suppressed: suppressedEmails.has(String(contact.email || '').trim().toLowerCase()),
      })

      // An unusable address and a recipient another worker already claimed
      // both cost nothing, so neither spends a slot in the rate limit.
      if (r.outcome === 'skipped') { stats.skipped++; continue }

      if (r.outcome === 'throttled' || r.outcome === 'paused') {
        // Nothing was accepted, and the claim has been released, so the next
        // tick resumes from the same recipient.
        if (r.outcome === 'paused') await patchCampaign(campaign.id, { last_error: `${sender.provider} sending is paused: ${r.error}` })
        stats.stopped = r.outcome
        break
      }

      if (r.outcome === 'sent') stats.sent++
      else {
        stats.failed++
        if (r.kind === 'unverified') {
          // Sandbox account: every unverified recipient will fail the same
          // way. Surface it once instead of burning through the list.
          await patchCampaign(campaign.id, { last_error: 'SES is still in sandbox mode: only verified recipient addresses can receive mail until AWS grants production access.' })
        }
      }
      await sleep(Math.ceil(1000 / SEND_RATE))
    }
    if (stats.stopped) break
  }

  if (walkedAll && !stats.stopped) {
    const fresh = await supaFetch(`email_campaigns?id=eq.${enc(campaign.id)}&select=failed_count,sent_count,status`)
    const row = fresh?.[0] || {}
    if (row.status === 'sending') {
      const status = (row.failed_count || 0) > 0 ? 'partial' : 'sent'
      await patchCampaign(campaign.id, { status, sent_at: new Date().toISOString() })
    }
    stats.done = true
  }
  return stats
}
