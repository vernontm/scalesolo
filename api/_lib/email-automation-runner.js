// Automation runner: walks contacts through a linear drip sequence.
//
// Called every minute from api/cron/email-automations.js. One tick does two
// passes per active automation:
//
//   1. enrol   contacts carrying the trigger tag that have no enrollment row
//   2. send    enrollments whose next step is due
//
// Nothing here writes to email_sends. Every send goes through
// sendCampaignToContact, which claims the row before calling SES, so a drip
// step inherits the same post-once guarantee as a broadcast: the UNIQUE index
// on (campaign_id, contact_id) is what makes a second tick a no-op instead of
// a second email. That matters more here than for broadcasts, because this
// runs unattended every minute.
//
// A failed send is never retried, the same rule the campaign worker follows.
// The contact advances to the next step instead, so one bad address does not
// park someone in a sequence forever.

import { supaFetch } from './supabase.js'
import { resolveSender } from './email-render.js'
import { sendCampaignToContact } from './email-send-worker.js'

const enc = encodeURIComponent
const PAGE = 500
const DUE_PAGE = 100
const SEND_RATE = Math.max(1, Number(process.env.SES_SEND_RATE) || 8)
const HOUR_MS = 60 * 60 * 1000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Migration 0082 is applied by hand, so between deploying this and applying
// it the tables are simply absent. That has to read as "no automations"
// rather than as a failure, or the cron logs a 500 every minute and the
// Automations tab shows a stack trace instead of an explanation.
export function isMissingTable(e) {
  const code = e?.data?.code || ''
  if (code === '42P01' || code === 'PGRST205') return true
  return /relation .* does not exist|schema cache/i.test(String(e?.message || ''))
}
const inList = (vals) => `in.(${vals.map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')})`

// PostgREST containment: the contact's tags array holds this one tag.
export const tagClause = (tag) => `tags=cs.${enc(JSON.stringify([String(tag)]))}`

export const dueAt = (delayHours, from = Date.now()) =>
  new Date(from + Math.max(0, Number(delayHours) || 0) * HOUR_MS).toISOString()

// Where a contact goes after finishing `stepId`. Steps are matched by id
// rather than by position arithmetic, because positions are display order
// and are not unique, and because a step can be deleted mid-sequence.
export function advanceFrom(steps, stepId, now = Date.now()) {
  const i = steps.findIndex((s) => s.id === stepId)
  const next = i === -1 ? null : steps[i + 1]
  if (!next) return { status: 'done', next_step_id: null, next_run_at: null }
  return { status: 'active', next_step_id: next.id, next_run_at: dueAt(next.delay_hours, now) }
}

export async function listSteps(automationId) {
  const rows = await supaFetch(
    `email_automation_steps?automation_id=eq.${enc(automationId)}&select=id,position,delay_hours,campaign_id&order=position.asc,created_at.asc`,
  )
  return rows || []
}

// Contacts on the list that this automation has never seen. Returns the rows
// to insert, so the caller decides whether they land as 'active' (backfill)
// or 'skipped' (the "from now on" default).
export async function findUnseen(automation, { limit = PAGE } = {}) {
  const found = []
  for (let offset = 0; offset < 20000; offset += limit) {
    const contacts = await supaFetch(
      `email_contacts?profile_id=eq.${enc(automation.profile_id)}&status=eq.active&${tagClause(automation.trigger_tag)}` +
      `&select=id&order=created_at.asc,id.asc&limit=${limit}&offset=${offset}`,
    )
    if (!contacts?.length) break
    const ids = contacts.map((c) => c.id)
    const seen = await supaFetch(
      `email_automation_enrollments?automation_id=eq.${enc(automation.id)}&contact_id=${inList(ids)}&select=contact_id`,
    )
    const have = new Set((seen || []).map((r) => r.contact_id))
    for (const id of ids) if (!have.has(id)) found.push(id)
    if (contacts.length < limit) break
  }
  return found
}

// Insert enrollment rows for contacts this automation has not seen.
// `as` is 'active' to start them on step 1, or 'skipped' to record that they
// were already on the list when the automation was switched on.
export async function enroll(automation, steps, contactIds, as = 'active') {
  if (!contactIds.length) return 0
  const first = steps[0]
  const now = Date.now()
  const rows = contactIds.map((contact_id) => ({
    automation_id: automation.id,
    profile_id: automation.profile_id,
    contact_id,
    status: as,
    next_step_id: as === 'active' && first ? first.id : null,
    next_run_at: as === 'active' && first ? dueAt(first.delay_hours, now) : null,
    stopped_reason: as === 'skipped' ? 'already on this list when the automation was switched on' : null,
  }))
  // Chunked, and duplicates ignored, so a tick that overlaps the previous one
  // cannot enrol anybody twice.
  for (let i = 0; i < rows.length; i += 200) {
    await supaFetch('email_automation_enrollments?on_conflict=automation_id,contact_id', {
      method: 'POST',
      body: rows.slice(i, i + 200),
      prefer: 'resolution=ignore-duplicates,return=minimal',
    })
  }
  return rows.length
}

async function patchEnrollment(id, fields) {
  return supaFetch(`email_automation_enrollments?id=eq.${enc(id)}`, {
    method: 'PATCH', body: { ...fields, updated_at: new Date().toISOString() }, prefer: 'return=minimal',
  })
}

