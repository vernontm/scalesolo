// Email automations: linear drip sequences, one per brand per list.
//
// Routes:
//   GET    ?profile_id=<uuid>                      { automations: [...] }
//   GET    ?id=<uuid>                              { automation }
//   POST   { profile_id, name, trigger_tag }       create (draft)      { automation }
//   PATCH  ?id=<uuid> { name?, trigger_tag? }                          { automation }
//   DELETE ?id=<uuid>                              removes its steps and their emails
//   POST   ?action=add-step  { automation_id, delay_hours? }  { step }
//   PATCH  ?action=step&id=<step_id> { delay_hours?, position? }
//   DELETE ?action=step&id=<step_id>
//   POST   ?action=activate  { id, enroll_existing? }  { automation, enrolled, skipped }
//   POST   ?action=pause     { id }
//
// A step is an email_campaigns row with trigger_type 'tag' (migration 0082),
// which is how a step inherits post-once, the composer, the merge-tag
// validator and the footer address check. Deleting a step therefore means
// deleting its campaign: the step row cascades from it.
//
// Switching one on is gated the same way sending a campaign is: every step
// has to pass validation AND have been test-sent since its copy last changed.
// Without that, an automation would be a way around the rule that a human
// reads an email in an inbox before a list does, and it would be a worse way,
// because nobody is watching when a drip goes out.

import { setCors, requireUser, supaFetch, assertProfileAccess, assertMinRole, isUuid } from '../_lib/supabase.js'
import { validateTemplate, testIsCurrent } from '../_lib/email-validate.js'
import { resolveSender } from '../_lib/email-render.js'
import { listSteps, findUnseen, enroll, isMissingTable } from '../_lib/email-automation-runner.js'

export const config = { maxDuration: 60 }

const enc = encodeURIComponent
const clean = (v, max = 120) => String(v ?? '').trim().slice(0, max)

// Same shape as a contact tag, so the trigger can actually match one:
// lowercase, no spaces, 40 characters. See normTags in contacts.js.
const normTag = (v) => clean(v, 40).toLowerCase().replace(/\s+/g, '-')

async function loadAutomation(id) {
  const rows = await supaFetch(`email_automations?id=eq.${enc(id)}&select=*`)
  return rows?.[0] || null
}

async function loadStep(id) {
  const rows = await supaFetch(`email_automation_steps?id=eq.${enc(id)}&select=*`)
  return rows?.[0] || null
}

async function patchAutomation(id, fields) {
  const rows = await supaFetch(`email_automations?id=eq.${enc(id)}`, {
    method: 'PATCH', body: { ...fields, updated_at: new Date().toISOString() },
  })
  return Array.isArray(rows) ? rows[0] : rows
}

// The steps of an automation, each with the campaign that holds its copy.
async function stepsWithEmails(automationId) {
  const steps = await listSteps(automationId)
  if (!steps.length) return []
  const ids = steps.map((s) => s.campaign_id)
  const list = `in.(${ids.map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')})`
  const campaigns = await supaFetch(
    `email_campaigns?id=${list}&select=id,subject,preview_text,html_body,last_test_sent_at,content_changed_at,sent_count,failed_count,opened_count`,
  ).catch(() => [])
  const byId = new Map((campaigns || []).map((c) => [c.id, c]))
  return steps.map((s) => ({ ...s, campaign: byId.get(s.campaign_id) || null }))
}

// Why this automation cannot be switched on yet. Empty means it can.
// Checked per step so the UI can point at the one that needs work.
async function blockers(automation, steps, postalAddress) {
  const out = []
  if (!steps.length) out.push({ reason: 'Add at least one email before switching this on.' })
  if (!automation.trigger_tag) out.push({ reason: 'Pick the tag that starts this sequence.' })

  for (const s of steps) {
    const c = s.campaign
    const where = `Step ${s.position}`
    if (!c) { out.push({ step_id: s.id, reason: `${where} has no email attached.` }); continue }
    const check = validateTemplate({ subject: c.subject, html: c.html_body, previewText: c.preview_text, postalAddress })
    if (!check.ok) { out.push({ step_id: s.id, reason: `${where}: ${check.errors[0]}` }); continue }
    if (!testIsCurrent(c)) {
      out.push({
        step_id: s.id,
        reason: `${where} has ${c.last_test_sent_at ? 'been edited since its last test send' : 'never been test-sent'}. Open it, send yourself a test, and read it in an inbox.`,
      })
    }
  }
  return out
}

