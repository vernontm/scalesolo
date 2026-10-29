// Unit tests for api/_lib/email-validate.js, the shared gate the composer,
// the campaigns API and the MCP tools all run before anything is sent.
//
//   node --test tests/email-validate.test.mjs      (or: npm run test:mcp)
//
// The image rules exist because the composer preview is a browser: a relative
// src resolves against scalesolo.ai and a data: URI renders fine there, then
// both arrive in the subscriber's inbox as a broken box. The preview cannot
// show that failure, so it has to be caught here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateTemplate, mergeVarHelp, MERGE_VARS } from '../api/_lib/email-validate.js'

const base = { subject: 'Sunday only', html: '<p>Hi {{first_name}}</p>' }
const run = (over) => validateTemplate({ ...base, ...over })
const errs = (over) => run(over).errors.join(' | ')

// The brand's business address. Passed in by the API and the composer, left
// out by callers that only hold the campaign, so both paths need covering.
test('a send is refused when the brand has no business address', () => {
  const r = run({ postalAddress: '' })
  assert.equal(r.ok, false)
  assert.match(r.errors.join(' '), /CAN-SPAM/)
  assert.match(r.errors.join(' '), /Business address/)
})

test('a saved business address satisfies the footer check', () => {
  const r = run({ postalAddress: '487 Bay Area Blvd, Houston, TX 77058' })
  assert.equal(r.ok, true, r.errors.join(' | '))
})

test('whitespace is not an address', () => {
  assert.equal(run({ postalAddress: '   ' }).ok, false)
})

test('the address check is skipped when the caller does not pass one', () => {
  const r = run({})
  assert.equal(r.ok, true, r.errors.join(' | '))
  assert.equal(r.errors.join(' ').includes('CAN-SPAM'), false)
})

test('a full document with its own unsubscribe warns that the footer is skipped', () => {
  const html = '<!DOCTYPE html><html><body><p>Hi</p><a href="{{unsubscribe_url}}">Unsubscribe</a></body></html>'
  const r = run({ html, postalAddress: '487 Bay Area Blvd, Houston, TX 77058' })
  assert.equal(r.ok, true, r.errors.join(' | '))
  assert.match(r.warnings.join(' '), /does not add its footer/)
})

test('a fragment body gets no footer warning: the footer is always appended', () => {
  const r = run({ postalAddress: '487 Bay Area Blvd, Houston, TX 77058' })
  assert.equal(r.warnings.join(' ').includes('does not add its footer'), false)
})

test('a sound template passes', () => {
  const r = run({})
  assert.equal(r.ok, true, r.errors.join(' | '))
  assert.deepEqual(r.errors, [])
})

test('an https image is accepted', () => {
  const r = run({ html: '<p>Hi</p><img src="https://sb.example.com/storage/v1/object/public/landing-media/p/email/1.png" width="536" />' })
  assert.equal(r.ok, true, r.errors.join(' | '))
})

test('an inline data: URI is refused and told what to do instead', () => {
  const r = run({ html: '<img src="data:image/png;base64,iVBORw0KGgo=" />' })
  assert.equal(r.ok, false)
  assert.match(errs({ html: '<img src="data:image/png;base64,iVBORw0KGgo=" />' }), /Gmail and Outlook strip those/)
  assert.match(r.errors.join(' '), /Upload it instead/)
})

test('a relative src is refused: an inbox has no page to resolve it against', () => {
  for (const src of ['/images/logo.png', 'logo.png', './assets/a.jpg', '../b.png']) {
    const r = run({ html: `<img src="${src}">` })
    assert.equal(r.ok, false, `${src} should be refused`)
    assert.match(r.errors.join(' '), /relative src/)
  }
})

test('plain http and cid: and file: are refused', () => {
  assert.match(errs({ html: '<img src="http://example.com/a.png">' }), /plain http/)
  assert.match(errs({ html: '<img src="cid:logo123">' }), /only resolves on the machine/)
  assert.match(errs({ html: '<img src="file:///Users/ray/Desktop/a.png">' }), /only resolves on the machine/)
})

test('an empty src is refused', () => {
  assert.match(errs({ html: '<img src="" alt="x">' }), /empty src/)
})

test('a merge tag as the src is left alone, since it resolves at send time', () => {
  const r = run({ html: '<img src="{{business}}">' })
  assert.equal(r.ok, true, r.errors.join(' | '))
})

test('single quotes, unquoted values and extra attributes are all parsed', () => {
  assert.match(errs({ html: "<img alt='a' src='data:image/png;base64,x' width='10'>" }), /data: URI/)
  assert.match(errs({ html: '<img src=logo.png>' }), /relative src/)
  assert.match(errs({ html: '<IMG  CLASS="x"  SRC="/a.png" >' }), /relative src/)
})

test('several bad images each get their own line', () => {
  const r = run({ html: '<img src="/a.png"><img src="data:image/png;base64,x"><img src="http://e.com/c.png">' })
  assert.equal(r.errors.length, 3, r.errors.join(' | '))
})

// ── the rules that were already there, still holding ───────────────────────

test('an unknown merge tag is refused with a suggestion', () => {
  assert.match(errs({ html: '<p>Hi {{firstname}}</p>' }), /Did you mean \{\{first_name\}\}\?/)
})

test('single braces are refused, because nothing ever fills them in', () => {
  assert.match(errs({ html: '<p>Hi {first_name}</p>' }), /single braces/)
})

test('an unsubscribe link with no {{unsubscribe_url}} is refused', () => {
  assert.match(errs({ html: '<p>Hi</p><a href="/bye">unsubscribe</a>' }), /no \{\{unsubscribe_url\}\} tag/)
})

test('a missing subject or body is refused', () => {
  assert.match(errs({ subject: '' }), /Add a subject line/)
  assert.match(errs({ html: '   ' }), /body is empty/)
})

test('mergeVarHelp lists exactly the five tags that resolve', () => {
  const help = mergeVarHelp()
  assert.equal(help.length, 5)
  assert.deepEqual(MERGE_VARS.map((v) => v.tag), ['first_name', 'name', 'email', 'business', 'unsubscribe_url'])
  for (const tag of ['first_name', 'name', 'email', 'business', 'unsubscribe_url']) {
    assert.ok(help.some((h) => h.startsWith(`{{${tag}}}`)), `${tag} missing from the help`)
  }
})
