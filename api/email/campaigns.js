// Email campaigns: drafts, scheduling, sending, test sends, previews.
//
// Routes:
//   GET    ?profile_id=<uuid>                  { campaigns: [...] }
//   GET    ?profile_id=<uuid>&action=tags      { tags: [{ tag, count }], contacts }
//   GET    ?id=<uuid>                          { campaign }
//   POST   { profile_id, subject, ... }        create draft        { campaign }
//   PATCH  ?id=<uuid> { ...fields }            update draft        { campaign }
//   POST   ?action=preview  { profile_id, subject, preview_text, html_body }   { html }
//   POST   ?action=test     { id, to }         one test message to `to`
//   POST   ?action=send     { id }             send now (runs the worker inline, cron finishes)
//   POST   ?action=schedule { id, scheduled_at }
//
// send and schedule are gated twice: validateTemplate (422) for merge tags
// that will not resolve and a missing footer address, and a current test send
// (428) so nobody mails a list an email no human has read in an inbox. See
// migration 0081.
//   POST   ?action=cancel   { id }             scheduled -> draft; sending -> stop (partial)
//   DELETE ?id=<uuid>
//
// Delivery itself lives in api/_lib/email-send-worker.js.

import { setCors, requireUser, supaFetch, assertProfileAccess, assertMinRole, isUuid } from '../_lib/supabase.js'
import { resolveSender, renderCampaignEmail, mergeVarsFor, mergeTags, htmlToText } from '../_lib/email-render.js'
import { sendEmail, isConfigured, configurationSetFor } from '../_lib/email-provider.js'
import { processCampaign, countRecipients } from '../_lib/email-send-worker.js'
import { validateTemplate, mergeVarHelp } from '../_lib/email-validate.js'

export const config = { maxDuration: 60 }

const enc = encodeURIComponent
const EDITABLE = ['draft', 'scheduled', 'failed']

// The fields a test send actually proves. Changing one of these invalidates
// the test; changing the audience, from name or reply-to does not, because
// none of them changes what the subscriber reads. See migration 0081.
const TESTED_FIELDS = ['subject', 'html_body', 'preview_text']

// Has this campaign been test-sent since its copy last changed?
function testIsCurrent(c) {
  if (!c.last_test_sent_at) return false
  if (!c.content_changed_at) return true
  return new Date(c.last_test_sent_at).getTime() >= new Date(c.content_changed_at).getTime()
}

// One shared refusal so the UI, the API and the MCP all say the same thing
// and all name the same fix.
function testGateError(c) {
  const verb = c.last_test_sent_at ? 'has been edited since its last test send' : 'has never been test-sent'
  return {
    error: `This campaign ${verb}. Send a test to yourself and read it in an inbox first, then send or schedule it.`,
    code: 'test_send_required',
    last_test_sent_at: c.last_test_sent_at || null,
    content_changed_at: c.content_changed_at || null,
    fix: 'POST /api/email/campaigns?action=test { id, to } with your own address, then retry.',
  }
}

function sanitize(body) {
  const out = {}
  if (body.subject !== undefined) out.subject = String(body.subject || '').slice(0, 300)
  if (body.preview_text !== undefined) out.preview_text = body.preview_text ? String(body.preview_text).slice(0, 300) : null
  if (body.html_body !== undefined) out.html_body = String(body.html_body || '').slice(0, 400000)
  if (body.tag_filter !== undefined) {
    out.tag_filter = (Array.isArray(body.tag_filter) ? body.tag_filter : []).map((t) => String(t).trim().slice(0, 80)).filter(Boolean).slice(0, 30)
  }
  if (body.from_name !== undefined) out.from_name = body.from_name ? String(body.from_name).slice(0, 120) : null
  if (body.reply_to !== undefined) out.reply_to = body.reply_to ? String(body.reply_to).trim().slice(0, 254) : null
  return out
}

