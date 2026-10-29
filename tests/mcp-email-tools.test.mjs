// Unit tests for the email tools in mcp/lib.js, against a local fake
// ScaleSolo API.
//
//   node --test tests/mcp-email-tools.test.mjs      (or: npm run test:mcp)
//
// Nothing here touches the real app, a real provider or a real contact. The
// fake server stands in for www.scalesolo.ai, records every request, and can
// be told to answer with the real refusals (422 template_invalid,
// 428 test_send_required) so the tests can check that a caller is handed
// something it can act on rather than "request failed".
//
// mcp/lib.js reads SCALESOLO_API_BASE at import time, so the server has to be
// listening and the env set before the dynamic import below.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
// The real email-safe <img> builder. The fake API calls it exactly as the
// deployed endpoint does, so these tests assert on the markup that actually
// ships rather than on a copy that could drift.
import { imgHtml } from '../api/email/assets.js'

const PROFILES = [
  { id: 'p-ray', business_name: 'RayvaughnCEO', uploadpost_user: 'rayvaughnceo' },
  { id: 'p-sana', business_name: 'Sanabreh', uploadpost_user: 'sanabreh' },
]
// A brand whose campaign list always 500s, to prove a fan-out survives one
// bad profile.
const BROKEN_PROFILE = { id: 'p-broken', business_name: 'Broken Brand', uploadpost_user: 'broken' }

// A campaign row shaped like the real table, including the fields that must
// NOT reach a caller.
const campaign = (over = {}) => ({
  id: 'c-1',
  profile_id: 'p-ray',
  subject: 'Sunday only: the family platter',
  preview_text: 'Back by request',
  html_body: '<p>Hi {{first_name}}</p>',
  status: 'draft',
  tag_filter: [],
  scheduled_at: null,
  sent_at: null,
  total_recipients: 7,
  sent_count: 0,
  last_test_sent_at: null,
  content_changed_at: null,
  created_at: '2026-10-20T10:00:00.000Z',
  // Must never be echoed back by a tool.
  from_email: 'ray@mg.scalesolo.ai',
  reply_to: 'ray@vernontm.com',
  last_error: null,
  ...over,
})

let server
let base
let requests = []
// Per-test overrides: { 'POST /api/email/campaigns': { status, body } }
let routes = {}
let campaignsFor = {}
let automationsFor = {}
let contactsFor = {}
let senderOk = true
let includeBroken = false

