// Unit tests for contact intake and ingest keys.
//
//   node --test tests/email-intake.test.mjs
//
// These cover the two things that decide whether an outside system can damage
// a client's list: the rule that a suppressed or opted-out address is never
// made mailable again, and the key handling that scopes a caller to one brand.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planUpsert, normTags, mergeTags, isEmail } from '../api/_lib/email-contacts.js'
import {
  generateKey, hashKey, keyFromRequest, hashesEqual, KEY_PREFIX,
} from '../api/_lib/email-api-key.js'

// ── intake rules ──────────────────────────────────────────────────────────

test('a new address is created active with its tags', () => {
  const p = planUpsert({ email: 'Jane@Example.COM ', tags: ['Funnel:Lead-Opt-In'], existing: null, suppressed: false })
  assert.equal(p.action, 'insert')
  assert.equal(p.row.email, 'jane@example.com')
  assert.equal(p.row.status, 'active')
  assert.deepEqual(p.row.tags, ['funnel:lead-opt-in'])
})

test('a suppressed address is never written, new or existing', () => {
  assert.equal(planUpsert({ email: 'a@b.com', existing: null, suppressed: true }).action, 'skip')
  assert.equal(planUpsert({ email: 'a@b.com', existing: null, suppressed: true }).reason, 'suppressed')
  const onList = planUpsert({
    email: 'a@b.com', tags: ['x'], suppressed: true,
    existing: { id: 'c1', status: 'active', tags: [] },
  })
  assert.equal(onList.action, 'skip')
})

test('an unsubscribed contact keeps that status but still collects the tag', () => {
  const p = planUpsert({
    email: 'a@b.com', tags: ['landing:spring'], suppressed: false,
    existing: { id: 'c1', status: 'unsubscribed', tags: ['old'] },
  })
  assert.equal(p.action, 'patch')
  assert.equal(p.held, 'unsubscribed')
  assert.equal(p.patch.status, undefined, 'must never set status back to active')
  assert.deepEqual(p.patch.tags, ['old', 'landing:spring'])
})

test('a bounced or complained contact is never made mailable again', () => {
  for (const status of ['bounced', 'complained']) {
    const p = planUpsert({
      email: 'a@b.com', tags: ['t'], suppressed: false,
      existing: { id: 'c1', status, tags: [] },
    })
    assert.equal(p.patch.status, undefined, `${status} must not be reactivated`)
    assert.equal(p.held, status)
  }
})

test('an existing active contact gains the new tag', () => {
  const p = planUpsert({
    email: 'a@b.com', tags: ['form:contact'], suppressed: false,
    existing: { id: 'c1', status: 'active', tags: ['vip'] },
  })
  assert.equal(p.action, 'patch')
  assert.deepEqual(p.patch.tags, ['vip', 'form:contact'])
})

test('a repeat submission with nothing new writes nothing', () => {
  const p = planUpsert({
    email: 'a@b.com', tags: ['vip'], name: 'Jane', suppressed: false,
    existing: { id: 'c1', status: 'active', tags: ['vip'], name: 'Jane' },
  })
  assert.equal(p.action, 'skip')
  assert.equal(p.reason, 'unchanged')
  assert.equal(p.id, 'c1')
})

test('a name or phone only fills a blank, never overwrites what is there', () => {
  const p = planUpsert({
    email: 'a@b.com', name: 'New Name', phone: '555', suppressed: false,
    existing: { id: 'c1', status: 'active', tags: [], name: 'Real Name', phone: '' },
  })
  assert.equal(p.patch.name, undefined, 'an existing name is not overwritten')
  assert.equal(p.patch.phone, '555', 'a blank phone is filled')
})

test('an invalid address is rejected before anything else', () => {
  for (const bad of ['', 'nope', 'a@b', 'a b@c.com', null, undefined]) {
    assert.equal(planUpsert({ email: bad, existing: null, suppressed: false }).action, 'skip')
  }
  assert.equal(isEmail('a@b.co'), true)
})

// ── tags ──────────────────────────────────────────────────────────────────

test('tags are lowercased, de-duplicated and capped at twenty', () => {
  assert.deepEqual(normTags(['A', 'a', ' b ']), ['a', 'b'])
  assert.deepEqual(normTags('x,y,x'), ['x', 'y'])
  assert.equal(normTags(Array.from({ length: 40 }, (_, i) => `t${i}`)).length, 20)
})

test('merging keeps the existing tags first so an automation trigger cannot be evicted', () => {
  const current = Array.from({ length: 20 }, (_, i) => `keep${i}`)
  const merged = mergeTags(current, ['brand-new'])
  assert.equal(merged.length, 20)
  assert.ok(merged.includes('keep0'), 'the tag an automation keys on survives')
  assert.ok(!merged.includes('brand-new'), 'the cap is respected rather than silently exceeded')
})

// ── ingest keys ───────────────────────────────────────────────────────────

test('a generated key carries its prefix and hashes to its stored digest', () => {
  const { key, hash, prefix } = generateKey()
  assert.ok(key.startsWith(KEY_PREFIX))
  assert.equal(hash, hashKey(key))
  assert.equal(hash.length, 64, 'sha-256 hex')
  assert.ok(key.startsWith(prefix))
  assert.ok(!hash.includes(key.slice(KEY_PREFIX.length)), 'the digest does not contain the key')
})

test('two generated keys never collide', () => {
  const seen = new Set()
  for (let i = 0; i < 200; i++) seen.add(generateKey().key)
  assert.equal(seen.size, 200)
})

test('a key is read from the header or a bearer token, never the query string', () => {
  assert.equal(keyFromRequest({ headers: { 'x-api-key': ' k1 ' } }), 'k1')
  assert.equal(keyFromRequest({ headers: { authorization: 'Bearer k2' } }), 'k2')
  assert.equal(keyFromRequest({ headers: { authorization: 'bearer k3' } }), 'k3')
  assert.equal(keyFromRequest({ headers: {} }), '')
  assert.equal(keyFromRequest({ headers: {}, query: { key: 'k4' } }), '',
    'a key in the URL would land in access logs, so it is not accepted')
})

test('digest comparison rejects mismatched values and differing lengths', () => {
  const a = hashKey('one')
  assert.equal(hashesEqual(a, a), true)
  assert.equal(hashesEqual(a, hashKey('two')), false)
  assert.equal(hashesEqual(a, a.slice(0, 10)), false)
  assert.equal(hashesEqual(a, ''), false)
  assert.equal(hashesEqual(undefined, undefined), true)
})
