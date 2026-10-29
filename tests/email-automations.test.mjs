// Unit tests for the automation runner's decision logic.
//
//   node --test tests/email-automations.test.mjs
//
// These cover the parts that decide WHEN and WHETHER a drip email goes out,
// which is where an error is both silent and expensive: this runs unattended
// every minute against real client lists. The sending itself is not retested
// here, because automations send through sendCampaignToContact, the same
// claim-before-send path the campaign worker uses.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advanceFrom, dueAt, tagClause } from '../api/_lib/email-automation-runner.js'

const steps = [
  { id: 's1', position: 1, delay_hours: 0 },
  { id: 's2', position: 2, delay_hours: 48 },
  { id: 's3', position: 3, delay_hours: 72 },
]
const T0 = Date.parse('2026-11-01T12:00:00.000Z')

test('a contact moves to the next step, due after that step\'s wait', () => {
  const r = advanceFrom(steps, 's1', T0)
  assert.equal(r.status, 'active')
  assert.equal(r.next_step_id, 's2')
  assert.equal(r.next_run_at, new Date(T0 + 48 * 3600e3).toISOString())
})

test('finishing the last step finishes the contact, with nothing left due', () => {
  const r = advanceFrom(steps, 's3', T0)
  assert.equal(r.status, 'done')
  assert.equal(r.next_step_id, null)
  assert.equal(r.next_run_at, null)
  // A done enrollment with a next_run_at would be picked up forever by the
  // due query, which is how a drip turns into a loop.
})

test('a step deleted mid-sequence finishes the contact instead of guessing', () => {
  const r = advanceFrom(steps, 'deleted-step-id', T0)
  assert.equal(r.status, 'done')
  assert.equal(r.next_run_at, null)
})

test('the wait is measured from now, not from when the contact signed up', () => {
  const later = T0 + 10 * 24 * 3600e3
  assert.equal(advanceFrom(steps, 's1', later).next_run_at, new Date(later + 48 * 3600e3).toISOString())
})

test('a zero wait is due immediately, so a welcome lands on the next tick', () => {
  assert.equal(dueAt(0, T0), new Date(T0).toISOString())
})

test('a missing or negative wait is treated as zero rather than as the past', () => {
  for (const bad of [undefined, null, -5, NaN, 'soon']) {
    assert.equal(dueAt(bad, T0), new Date(T0).toISOString(), `${bad} should be 0`)
  }
})

test('a fractional wait is computed rather than floored to zero', () => {
  // The column stores whole hours and the API rounds to them, so this is
  // about the helper never silently collapsing a wait to "send now".
  assert.equal(dueAt(0.5, T0), new Date(T0 + 30 * 60e3).toISOString())
})

test('the trigger tag is matched by containment, and is encoded', () => {
  assert.equal(tagClause('welcome'), 'tags=cs.%5B%22welcome%22%5D')
  // A tag with a quote or a brace must not be able to break out of the
  // PostgREST filter and widen the query to other contacts.
  assert.ok(!tagClause('a"b&profile_id=eq.x').includes('&'))
  assert.ok(!tagClause('a"b').includes('"'))
})

test('an empty step list cannot start anybody', () => {
  const r = advanceFrom([], 's1', T0)
  assert.equal(r.status, 'done')
})