function reply(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      let body = null
      try { body = raw.length ? JSON.parse(raw.toString()) : null } catch { body = null }
      const action = url.searchParams.get('action') || ''
      const key = `${req.method} ${url.pathname}${action ? `?action=${action}` : ''}`
      requests.push({ key, method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, bytes: raw.length, headers: req.headers })

      // An explicit override wins, so a test can force a 422 / 428.
      if (routes[key]) return reply(res, routes[key].status, routes[key].body)

      // The image a upload_email_image({ url }) test points at.
      if (url.pathname === '/fake-image.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        return res.end(Buffer.from('89504e470d0a1a0a', 'hex'))
      }
      if (url.pathname === '/not-an-image') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end('<html>nope</html>')
      }
      // The signed storage PUT target.
      if (url.pathname === '/storage-put') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end('{}')
      }
      if (url.pathname === '/api/profiles') {
        return reply(res, 200, { profiles: includeBroken ? [...PROFILES, BROKEN_PROFILE] : PROFILES })
      }

      if (url.pathname === '/api/email/assets') {
        const publicUrl = 'https://sb.example.com/storage/v1/object/public/landing-media/p-ray/email/1-abc.png'
        return reply(res, 200, {
          signed_url: `${base}/storage-put`,
          token: 'tok',
          path: `${body?.profile_id}/email/1-abc.png`,
          public_url: publicUrl,
          kind: 'image',
          img_html: imgHtml(publicUrl, { alt: body?.alt ?? body?.filename ?? '' }),
        })
      }

      if (url.pathname === '/api/email/campaigns') {
        if (req.method === 'GET' && url.searchParams.get('id')) {
          return reply(res, 200, { campaign: campaign({ id: url.searchParams.get('id') }) })
        }
        if (req.method === 'GET') {
          const pid = url.searchParams.get('profile_id')
          if (pid === BROKEN_PROFILE.id) return reply(res, 500, { error: 'this brand is broken' })
          return reply(res, 200, { campaigns: campaignsFor[pid] || [] })
        }
        if (req.method === 'POST' && action === 'test') {
          return reply(res, 200, { ok: true, message_id: 'm-1', last_test_sent_at: '2026-10-24T12:00:00.000Z' })
        }
        if (req.method === 'POST' && action === 'schedule') {
          return reply(res, 200, { campaign: campaign({ status: 'scheduled', scheduled_at: body?.scheduled_at, total_recipients: 7 }) })
        }
        if (req.method === 'POST') return reply(res, 201, { campaign: campaign({ id: 'c-new', ...body, html_body: body?.html_body }) })
        if (req.method === 'PATCH') return reply(res, 200, { campaign: campaign({ ...body, id: url.searchParams.get('id') }) })
      }

      // Shaped exactly like the real GET: steps is an ARRAY and the enrolment
      // split lives under `counts`. Both are easy to mis-read as a count and a
      // flat field, which is the bug these fixtures exist to catch.
      if (url.pathname === '/api/email/automations' && req.method === 'GET') {
        const pid = url.searchParams.get('profile_id')
        if (pid === BROKEN_PROFILE.id) return reply(res, 500, { error: 'this brand is broken' })
        return reply(res, 200, {
          automations: automationsFor[pid] || [],
          sender_ok: senderOk,
          sender_reason: senderOk ? null : 'This brand has no verified sending domain yet.',
        })
      }

      if (url.pathname === '/api/email/contacts' && req.method === 'GET') {
        const pid = url.searchParams.get('profile_id')
        if (pid === BROKEN_PROFILE.id) return reply(res, 500, { error: 'this brand is broken' })
        const all = contactsFor[pid] || []
        const tag = (url.searchParams.get('tag') || '').toLowerCase()
        const status = url.searchParams.get('status') || ''
        const limit = Number(url.searchParams.get('limit')) || 50
        let rows = all
        if (tag) rows = rows.filter((c) => (c.tags || []).includes(tag))
        if (status) rows = rows.filter((c) => c.status === status)
        const counts = {}
        for (const c of all) counts[c.status || 'active'] = (counts[c.status || 'active'] || 0) + 1
        // The real endpoint's `total` is the WHOLE list, ignoring the filters.
        return reply(res, 200, { contacts: rows.slice(0, limit), total: all.length, counts, limit, offset: 0 })
      }

      return reply(res, 404, { error: `unhandled ${key}` })
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  process.env.SCALESOLO_API_BASE = base
  process.env.SCALESOLO_INTERNAL_SECRET = 'test-secret'
  process.env.SCALESOLO_USER_ID = 'u-test'
  // Keep review_url independent of the fake API host.
  process.env.SCALESOLO_APP_BASE = 'https://www.scalesolo.ai'
})

after(() => new Promise((r) => server.close(r)))
beforeEach(() => {
  requests = []; routes = {}; campaignsFor = {}; includeBroken = false
  automationsFor = {}; contactsFor = {}; senderOk = true
})

const { impls, TOOLS } = await import('../mcp/lib.js')
const out = (r) => JSON.parse(r.content[0].text)
const sent = (key) => requests.find((r) => r.key === key)

// ── list_email_campaigns ───────────────────────────────────────────────────

test('list_email_campaigns spans brands and carries profile_id on every row', async () => {
  campaignsFor = {
    'p-ray': [campaign({ id: 'c-ray', profile_id: 'p-ray', created_at: '2026-10-22T00:00:00Z' })],
    'p-sana': [campaign({ id: 'c-sana', profile_id: 'p-sana', subject: 'Lamb chops Friday', created_at: '2026-10-23T00:00:00Z' })],
  }
  const rows = out(await impls.list_email_campaigns({}))
  assert.ok(Array.isArray(rows), 'must be a bare array so api/mcp.js can filter it')
  assert.deepEqual(rows.map((r) => r.campaign_id), ['c-sana', 'c-ray'], 'newest first')
  // This is the field SCOPE_FILTERED keys on. Without it on every row a
  // brand-scoped token sees other brands' campaigns.
  for (const r of rows) assert.ok(r.profile_id, 'every row needs profile_id for scope filtering')
  assert.deepEqual(rows.map((r) => r.brand), ['Sanabreh', 'RayvaughnCEO'])
})