async function stop(enrollment, reason) {
  await patchEnrollment(enrollment.id, { status: 'cancelled', next_step_id: null, next_run_at: null, stopped_reason: reason })
}

/**
 * One tick. Walks every active automation, enrolling new arrivals and sending
 * whatever is due, until the budget runs out.
 */
export async function runAutomations({ budgetMs = 45000 } = {}) {
  const started = Date.now()
  const deadline = started + budgetMs
  const totals = { automations: 0, enrolled: 0, sent: 0, skipped: 0, failed: 0, stopped: null }

  let automations
  try {
    automations = await supaFetch('email_automations?status=eq.active&select=*&order=created_at.asc')
  } catch (e) {
    if (isMissingTable(e)) { totals.stopped = 'not-installed'; return totals }
    throw e
  }
  if (!automations?.length) return totals

  const senders = new Map()
  const campaigns = new Map()

  for (const automation of automations) {
    if (Date.now() > deadline) { totals.stopped = 'budget'; break }
    totals.automations++

    const steps = await listSteps(automation.id)
    if (!steps.length) continue

    // New arrivals first, so someone who signed up a minute ago with a
    // zero-hour first step gets their welcome on this same tick.
    try {
      const unseen = await findUnseen(automation)
      totals.enrolled += await enroll(automation, steps, unseen, 'active')
    } catch (e) {
      console.warn('[automations] enrol failed', automation.id, e?.message)
    }

    const due = await supaFetch(
      `email_automation_enrollments?automation_id=eq.${enc(automation.id)}&status=eq.active` +
      `&next_run_at=lte.${enc(new Date().toISOString())}&select=id,contact_id,next_step_id` +
      `&order=next_run_at.asc&limit=${DUE_PAGE}`,
    )
    if (!due?.length) continue

    if (!senders.has(automation.profile_id)) senders.set(automation.profile_id, await resolveSender(automation.profile_id))
    const sender = senders.get(automation.profile_id)
    if (!sender.ok) {
      // Pause rather than fail every contact one at a time: the problem is
      // the brand's sender setup, not these particular people.
      await supaFetch(`email_automations?id=eq.${enc(automation.id)}`, {
        method: 'PATCH', body: { status: 'paused', last_error: sender.reason, updated_at: new Date().toISOString() }, prefer: 'return=minimal',
      })
      continue
    }
    const { profile, config } = sender

    for (const e of due) {
      if (Date.now() > deadline) { totals.stopped = 'budget'; break }

      const step = steps.find((s) => s.id === e.next_step_id)
      if (!step) {
        // The step was deleted while this contact was waiting on it. There is
        // nothing to send and no sensible place to resume, so finish them.
        await patchEnrollment(e.id, { status: 'done', next_step_id: null, next_run_at: null, stopped_reason: 'the step they were waiting for was deleted' })
        continue
      }

      const contacts = await supaFetch(`email_contacts?id=eq.${enc(e.contact_id)}&select=id,email,name,tags,status`)
      const contact = contacts?.[0]
      if (!contact) { await stop(e, 'contact deleted'); continue }
      if (contact.status !== 'active') { await stop(e, `contact is ${contact.status}`); continue }

      // Taking the tag off is how you remove someone from a sequence.
      if (!Array.isArray(contact.tags) || !contact.tags.includes(automation.trigger_tag)) {
        await stop(e, `no longer tagged ${automation.trigger_tag}`)
        continue
      }

      const suppressed = await supaFetch(
        `email_suppressions?email=eq.${enc(String(contact.email || '').toLowerCase())}` +
        `&or=(profile_id.is.null,profile_id.eq.${enc(automation.profile_id)})&select=email&limit=1`,
      )
      if (suppressed?.length) { await stop(e, 'suppressed (unsubscribed, bounced or complained)'); continue }

      if (!campaigns.has(step.campaign_id)) {
        const rows = await supaFetch(`email_campaigns?id=eq.${enc(step.campaign_id)}&select=*`)
        campaigns.set(step.campaign_id, rows?.[0] || null)
      }
      const campaign = campaigns.get(step.campaign_id)
      if (!campaign) { await stop(e, 'the step has no email attached'); continue }

      const r = await sendCampaignToContact({
        campaign,
        contact,
        sender,
        fromName: campaign.from_name || config.from_name || profile.business_name,
        fromEmail: config.from_email,
        replyTo: campaign.reply_to || config.reply_to_email || null,
      })

      if (r.outcome === 'throttled' || r.outcome === 'paused') {
        // Nothing was accepted and the claim is released, so leave this
        // enrollment due and let the next tick pick it up unchanged.
        totals.stopped = r.outcome
        break
      }

      if (r.outcome === 'sent') totals.sent++
      else if (r.outcome === 'failed') totals.failed++
      else totals.skipped++

      // Advance on anything that is not a provider stall, including a failure.
      // Retrying is what double-sends, and a single bad address must not hold
      // the rest of the sequence hostage.
      await patchEnrollment(e.id, advanceFrom(steps, step.id))
      await supaFetch(`email_contacts?id=eq.${enc(contact.id)}`, {
        method: 'PATCH', body: { last_drip_at: new Date().toISOString() }, prefer: 'return=minimal',
      }).catch(() => {})

      if (r.outcome === 'sent') await sleep(Math.ceil(1000 / SEND_RATE))
    }
    if (totals.stopped) break
  }

  return totals
}
