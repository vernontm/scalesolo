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

// ── brand theming ──────────────────────────────────────────────────────────
//
// One shell reads the brand rather than one template per brand. The data is
// hand-entered and already wrong three ways in production, so these cover the
// real values rather than tidy ones.

import { safeHex, readableOn, contrastRatio, emailSafeUrl, brandTheme } from '../api/_lib/email-render.js'

test('a colour saved with a leading space is sanitised, not pasted into CSS', () => {
  // LUL Fitness really has " #ffcf00" saved. Used raw it silently breaks the
  // declaration it lands in.
  assert.equal(safeHex(' #ffcf00'), '#ffcf00')
  assert.equal(safeHex('#ABC'), '#aabbcc', 'short hex is expanded so luminance maths has one shape')
})

test('anything that is not a hex colour is rejected so it cannot reach a style attribute', () => {
  for (const bad of ['red', 'rgb(1,2,3)', '#12', '#12345', 'url(x)', '#ff0000; background:url(javascript:1)', '', null]) {
    assert.equal(safeHex(bad), null, `${JSON.stringify(bad)} must not pass`)
  }
})

test('text colour is chosen by contrast, not by a luminance guess', () => {
  // Gold sits in the middle of the range where a threshold gets it wrong:
  // white on it is about 2.3, dark ink about 7.5. Two brands here are gold.
  assert.equal(readableOn('#c9a84c'), '#1a1a2e')
  assert.equal(readableOn('#C6A252'), '#1a1a2e')
  assert.equal(readableOn('#030303'), '#ffffff')
  assert.equal(readableOn('#ffcf00'), '#1a1a2e')
})

test('every real brand colour clears WCAG AA against the text picked for it', () => {
  for (const c of ['#D71920', '#30a8a8', '#030303', '#ffcf00', '#123D2B', '#C6A252', '#c9a84c', '#f5edd8', '#ef4444']) {
    const ratio = contrastRatio(c, readableOn(c))
    assert.ok(ratio >= 4.5, `${c} only reaches ${ratio.toFixed(2)}:1`)
  }
})

test('a site URL with no scheme is made absolute, or it is a dead link in an inbox', () => {
  // lisa v green and LUL Fitness both have scheme-less URLs saved. In an
  // email a bare host is a RELATIVE href, which goes nowhere.
  assert.equal(emailSafeUrl('lisavgreeninspires.com'), 'https://lisavgreeninspires.com')
  assert.equal(emailSafeUrl('bizio.link/b/level-up-life-llc'), 'https://bizio.link/b/level-up-life-llc')
  assert.equal(emailSafeUrl('https://x.com'), 'https://x.com')
  assert.equal(emailSafeUrl('not a url'), null)
  assert.equal(emailSafeUrl(''), null)
})

test('a brand with nothing configured keeps the plain shell rather than an empty coloured bar', () => {
  const t = brandTheme({ business_name: 'Nobody', brand_primary_color: null, logo_url: '', website_url: '' })
  assert.equal(t.band, null)
  assert.equal(t.logo, null)
  assert.equal(t.site, null)
  assert.equal(t.link, '#2563eb', 'links fall back to a readable default')
})

test('a pale brand colour does not become an unreadable link on white', () => {
  const t = brandTheme({ brand_primary_color: '#f5edd8', brand_secondary_color: '#ffcf00' })
  assert.equal(t.link, '#2563eb', 'neither pale colour is legible as link text, so the default is kept')
})