test('list_email_campaigns never leaks the sender snapshot or raw row', async () => {
  campaignsFor = { 'p-ray': [campaign({ id: 'c-ray' })], 'p-sana': [] }
  const [row] = out(await impls.list_email_campaigns({ brand: 'RayvaughnCEO' }))
  for (const leaked of ['from_email', 'reply_to', 'html_body', 'last_error']) {
    assert.ok(!(leaked in row), `${leaked} must not reach the caller`)
  }
  assert.deepEqual(Object.keys(row).sort(), [
    'audience_tags', 'brand', 'campaign_id', 'last_test_sent_at', 'preview_text', 'profile_id',
    'review_url', 'scheduled_at', 'sent_at', 'status', 'subject', 'tested_since_last_edit', 'total_recipients',
  ])
})

test('list_email_campaigns filters by status and rejects a bogus one', async () => {
  campaignsFor = {
    'p-ray': [campaign({ id: 'c-draft', status: 'draft' }), campaign({ id: 'c-sched', status: 'scheduled' })],
    'p-sana': [],
  }
  const rows = out(await impls.list_email_campaigns({ status: 'scheduled' }))
  assert.deepEqual(rows.map((r) => r.campaign_id), ['c-sched'])
  await assert.rejects(() => impls.list_email_campaigns({ status: 'queued' }), /status must be one of/)
})

test('list_email_campaigns skips a brand that errors instead of failing the search', async () => {
  // One brand's list 500s. A fan-out across every brand must still return the
  // others rather than losing the whole search to one bad profile.
  includeBroken = true
  campaignsFor = { 'p-ray': [campaign({ id: 'c-ray' })], 'p-sana': [] }
  const rows = out(await impls.list_email_campaigns({}))
  assert.deepEqual(rows.map((r) => r.campaign_id), ['c-ray'])
  assert.ok(requests.some((r) => r.query.profile_id === 'p-broken'), 'the broken brand was asked and skipped')
})

test('list_email_campaigns reports the failure when the brand was named explicitly', async () => {
  includeBroken = true
  await assert.rejects(() => impls.list_email_campaigns({ brand: 'Broken Brand' }), /this brand is broken/)
})

// ── review_url, the thing Ray asked for ────────────────────────────────────

test('every email tool hands back a review_url pointing at the composer', async () => {
  campaignsFor = { 'p-ray': [campaign({ id: 'c-ray' })], 'p-sana': [] }
  const results = [
    out(await impls.list_email_campaigns({ brand: 'RayvaughnCEO' }))[0],
    out(await impls.create_email_campaign({ brand: 'RayvaughnCEO', subject: 'Hi', html: '<p>Hi {{first_name}}</p>' })),
    out(await impls.update_email_campaign({ campaign_id: 'c-1', subject: 'New' })),
    out(await impls.send_test_email({ campaign_id: 'c-1', to: 'ray@vernontm.com' })),
    out(await impls.schedule_email_campaign({ campaign_id: 'c-1', scheduled_at: '2026-11-02T09:00:00-06:00' })),
  ]
  for (const r of results) {
    assert.match(r.review_url, /^https:\/\/www\.scalesolo\.ai\/email\?campaign=/)
    assert.ok(r.campaign_id, 'the id has to come back alongside the link')
  }
})

// ── create / update ────────────────────────────────────────────────────────

test('create_email_campaign resolves the brand and posts the draft', async () => {
  const r = out(await impls.create_email_campaign({
    brand: 'sanabreh', subject: 'Lamb chops Friday', html: '<p>Hey {{first_name}}</p>',
    preview_text: 'This Friday only', audience_tags: ['vip'],
  }))
  const req = sent('POST /api/email/campaigns')
  assert.equal(req.body.profile_id, 'p-sana', 'brand name resolved to the profile id')
  assert.equal(req.body.html_body, '<p>Hey {{first_name}}</p>', 'html goes in as html_body')
  assert.deepEqual(req.body.tag_filter, ['vip'], 'audience_tags maps to tag_filter')
  assert.equal(r.status, 'draft')
  assert.match(r.note, /Nothing has been sent/)
})

test('create_email_campaign insists on a subject and a body', async () => {
  await assert.rejects(() => impls.create_email_campaign({ brand: 'sanabreh', html: '<p>x</p>' }), /subject is required/)
  await assert.rejects(() => impls.create_email_campaign({ brand: 'sanabreh', subject: 'x' }), /html is required/)
})