async function loadCampaign(id) {
  if (!isUuid(id)) return null
  const rows = await supaFetch(`email_campaigns?id=eq.${enc(id)}&select=*`)
  return rows?.[0] || null
}

async function patch(id, fields) {
  const rows = await supaFetch(`email_campaigns?id=eq.${enc(id)}`, { method: 'PATCH', body: { ...fields, updated_at: new Date().toISOString() } })
  return rows?.[0] || null
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const auth = await requireUser(req, res)
  if (!auth) return
  const userId = auth.user.id
  const action = String(req.query?.action || '')

  try {
    if (req.method === 'GET') {
      if (req.query.id) {
        const c = await loadCampaign(req.query.id)
        if (!c) return res.status(404).json({ error: 'Not found' })
        await assertProfileAccess(userId, c.profile_id)
        return res.status(200).json({ campaign: c })
      }
      const profileId = req.query.profile_id
      if (!isUuid(profileId)) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(userId, profileId)

      if (action === 'tags') {
        const rows = await supaFetch(`email_contacts?profile_id=eq.${enc(profileId)}&status=eq.active&select=tags&limit=5000`)
        const counts = new Map()
        for (const r of rows || []) for (const t of (Array.isArray(r.tags) ? r.tags : [])) {
          const k = String(t).trim(); if (!k) continue
          counts.set(k, (counts.get(k) || 0) + 1)
        }
        const tags = [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
        return res.status(200).json({ tags, contacts: (rows || []).length })
      }

      const rows = await supaFetch(`email_campaigns?profile_id=eq.${enc(profileId)}&order=created_at.desc&limit=200&select=*`)
      return res.status(200).json({ campaigns: rows || [] })
    }

    if (req.method === 'POST' && !action) {
      const body = req.body || {}
      if (!isUuid(body.profile_id)) return res.status(400).json({ error: 'profile_id required' })
      await assertMinRole(userId, body.profile_id, 'editor')
      const fields = sanitize(body)
      if (!fields.subject) return res.status(400).json({ error: 'subject required' })
      const created = await supaFetch('email_campaigns', {
        method: 'POST',
        body: { profile_id: body.profile_id, status: 'draft', trigger_type: 'broadcast', html_body: '', tag_filter: [], ...fields },
      })
      return res.status(201).json({ campaign: Array.isArray(created) ? created[0] : created })
    }

    if (req.method === 'PATCH') {
      const c = await loadCampaign(req.query.id)
      if (!c) return res.status(404).json({ error: 'Not found' })
      await assertMinRole(userId, c.profile_id, 'editor')
      if (!EDITABLE.includes(c.status)) return res.status(409).json({ error: `A ${c.status} campaign cannot be edited.` })
      const fields = sanitize(req.body || {})
      if (fields.subject !== undefined && !fields.subject) return res.status(400).json({ error: 'subject required' })
      // Only stamp content_changed_at when the copy really moved. The
      // composer saves on every test send and every schedule, so stamping on
      // any PATCH would invalidate the test the user just ran and make the
      // gate unpassable.
      const copyMoved = TESTED_FIELDS.some((k) => fields[k] !== undefined && fields[k] !== c[k])
      if (copyMoved) fields.content_changed_at = new Date().toISOString()
      // Rewriting the copy of an ALREADY SCHEDULED campaign would otherwise
      // defeat the gate entirely: the cron worker does not re-check it (and
      // must not, or a campaign in flight could silently fail to send), so
      // the edited, untested copy would go out at the scheduled time. Pull it
      // back to draft instead. The status change is visible immediately on
      // the card, which beats both silently sending untested copy and
      // silently not sending at all.
      let unscheduled = false
      if (copyMoved && c.status === 'scheduled') {
        fields.status = 'draft'
        fields.scheduled_at = null
        unscheduled = true
      }
      return res.status(200).json({
        campaign: await patch(c.id, fields),
        ...(unscheduled ? {
          unscheduled: true,
          notice: 'Editing the copy unscheduled this campaign. Send a fresh test, then schedule it again.',
        } : {}),
      })
    }

    if (req.method === 'DELETE') {
      const c = await loadCampaign(req.query.id)
      if (!c) return res.status(404).json({ error: 'Not found' })
      await assertMinRole(userId, c.profile_id, 'editor')
      if (c.status === 'sending') return res.status(409).json({ error: 'Stop the send before deleting.' })
      await supaFetch(`email_campaigns?id=eq.${enc(c.id)}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const body = req.body || {}

    if (action === 'preview') {
      if (!isUuid(body.profile_id)) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(userId, body.profile_id)
      const sender = await resolveSender(body.profile_id)
      const profile = sender.profile || {}
      const vars = mergeVarsFor({ contact: { id: null, name: 'Jordan Example', email: 'jordan@example.com' }, profile, campaignId: null })
      vars.unsubscribe_url = '#'
      const html = renderCampaignEmail({
        subject: body.subject || '', previewText: body.preview_text || '', body: body.html_body || '',
        fromName: sender.config?.from_name || profile.business_name, profile, config: sender.config || {}, vars,
      })
      return res.status(200).json({ html, sender_ok: sender.ok, sender_reason: sender.ok ? null : sender.reason })
    }

    const c = await loadCampaign(body.id)
    if (!c) return res.status(404).json({ error: 'Campaign not found' })
    await assertMinRole(userId, c.profile_id, 'editor')

    if (action === 'test') {
      if (!isConfigured()) return res.status(503).json({ error: 'Email sending is not configured on the server yet.' })
      const to = String(body.to || '').trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'Enter a valid test address.' })
      const sender = await resolveSender(c.profile_id)
      if (!sender.ok) return res.status(400).json({ error: sender.reason })
      const { profile, config: cfg } = sender
      const vars = mergeVarsFor({ contact: { id: null, name: 'Test Recipient', email: to }, profile, campaignId: null })
      vars.unsubscribe_url = '#'
      const html = renderCampaignEmail({ subject: c.subject, previewText: c.preview_text, body: c.html_body, fromName: c.from_name || cfg.from_name, profile, config: cfg, vars })
      try {
        const messageId = await sendEmail({
          from: cfg.from_email, fromName: c.from_name || cfg.from_name || profile.business_name, to,
          replyTo: c.reply_to || cfg.reply_to_email || null,
          subject: `[Test] ${mergeTags(c.subject, vars)}`, html, text: htmlToText(html),
          tags: { campaign_id: c.id, profile_id: c.profile_id, test: '1' }, configurationSet: configurationSetFor(sender.provider),
        }, sender.provider)
        // Stamped only after the provider accepted it. A test that failed to
        // leave the building proves nothing, so it must not open the gate.
        const stamped = await patch(c.id, { last_test_sent_at: new Date().toISOString() })
        return res.status(200).json({ ok: true, message_id: messageId, last_test_sent_at: stamped?.last_test_sent_at || null })
      } catch (e) {
        const msg = String(e?.message || e)
        let hint = ''
        if (sender.provider === 'ses' && /not verified/i.test(msg)) {
          hint = ' The SES account is still in sandbox mode, so test recipients must be verified in AWS first.'
        } else if (sender.provider === 'mailgun' && /activate your mailgun account/i.test(msg)) {
          hint = ' Click the activation link Mailgun emailed you, then try again.'
        } else if (sender.provider === 'mailgun' && /not allowed to send/i.test(msg)) {
          hint = ' That domain is not verified on Mailgun yet, or the account is still on a sandbox domain.'
        }
        return res.status(502).json({ error: `${sender.provider} refused the test send: ${msg}.${hint}` })
      }
    }

    // Refuse to send or schedule a template whose merge tags will not
    // resolve. The failure is invisible until it is in a subscriber's inbox.
    if (['send', 'schedule'].includes(action)) {
      // The footer's postal address is a brand setting rather than part of the
      // campaign, so it has to be read before the template can be judged.
      const cfgRow = (await supaFetch(`email_config?profile_id=eq.${enc(c.profile_id)}&select=postal_address&limit=1`))?.[0] || {}
      const check = validateTemplate({
        subject: c.subject, html: c.html_body, previewText: c.preview_text,
        postalAddress: cfgRow.postal_address || '',
      })
      if (!check.ok) {
        return res.status(422).json({
          error: check.errors[0],
          errors: check.errors,
          warnings: check.warnings,
          merge_variables: mergeVarHelp(),
          code: 'template_invalid',
        })
      }
      // And refuse one nobody has read in a real inbox. The validator checks
      // what it can parse; a test send is the only thing that catches a
      // layout that collapses in Gmail or an image that does not load.
      // Enforced HERE rather than in the composer so the API, the MCP and any
      // future caller hit the same gate.
      if (!testIsCurrent(c)) return res.status(428).json(testGateError(c))
    }

    if (action === 'schedule') {
      if (!EDITABLE.includes(c.status)) return res.status(409).json({ error: `A ${c.status} campaign cannot be scheduled.` })
      const when = new Date(body.scheduled_at || '')
      if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'scheduled_at must be a valid date' })
      if (when.getTime() < Date.now() - 60 * 1000) return res.status(400).json({ error: 'That time is in the past.' })
      const sender = await resolveSender(c.profile_id)
      if (!sender.ok) return res.status(400).json({ error: sender.reason })
      const recipients = await countRecipients(c.profile_id, c.tag_filter)
      if (!recipients) return res.status(400).json({ error: 'No active contacts match this audience.' })
      const updated = await patch(c.id, {
        status: 'scheduled', scheduled_at: when.toISOString(), total_recipients: recipients, last_error: null,
        from_name: c.from_name || sender.config.from_name, from_email: sender.config.from_email, reply_to: c.reply_to || sender.config.reply_to_email || null,
      })
      return res.status(200).json({ campaign: updated })
    }

    if (action === 'cancel') {
      if (c.status === 'scheduled') return res.status(200).json({ campaign: await patch(c.id, { status: 'draft', scheduled_at: null }) })
      if (c.status === 'sending') return res.status(200).json({ campaign: await patch(c.id, { status: 'partial', last_error: 'Stopped by user before every contact was reached.' }) })
      return res.status(409).json({ error: `Nothing to cancel: campaign is ${c.status}.` })
    }

    if (action === 'send') {
      if (!isConfigured()) return res.status(503).json({ error: 'Email sending is not configured on the server yet.' })
      if (!EDITABLE.includes(c.status)) return res.status(409).json({ error: `A ${c.status} campaign cannot be sent again.` })
      if (!c.subject?.trim() || !c.html_body?.trim()) return res.status(400).json({ error: 'Add a subject and a body first.' })
      const sender = await resolveSender(c.profile_id)
      if (!sender.ok) return res.status(400).json({ error: sender.reason })
      const recipients = await countRecipients(c.profile_id, c.tag_filter)
      if (!recipients) return res.status(400).json({ error: 'No active contacts match this audience.' })
      await patch(c.id, {
        status: 'sending', started_at: new Date().toISOString(), scheduled_at: null, total_recipients: recipients, last_error: null,
        from_name: c.from_name || sender.config.from_name, from_email: sender.config.from_email, reply_to: c.reply_to || sender.config.reply_to_email || null,
      })
      // Work through as much as fits in this request; the cron picks up the rest.
      const stats = await processCampaign(c.id, { budgetMs: 40000 })
      return res.status(200).json({ campaign: await loadCampaign(c.id), stats })
    }

    return res.status(400).json({ error: `Unknown action: ${action}` })
  } catch (e) {
    if (e?.status === 403) return res.status(403).json({ error: e.message || 'Forbidden' })
    console.error('[email/campaigns]', e)
    return res.status(500).json({ error: e?.message || 'Internal error' })
  }
}