// Enrollment tallies for the list view. Capped rather than counted exactly:
// PostgREST returns the count in a header supaFetch does not surface, and an
// approximate "500+" on a settings page is not worth an RPC.
const TALLY_CAP = 2000
async function tally(automationId) {
  const rows = await supaFetch(
    `email_automation_enrollments?automation_id=eq.${enc(automationId)}&select=status&limit=${TALLY_CAP}`,
  ).catch(() => [])
  const out = { active: 0, done: 0, skipped: 0, cancelled: 0, capped: (rows || []).length >= TALLY_CAP }
  for (const r of rows || []) if (out[r.status] !== undefined) out[r.status]++
  return out
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const auth = await requireUser(req, res)
  if (!auth) return
  const userId = auth.user.id
  const action = req.query.action || ''

  try {
    // ---- steps -------------------------------------------------------------
    if (action === 'step') {
      const step = await loadStep(req.query.id)
      if (!step) return res.status(404).json({ error: 'Step not found' })
      const automation = await loadAutomation(step.automation_id)
      if (!automation) return res.status(404).json({ error: 'Automation not found' })
      await assertMinRole(userId, automation.profile_id, 'editor')

      if (req.method === 'PATCH') {
        const body = req.body || {}
        const fields = {}
        if (body.delay_hours !== undefined) {
          const h = Math.round(Number(body.delay_hours))
          if (!Number.isFinite(h) || h < 0 || h > 8760) return res.status(400).json({ error: 'The wait has to be between 0 and 8760 hours.' })
          fields.delay_hours = h
        }
        if (body.position !== undefined) {
          const p = Math.round(Number(body.position))
          if (!Number.isFinite(p) || p < 1 || p > 200) return res.status(400).json({ error: 'Position has to be between 1 and 200.' })
          fields.position = p
        }
        if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nothing to change.' })
        const rows = await supaFetch(`email_automation_steps?id=eq.${enc(step.id)}`, { method: 'PATCH', body: fields })
        return res.status(200).json({ step: Array.isArray(rows) ? rows[0] : rows })
      }

      if (req.method === 'DELETE') {
        // The step row cascades from its campaign, so one delete does both.
        // It takes the step's send history with it, exactly as deleting a
        // campaign does.
        await supaFetch(`email_campaigns?id=eq.${enc(step.campaign_id)}`, { method: 'DELETE', prefer: 'return=minimal' })
        return res.status(200).json({ ok: true })
      }

      return res.status(405).json({ error: 'Method not allowed' })
    }

    if (action === 'add-step' && req.method === 'POST') {
      const body = req.body || {}
      if (!isUuid(body.automation_id)) return res.status(400).json({ error: 'automation_id required' })
      const automation = await loadAutomation(body.automation_id)
      if (!automation) return res.status(404).json({ error: 'Automation not found' })
      await assertMinRole(userId, automation.profile_id, 'editor')

      const existing = await listSteps(automation.id)
      if (existing.length >= 50) return res.status(400).json({ error: 'A sequence is capped at 50 emails.' })
      const position = existing.length + 1
      const h = body.delay_hours === undefined ? (position === 1 ? 0 : 48) : Math.round(Number(body.delay_hours))
      if (!Number.isFinite(h) || h < 0 || h > 8760) return res.status(400).json({ error: 'The wait has to be between 0 and 8760 hours.' })

      // The step's copy lives in a campaign row. trigger_type 'tag' is what
      // keeps it out of the Campaigns list and out of the scheduled-send cron.
      const made = await supaFetch('email_campaigns', {
        method: 'POST',
        body: {
          profile_id: automation.profile_id,
          status: 'draft',
          trigger_type: 'tag',
          trigger_on_tag: automation.trigger_tag,
          subject: `${automation.name}: email ${position}`,
          html_body: '',
          tag_filter: [],
        },
      })
      const campaign = Array.isArray(made) ? made[0] : made
      const createdStep = await supaFetch('email_automation_steps', {
        method: 'POST',
        body: { automation_id: automation.id, campaign_id: campaign.id, position, delay_hours: h },
      })
      return res.status(201).json({ step: Array.isArray(createdStep) ? createdStep[0] : createdStep, campaign })
    }

    // ---- activate / pause --------------------------------------------------
    if ((action === 'activate' || action === 'pause') && req.method === 'POST') {
      const body = req.body || {}
      const automation = await loadAutomation(body.id)
      if (!automation) return res.status(404).json({ error: 'Automation not found' })
      await assertMinRole(userId, automation.profile_id, 'editor')

      if (action === 'pause') {
        // Nothing is cancelled. Everyone keeps their place, and resuming
        // carries on from where they were.
        return res.status(200).json({ automation: await patchAutomation(automation.id, { status: 'paused' }) })
      }

      const steps = await stepsWithEmails(automation.id)
      const sender = await resolveSender(automation.profile_id)
      if (!sender.ok) return res.status(400).json({ error: sender.reason, code: 'sender_not_ready' })

      const stops = await blockers(automation, steps, sender.config?.postal_address || '')
      if (stops.length) {
        return res.status(422).json({ error: stops[0].reason, blockers: stops, code: 'not_ready' })
      }

      // "From now on" is the default, and this is where it is enforced:
      // everyone already carrying the trigger tag gets a skipped row, so the
      // runner will not mail them a sequence they never opted into today.
      // Opting in to that backlog enrols them instead, and the caller has
      // already been shown how many people that is.
      const unseen = await findUnseen(automation)
      const asStatus = body.enroll_existing ? 'active' : 'skipped'
      await enroll(automation, steps, unseen, asStatus)

      const updated = await patchAutomation(automation.id, {
        status: 'active', enrolls_from: new Date().toISOString(), last_error: null,
      })
      return res.status(200).json({
        automation: updated,
        enrolled: asStatus === 'active' ? unseen.length : 0,
        skipped: asStatus === 'skipped' ? unseen.length : 0,
      })
    }

    // ---- automations -------------------------------------------------------
    if (req.method === 'GET') {
      if (req.query.id) {
        const automation = await loadAutomation(req.query.id)
        if (!automation) return res.status(404).json({ error: 'Not found' })
        await assertProfileAccess(userId, automation.profile_id)
        const steps = await stepsWithEmails(automation.id)
        const sender = await resolveSender(automation.profile_id)
        return res.status(200).json({
          automation: { ...automation, steps, counts: await tally(automation.id) },
          blockers: await blockers(automation, steps, sender.config?.postal_address || ''),
          sender_ok: sender.ok,
          sender_reason: sender.ok ? null : sender.reason,
        })
      }

      const profileId = req.query.profile_id
      if (!isUuid(profileId)) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(userId, profileId)
      const rows = await supaFetch(`email_automations?profile_id=eq.${enc(profileId)}&select=*&order=created_at.asc`) || []
      // Resolved once for the whole list: the footer address and the sender
      // belong to the brand, not to each automation.
      const sender = await resolveSender(profileId)
      const postal = sender.config?.postal_address || ''
      const out = []
      for (const a of rows) {
        const steps = await stepsWithEmails(a.id)
        out.push({ ...a, steps, counts: await tally(a.id), blockers: await blockers(a, steps, postal) })
      }
      return res.status(200).json({
        automations: out,
        sender_ok: sender.ok,
        sender_reason: sender.ok ? null : sender.reason,
      })
    }

    if (req.method === 'POST' && !action) {
      const body = req.body || {}
      if (!isUuid(body.profile_id)) return res.status(400).json({ error: 'profile_id required' })
      await assertMinRole(userId, body.profile_id, 'editor')
      const name = clean(body.name)
      const tag = normTag(body.trigger_tag)
      if (!name) return res.status(400).json({ error: 'Give the automation a name.' })
      if (!tag) return res.status(400).json({ error: 'Pick the tag that starts this sequence.' })
      const created = await supaFetch('email_automations', {
        method: 'POST',
        body: { profile_id: body.profile_id, name, trigger_tag: tag, status: 'draft', created_by: userId },
      })
      return res.status(201).json({ automation: Array.isArray(created) ? created[0] : created })
    }

    if (req.method === 'PATCH') {
      const automation = await loadAutomation(req.query.id)
      if (!automation) return res.status(404).json({ error: 'Not found' })
      await assertMinRole(userId, automation.profile_id, 'editor')
      const body = req.body || {}
      const fields = {}
      if (body.name !== undefined) {
        fields.name = clean(body.name)
        if (!fields.name) return res.status(400).json({ error: 'Give the automation a name.' })
      }
      if (body.trigger_tag !== undefined) {
        const tag = normTag(body.trigger_tag)
        if (!tag) return res.status(400).json({ error: 'Pick the tag that starts this sequence.' })
        // Changing the trigger while it runs would strand everyone already in
        // the sequence: the runner stops anybody who no longer carries the
        // tag, so they would all be cancelled on the next tick.
        if (automation.status === 'active' && tag !== automation.trigger_tag) {
          return res.status(409).json({ error: 'Pause this automation before changing what starts it.' })
        }
        fields.trigger_tag = tag
      }
      if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nothing to change.' })
      return res.status(200).json({ automation: await patchAutomation(automation.id, fields) })
    }

    if (req.method === 'DELETE') {
      const automation = await loadAutomation(req.query.id)
      if (!automation) return res.status(404).json({ error: 'Not found' })
      await assertMinRole(userId, automation.profile_id, 'editor')
      // Steps and enrollments cascade from the automation, but the campaigns
      // holding each step's copy do not, so take those out first rather than
      // leaving rows nothing can reach.
      const steps = await listSteps(automation.id)
      for (const s of steps) {
        await supaFetch(`email_campaigns?id=eq.${enc(s.campaign_id)}`, { method: 'DELETE', prefer: 'return=minimal' }).catch(() => {})
      }
      await supaFetch(`email_automations?id=eq.${enc(automation.id)}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(200).json({ ok: true })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (e) {
    if (e?.status === 403) return res.status(403).json({ error: e.message || 'Forbidden' })
    if (isMissingTable(e)) {
      return res.status(503).json({
        error: 'Automations are not switched on for this database yet. Apply migration 0082 and reload.',
        code: 'migration_pending',
      })
    }
    console.error('[email/automations]', e)
    return res.status(500).json({ error: e?.message || 'Internal error' })
  }
}