test('update_email_campaign sends only the fields given, and warns the test is void', async () => {
  routes['GET /api/email/campaigns'] = { status: 200, body: { campaign: campaign({ last_test_sent_at: '2026-10-24T09:00:00Z' }) } }
  const r = out(await impls.update_email_campaign({ campaign_id: 'c-1', html: '<p>Rewritten {{name}}</p>' }))
  const req = sent('PATCH /api/email/campaigns')
  assert.deepEqual(Object.keys(req.body), ['html_body'], 'an unset field must not be sent as null')
  assert.match(r.note, /earlier test send no longer counts/)
})

test('update_email_campaign reports that rewriting the copy unscheduled it', async () => {
  // Editing a scheduled campaign's body would otherwise let the cron mail
  // copy nobody tested, so the API pulls it back to draft. A caller that is
  // not told this will believe the send is still booked.
  routes['PATCH /api/email/campaigns'] = {
    status: 200,
    body: {
      campaign: campaign({ status: 'draft', scheduled_at: null }),
      unscheduled: true,
      notice: 'Editing the copy unscheduled this campaign. Send a fresh test, then schedule it again.',
    },
  }
  const r = out(await impls.update_email_campaign({ campaign_id: 'c-1', html: '<p>Rewritten</p>' }))
  assert.equal(r.unscheduled, true)
  assert.equal(r.status, 'draft')
  assert.equal(r.scheduled_at, null)
  assert.match(r.note, /unscheduled this campaign/)
})

test('update_email_campaign refuses an empty patch and a non-list audience', async () => {
  await assert.rejects(() => impls.update_email_campaign({ campaign_id: 'c-1' }), /nothing to update/)
  await assert.rejects(() => impls.update_email_campaign({ campaign_id: 'c-1', audience_tags: 'vip' }), /must be a list/)
  await assert.rejects(() => impls.update_email_campaign({}), /campaign_id is required/)
})

// ── the 422 and 428 refusals, surfaced verbatim ────────────────────────────

test('a failed template validation reaches the caller with its errors and the legal tags', async () => {
  routes['POST /api/email/campaigns?action=schedule'] = {
    status: 422,
    body: {
      error: '{{firstname}} is not a merge tag, so it will be sent as literal text. Did you mean {{first_name}}?',
      errors: [
        '{{firstname}} is not a merge tag, so it will be sent as literal text. Did you mean {{first_name}}?',
        'An <img> uses an inline data: URI. Gmail and Outlook strip those, so the image will not appear.',
      ],
      warnings: ['A link has an empty href, so clicking it does nothing.'],
      merge_variables: ['{{first_name}} Contact\'s first name.', '{{unsubscribe_url}} The real one-click unsubscribe link.'],
      code: 'template_invalid',
    },
  }
  await assert.rejects(
    () => impls.schedule_email_campaign({ campaign_id: 'c-1', scheduled_at: '2026-11-02T09:00:00-06:00' }),
    (e) => {
      // Every error, the warning and the usable tags, not just the first line.
      assert.match(e.message, /Did you mean \{\{first_name\}\}\?/)
      assert.match(e.message, /inline data: URI/)
      assert.match(e.message, /A link has an empty href/)
      assert.match(e.message, /\{\{unsubscribe_url\}\}/)
      return true
    },
  )
})

test('the test-send gate reaches the caller with the fix named', async () => {
  routes['POST /api/email/campaigns?action=schedule'] = {
    status: 428,
    body: {
      error: 'This campaign has never been test-sent. Send a test to yourself and read it in an inbox first, then send or schedule it.',
      code: 'test_send_required',
    },
  }
  await assert.rejects(
    () => impls.schedule_email_campaign({ campaign_id: 'c-1', scheduled_at: '2026-11-02T09:00:00-06:00' }),
    (e) => {
      assert.match(e.message, /never been test-sent/)
      assert.match(e.message, /send_test_email with your own address/)
      return true
    },
  )
})

// ── scheduling, and the timezone trap ──────────────────────────────────────

test('schedule_email_campaign refuses a local time with no zone rather than guessing', async () => {
  await assert.rejects(
    () => impls.schedule_email_campaign({ campaign_id: 'c-1', scheduled_at: '2026-11-02T09:00' }),
    /no timezone, so the send time is ambiguous/,
  )
  assert.equal(sent('POST /api/email/campaigns?action=schedule'), undefined, 'nothing may be scheduled on an ambiguous time')
})

