// Client-side Brand Intake helpers.
//
// The question set and the pure state / summary helpers live in
// api/_lib/brandIntake.js so the public serverless endpoint (api/intake.js)
// can validate submissions and compile the stored summary server-side from
// the exact same definitions the SPA renders. This module re-exports them
// for the app and adds the operator-only answers-to-editor-fields mapping.

import {
  INTAKE_QUESTIONS,
  emptyIntakeState,
  normalizeIntakeState,
  isAnswered,
  answeredCount,
  compileIntakeSummary,
  asText,
  asArr,
} from '../../api/_lib/brandIntake.js'

export {
  INTAKE_QUESTIONS,
  emptyIntakeState,
  normalizeIntakeState,
  isAnswered,
  answeredCount,
  compileIntakeSummary,
}

// Split a free-text answer into a clean array of items. Handles commas and
// newlines, trims, and drops empties. Used for do_not_say / always_include.
function toList(text) {
  if (!text) return []
  return String(text)
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// Map the questionnaire answers into brand-profile editor fields. Returns
// ONLY the fields we could infer (empty values are omitted). The caller
// (prefillFromSubmission in src/pages/Profiles.jsx) merges these FILL-ONLY:
// fields that already have a value on the profile keep it, and the intake
// bible draft is appended to an existing curated bible under a labeled
// separator instead of replacing it. This never writes anything: the
// operator reviews the prefilled editor and saves normally.
//
// Every nested read goes through asText / asArr: submissions arrive via a
// public endpoint, so a hostile or malformed row must degrade to empty
// fields instead of throwing inside the Prefill click handler.
//
// The client's platform ranking is deliberately NOT mapped to
// default_platforms. That column silently drives live posting targets
// (Content.jsx, BulkUploadView.jsx) and has no editor UI, so a prefill must
// never set it; the ranking is folded into the visible brand_bible draft
// instead, where the operator can act on it deliberately.
export function mapIntakeToProfile(state) {
  const s = normalizeIntakeState(state)
  const out = {}

  // Target audience, direct.
  const audience = asText(s.answers.audience)
  if (audience) out.target_audience = audience

  // Preferred tone, chips first, then any free-text nuance.
  const voiceChips = asArr(s.chips.voice)
  const voiceText = asText(s.answers.voice)
  const tone = [voiceChips.join(', '), voiceText].filter(Boolean).join('. ')
  if (tone) out.preferred_tone = tone

  // Do-not-say list.
  const doNotSay = toList(asText(s.answers.no_go))
  if (doNotSay.length) out.do_not_say = doNotSay

  // Always-include, offers + proof become CTAs / must-mention items.
  const alwaysInclude = [...toList(asText(s.answers.offers)), ...toList(asText(s.answers.proof))]
  if (alwaysInclude.length) out.always_include = alwaysInclude

  // Brand bible, a narrative built from the richer answers so the operator
  // has a real starting draft to edit down.
  const bibleParts = []
  const push = (label, id) => {
    const v = asText(s.answers[id])
    if (v) bibleParts.push(`${label}: ${v}`)
  }
  push('Brand', 'brand_name')
  const goalChips = asArr(s.chips.goal_90)
  const goal90 = [goalChips.join(', '), asText(s.answers.goal_90)].filter(Boolean).join('. ')
  if (goal90) bibleParts.push(`90-day goal: ${goal90}`)
  push('Secondary goal', 'goal_secondary')
  push('Differentiator and competitors', 'differentiator')
  push('Content pillars', 'pillars')
  push('Capacity and cadence', 'capacity')
  const platformRank = asArr(s.rank.platforms)
  if (platformRank.length) {
    bibleParts.push(`Platform priority (client-ranked): ${platformRank.join(', ')}`)
  }
  const platformNotes = asText(s.answers.platforms)
  if (platformNotes) bibleParts.push(`Platform notes: ${platformNotes}`)
  push('Proof and credibility', 'proof')
  push('Other notes', 'anything_else')
  if (bibleParts.length) out.brand_bible = bibleParts.join('\n')

  return out
}