test('schedule_email_campaign converts a zoned local time to the right instant', async () => {
  // 2026-11-02 is after US DST ends (Nov 1), so Chicago is UTC-6.
  await impls.schedule_email_campaign({ campaign_id: 'c-1', scheduled_at: '2026-11-02T09:00', timezone: 'America/Chicago' })
  assert.equal(sent('POST /api/email/campaigns?action=schedule').body.scheduled_at, '2026-11-02T15:00:00.000Z')
})

test('schedule_email_campaign honours an explicit offset and rejects nonsense', async () => {
  await impls.schedule_email_campaign({ campaign_id: 'c-1', scheduled_at: '2026-11-02T09:00:00-06:00' })
  assert.equal(sent('POST /api/email/campaigns?action=schedule').body.scheduled_at, '2026-11-02T15:00:00.000Z')
  await assert.rejects(() => impls.schedule_email_campaign({ campaign_id: 'c-1', scheduled_at: 'next tuesday' }), /Could not read/)
  await assert.rejects(() => impls.schedule_email_campaign({ campaign_id: 'c-1' }), /scheduled_at .* is required/)
})

// ── test sends ─────────────────────────────────────────────────────────────

test('send_test_email posts one message and reports the gate as satisfied', async () => {
  routes['GET /api/email/campaigns'] = { status: 200, body: { campaign: campaign({ last_test_sent_at: '2026-10-24T12:00:00.000Z' }) } }
  const r = out(await impls.send_test_email({ campaign_id: 'c-1', to: 'ray@vernontm.com' }))
  const req = sent('POST /api/email/campaigns?action=test')
  assert.deepEqual(req.body, { id: 'c-1', to: 'ray@vernontm.com' })
  assert.equal(r.test_sent_to, 'ray@vernontm.com')
  assert.equal(r.tested_since_last_edit, true)
})

test('send_test_email rejects a malformed or multiple address', async () => {
  for (const bad of ['', 'nope', 'a@b', 'one@x.com, two@x.com']) {
    await assert.rejects(() => impls.send_test_email({ campaign_id: 'c-1', to: bad }), /single valid email address/)
  }
  assert.equal(sent('POST /api/email/campaigns?action=test'), undefined)
})

// ── images ─────────────────────────────────────────────────────────────────

test('upload_email_image stores the bytes and returns email-safe markup', async () => {
  const r = out(await impls.upload_email_image({ brand: 'RayvaughnCEO', url: `${base}/fake-image.png`, alt: 'Family platter' }))
  const init = sent('POST /api/email/assets')
  assert.equal(init.body.profile_id, 'p-ray')
  assert.equal(init.body.content_type, 'image/png')
  assert.equal(init.body.alt, 'Family platter', 'alt is passed to the API, which builds the markup')
  const put = requests.find((x) => x.path === '/storage-put')
  assert.ok(put, 'the bytes must actually be PUT to storage')
  assert.ok(put.bytes > 0)
  assert.match(r.public_url, /^https:\/\//, 'an inbox can only load an absolute https URL')
  // Without max-width Outlook renders at intrinsic size and breaks the shell.
  assert.match(r.img_html, /max-width:536px/)
  assert.match(r.img_html, /alt="Family platter"/)
  assert.match(r.img_html, /border:0/)
})

test('upload_email_image refuses a web page, a missing source and both sources', async () => {
  await assert.rejects(() => impls.upload_email_image({ brand: 'RayvaughnCEO', url: `${base}/not-an-image` }), /not an image/)
  await assert.rejects(() => impls.upload_email_image({ brand: 'RayvaughnCEO' }), /Pass file_path .* or url/)
  await assert.rejects(() => impls.upload_email_image({ brand: 'RayvaughnCEO', url: 'x', file_path: '/tmp/x.png' }), /not both/)
})

test('upload_email_image refuses a file type no mail client can show', async () => {
  await assert.rejects(
    () => impls.upload_email_image({ brand: 'RayvaughnCEO', file_path: '/tmp/clip.mp4' }),
    /cannot go in an email/,
  )
})

// ── tool schemas ───────────────────────────────────────────────────────────

test('every email tool is declared, and the ones taking HTML list the merge tags', async () => {
  const names = ['list_email_campaigns', 'create_email_campaign', 'update_email_campaign',
    'schedule_email_campaign', 'send_test_email', 'upload_email_image']
  for (const n of names) {
    const t = TOOLS.find((x) => x.name === n)
    assert.ok(t, `${n} must be in TOOLS or no client can see it`)
    assert.ok(impls[n], `${n} needs an implementation`)
  }
  // A caller that cannot see the five tags writes {{firstname}} and ships
  // literal braces to a subscriber.
  for (const n of ['create_email_campaign', 'update_email_campaign']) {
    const t = TOOLS.find((x) => x.name === n)
    for (const tag of ['first_name', 'name', 'email', 'business', 'unsubscribe_url']) {
      assert.ok(t.description.includes(`{{${tag}}}`), `${n} description must name {{${tag}}}`)
    }
    assert.ok(t.inputSchema.properties.html.description.includes('{{first_name}}'), `${n} html field must name the tags too`)
  }
})

// ── list_email_automations ─────────────────────────────────────────────────
//
// The shape of the API response is the trap here. `steps` is an array and the
// enrolment split is nested under `counts`, so reading them as a number and as
// flat fields yields null everywhere while still "working". Each of these
// asserts a real value rather than merely that a key exists.

const automation = (over = {}) => ({
  id: 'a-1',
  profile_id: 'p-sana',
  name: 'Bizio: new lead',
  trigger_tag: 'bizio:lead',
  status: 'draft',
  steps: [
    { id: 's-1', position: 1, delay_hours: 0 },
    { id: 's-2', position: 2, delay_hours: 48 },
  ],
  counts: { active: 3, done: 1, skipped: 190, cancelled: 2, capped: false },
  blockers: [{ step_id: 's-1', reason: 'Step 1: The email body is empty.' }],
  last_error: null,
  ...over,
})

test('list_email_automations reports the step COUNT and the nested enrolment split', async () => {
  automationsFor = { 'p-sana': [automation()] }
  const rows = out(await impls.list_email_automations({ brand: 'Sanabreh' }))
  assert.equal(rows.length, 1)
  const r = rows[0]
  assert.equal(r.steps, 2, 'steps is an array in the API, so this must be its length')
  assert.deepEqual(r.step_delays_hours, [0, 48])
  assert.equal(r.enrolled_active, 3, 'comes from counts.active, not a flat field')
  assert.equal(r.completed, 1)
  assert.equal(r.held_back_as_already_tagged, 190, 'the "from now on" backlog must be visible')
  assert.equal(r.cancelled, 2)
})

test('list_email_automations surfaces the blockers as readable reasons', async () => {
  automationsFor = { 'p-sana': [automation()] }
  const [r] = out(await impls.list_email_automations({ brand: 'Sanabreh' }))
  assert.equal(r.can_be_switched_on, false)
  assert.deepEqual(r.blockers, ['Step 1: The email body is empty.'])
})

test('list_email_automations treats a clean sequence as ready only when the sender is too', async () => {
  automationsFor = { 'p-sana': [automation({ blockers: [] })] }
  let [r] = out(await impls.list_email_automations({ brand: 'Sanabreh' }))
  assert.equal(r.can_be_switched_on, true)

  senderOk = false
  ;[r] = out(await impls.list_email_automations({ brand: 'Sanabreh' }))
  assert.equal(r.can_be_switched_on, false, 'no verified sender means it cannot go live')
  assert.match(r.blockers.join(' '), /verified sending domain/)
})

test('list_email_automations carries profile_id on every row, or the brand scope filter fails closed', async () => {
  automationsFor = { 'p-ray': [automation({ id: 'a-ray', profile_id: 'p-ray' })], 'p-sana': [automation()] }
  const rows = out(await impls.list_email_automations({}))
  assert.ok(rows.length >= 2)
  assert.ok(rows.every((r) => typeof r.profile_id === 'string' && r.profile_id), 'api/mcp.js filters rows by profile_id')
  assert.ok(Array.isArray(rows), 'the scope filter calls .filter on the parsed output')
})

test('list_email_automations skips a brand that errors instead of losing the whole search', async () => {
  includeBroken = true
  automationsFor = { 'p-sana': [automation()] }
  const rows = out(await impls.list_email_automations({}))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].brand, 'Sanabreh')
})

test('list_email_automations never exposes a way to switch one on', () => {
  const names = TOOLS.map((t) => t.name)
  for (const forbidden of ['activate_email_automation', 'pause_email_automation', 'create_email_automation']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must stay out of the MCP: it can start mailing a real list`)
  }
})

// ── list_email_contacts ────────────────────────────────────────────────────

const contact = (over = {}) => ({
  id: 'ct-1', email: 'a@example.com', name: 'A', tags: ['bizio:loyalty'],
  status: 'active', source: 'bizio', created_at: '2026-10-29T00:00:00.000Z',
  signed_up_at: '2026-10-29T00:00:00.000Z', ...over,
})

test('list_email_contacts counts the matches rather than reporting the sample size', async () => {
  // 30 loyalty members, 5 leads. A limit of 2 must still say 30.
  contactsFor = {
    'p-sana': [
      ...Array.from({ length: 30 }, (_, i) => contact({ id: `l-${i}`, email: `l${i}@x.com` })),
      ...Array.from({ length: 5 }, (_, i) => contact({ id: `d-${i}`, email: `d${i}@x.com`, tags: ['bizio:lead'] })),
    ],
  }
  const [r] = out(await impls.list_email_contacts({ brand: 'Sanabreh', tag: 'bizio:loyalty', limit: 2 }))
  assert.equal(r.matching_the_filters, 30, 'the whole point of the tool is this number being right')
  assert.equal(r.shown_below, 2, 'the sample respects the limit')
  assert.equal(r.contacts.length, 2)
  assert.equal(r.total_on_list, 35, 'the list total ignores the filter')
  assert.equal(r.tag_searched, 'bizio:loyalty')
})

test('list_email_contacts falls back to the list total when nothing is being filtered', async () => {
  contactsFor = { 'p-sana': Array.from({ length: 12 }, (_, i) => contact({ id: `c-${i}`, email: `c${i}@x.com` })) }
  const [r] = out(await impls.list_email_contacts({ brand: 'Sanabreh', limit: 3 }))
  assert.equal(r.matching_the_filters, 12, 'with no filter, 3 would be a lie')
  assert.equal(r.shown_below, 3)
})

test('list_email_contacts filters by tag and by status, passing both to the API', async () => {
  contactsFor = {
    'p-sana': [
      contact({ id: 'x1', tags: ['bizio:loyalty'], status: 'active' }),
      contact({ id: 'x2', tags: ['bizio:loyalty'], status: 'unsubscribed' }),
    ],
  }
  const [r] = out(await impls.list_email_contacts({ brand: 'Sanabreh', tag: 'bizio:loyalty', status: 'active' }))
  assert.equal(r.matching_the_filters, 1)
  const q = requests.find((x) => x.path === '/api/email/contacts').query
  assert.equal(q.tag, 'bizio:loyalty')
  assert.equal(q.status, 'active')
})

test('list_email_contacts carries profile_id and stays an array for the scope filter', async () => {
  contactsFor = { 'p-ray': [contact({ id: 'r1' })], 'p-sana': [contact()] }
  const rows = out(await impls.list_email_contacts({}))
  assert.ok(Array.isArray(rows))
  assert.ok(rows.every((r) => typeof r.profile_id === 'string' && r.profile_id))
})

test('list_email_contacts returns a brand with an empty list rather than dropping it', async () => {
  includeBroken = true
  contactsFor = { 'p-sana': [contact()] }
  const rows = out(await impls.list_email_contacts({}))
  const broken = rows.find((r) => r.brand === 'Broken Brand')
  assert.ok(broken, 'a failing brand is still listed, so it is not mistaken for having no contacts')
  assert.equal(broken.matching_the_filters, 0)
})

test('both new tools are declared read-only and brand-scoped in api/mcp.js', async () => {
  const src = await import('node:fs').then((m) => m.promises.readFile('api/mcp.js', 'utf8'))
  const scope = src.match(/const SCOPE_FILTERED = \{[\s\S]*?\n\}/)[0]
  const readonly = src.match(/const READONLY = \[[\s\S]*?\]/)[0]
  for (const name of ['list_email_automations', 'list_email_contacts']) {
    assert.ok(TOOLS.some((t) => t.name === name), `${name} is declared`)
    // A cross-brand list tool that is not scope filtered hands a brand-scoped
    // token someone else's client data. api/mcp.js says so in a comment; this
    // makes it fail the build instead of a review.
    assert.match(scope, new RegExp(`${name}:\\s*'profile_id'`), `${name} must be in SCOPE_FILTERED`)
    assert.match(readonly, new RegExp(name), `${name} must be callable by a readonly token`)
  }
})
