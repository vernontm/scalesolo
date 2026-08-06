// Shared Brand Intake question set + helpers.
//
// Ported from the standalone prototype (docs/prototypes/brand-intake.html)
// into the app so both the public questionnaire page (src/pages/Intake.jsx)
// and the operator review / prefill flow (src/pages/Profiles.jsx) work off
// the exact same 13 questions and the same answer-to-profile field mapping.
//
// The questionnaire "state" shape used everywhere here is:
//   {
//     answers: { [questionId]: string },   // typed / spoken free text
//     chips:   { [questionId]: string[] }, // quick-pick selections
//     rank:    { [questionId]: string[] }, // platform priority order
//   }

// The 13 questions. `field` documents the real profiles column(s) each one
// informs; it is display-only in the UI and drives the mapping below.
export const INTAKE_QUESTIONS = [
  {
    id: 'brand_name',
    title: 'What is your brand or creator name, and in one line, what do you do?',
    why: 'This becomes your brand identity everywhere we post. The one-liner anchors every caption and hook.',
    followup: 'Example: "Emanuel Motors, a used-car dealership that makes buying feel human."',
    field: 'business_name, brand_bible',
    placeholder: 'Name, then one sentence on what you do...',
  },
  {
    id: 'audience',
    title: 'Who is your ideal audience? Be as specific as you can.',
    why: 'Everything from tone to platform choice bends around who we are trying to reach.',
    followup: 'Think age, location, what they want, what keeps them up at night. Vague ("everyone") hurts reach.',
    field: 'target_audience',
    placeholder: 'Who are we talking to...',
  },
  {
    id: 'goal_90',
    title: 'What is your number one goal for the next 90 days?',
    why: 'We reverse-engineer the content calendar from this single priority.',
    followup: 'Pick the closest, then add detail in your own words.',
    field: 'brand_bible (primary goal)',
    chips: ['Sales / revenue', 'Followers / reach', 'Attract sponsors', 'Brand awareness', 'Launch a product'],
    placeholder: 'Your main 90-day goal, and what winning looks like...',
  },
  {
    id: 'goal_secondary',
    title: 'Any commercial or secondary goal behind the content?',
    why: 'Content often doubles as a resume. If you want sponsors or partners, we shape posts to look the part.',
    followup: 'Example: "Look big enough that regional brands want to sponsor me."',
    field: 'brand_bible (secondary goal)',
    placeholder: 'Secondary goal, or type none...',
  },
  {
    id: 'voice',
    title: 'What is your brand voice and personality?',
    why: 'This trains how our writers sound as you. Tap the traits that fit, then add nuance.',
    followup: 'How should a stranger feel after reading one of your posts?',
    field: 'preferred_tone',
    chips: ['Bold', 'Premium', 'Technical', 'Funny', 'Warm', 'Direct', 'Playful', 'Authoritative', 'Inspirational', 'Down to earth'],
    placeholder: 'Describe your voice in your own words...',
  },
  {
    id: 'differentiator',
    title: 'What makes you different, and who are your competitors?',
    why: 'We lean into your edge and avoid sounding like everyone else in your lane.',
    followup: 'Name 1 to 3 competitors and the one thing you do better or differently.',
    field: 'brand_bible',
    placeholder: 'Your edge, plus a few competitors...',
  },
  {
    id: 'pillars',
    title: 'What are your content pillars, the topics you can talk about endlessly?',
    why: 'Pillars keep the calendar consistent and on-brand instead of random.',
    followup: 'List 3 to 5 themes. Example: behind the scenes, customer wins, myth-busting, quick tips.',
    field: 'brand_bible (content pillars)',
    placeholder: '3 to 5 topics you never run out of...',
  },
  {
    id: 'capacity',
    title: 'What content can you realistically create, who creates it, and at what cadence?',
    why: 'A plan you can actually sustain beats an ambitious one you abandon in week two.',
    followup: 'Can you film video? Photos only? Voice notes? Who does it, and how many days a week is realistic?',
    field: 'brand_bible (cadence)',
    placeholder: 'What you can make, who makes it, how often...',
  },
  {
    id: 'platforms',
    title: 'Rank your priority platforms.',
    why: 'We focus effort where your audience actually is instead of spreading thin.',
    followup: 'Move the top ones up. Leave the rest lower.',
    field: 'default_platforms',
    rank: ['Instagram', 'TikTok', 'YouTube', 'Facebook', 'X', 'LinkedIn'],
    placeholder: 'Anything to add about your platform choices...',
  },
  {
    id: 'no_go',
    title: 'What is on your no-go list?',
    why: 'We hard-code these so nothing off-brand or risky ever goes out under your name.',
    followup: 'Words, topics, claims, politics, competitors, promises you legally cannot make.',
    field: 'do_not_say',
    placeholder: 'Words, topics, or claims to avoid...',
  },
  {
    id: 'offers',
    title: 'What offers, products, or links do you want to drive traffic to?',
    why: 'These become the calls to action we rotate through your content.',
    followup: 'Product pages, a lead magnet, a booking link, a promo code.',
    field: 'always_include',
    placeholder: 'What are we sending people to...',
  },
  {
    id: 'proof',
    title: 'What proof or credibility can we use? Results, numbers, testimonials.',
    why: 'Specific proof outperforms adjectives. Real numbers and quotes build trust fast.',
    followup: 'Sales figures, years in business, awards, follower milestones, client quotes.',
    field: 'always_include, brand_bible (credibility)',
    placeholder: 'Numbers, wins, and testimonials we can cite...',
  },
  {
    id: 'anything_else',
    title: 'Anything else we should know?',
    why: 'Your chance to flag anything the questions above missed.',
    followup: 'Seasonality, a big launch coming, sensitivities, brand assets you have.',
    field: 'brand_bible',
    placeholder: 'Anything else...',
  },
]

// Canonical platform names used across the system (see profiles.default_platforms).
const PLATFORM_CANONICAL = {
  Instagram: 'instagram',
  TikTok: 'tiktok',
  YouTube: 'youtube',
  Facebook: 'facebook',
  X: 'x',
  LinkedIn: 'linkedin',
}

// A fresh, empty questionnaire state.
export function emptyIntakeState() {
  return { answers: {}, chips: {}, rank: {} }
}

// Normalize whatever came out of localStorage / the API into the canonical
// shape so downstream code never has to null-check.
export function normalizeIntakeState(raw) {
  const base = emptyIntakeState()
  if (!raw || typeof raw !== 'object') return base
  return {
    answers: raw.answers && typeof raw.answers === 'object' ? raw.answers : {},
    chips: raw.chips && typeof raw.chips === 'object' ? raw.chips : {},
    rank: raw.rank && typeof raw.rank === 'object' ? raw.rank : {},
  }
}

// A question counts as answered if it has free text or (for chip questions)
// at least one chip selected. Used for the progress bar.
export function isAnswered(state, q) {
  const text = (state.answers?.[q.id] || '').trim()
  if (text) return true
  if (q.chips && (state.chips?.[q.id] || []).length) return true
  return false
}

export function answeredCount(state) {
  return INTAKE_QUESTIONS.filter((q) => isAnswered(state, q)).length
}

// Compile the answers into a clean markdown summary. Mirrors the prototype's
// compile() so the operator sees a familiar, readable digest.
export function compileIntakeSummary(state) {
  const s = normalizeIntakeState(state)
  const lines = []
  lines.push('# ScaleSolo Brand Intake')
  lines.push('')
  INTAKE_QUESTIONS.forEach((q, i) => {
    lines.push(`## ${i + 1}. ${q.title}`)
    const parts = []
    if (q.chips) {
      const picks = s.chips[q.id] || []
      if (picks.length) parts.push(`Selected: ${picks.join(', ')}`)
    }
    if (q.rank && Array.isArray(s.rank[q.id])) {
      parts.push('Priority order: ' + s.rank[q.id].map((x, n) => `${n + 1}) ${x}`).join('  '))
    }
    const ans = (s.answers[q.id] || '').trim()
    if (ans) parts.push(ans)
    lines.push(parts.length ? parts.join('\n') : '(no answer)')
    lines.push('')
  })
  return lines.join('\n')
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
// ONLY the fields we could infer (empty values are omitted) so the caller
// can merge without clobbering. This never writes anything: the operator
// reviews the prefilled editor and saves normally.
export function mapIntakeToProfile(state) {
  const s = normalizeIntakeState(state)
  const out = {}

  // Target audience, direct.
  const audience = (s.answers.audience || '').trim()
  if (audience) out.target_audience = audience

  // Preferred tone, chips first, then any free-text nuance.
  const voiceChips = s.chips.voice || []
  const voiceText = (s.answers.voice || '').trim()
  const tone = [voiceChips.join(', '), voiceText].filter(Boolean).join('. ')
  if (tone) out.preferred_tone = tone

  // Default platforms, top 3 of the ranked order, mapped to canonical names.
  const rank = Array.isArray(s.rank.platforms) ? s.rank.platforms : []
  const platforms = rank
    .map((label) => PLATFORM_CANONICAL[label])
    .filter(Boolean)
    .slice(0, 3)
  if (platforms.length) out.default_platforms = platforms

  // Do-not-say list.
  const doNotSay = toList(s.answers.no_go)
  if (doNotSay.length) out.do_not_say = doNotSay

  // Always-include, offers + proof become CTAs / must-mention items.
  const alwaysInclude = [...toList(s.answers.offers), ...toList(s.answers.proof)]
  if (alwaysInclude.length) out.always_include = alwaysInclude

  // Brand bible, a narrative built from the richer answers so the operator
  // has a real starting draft to edit down.
  const bibleParts = []
  const push = (label, id) => {
    const v = (s.answers[id] || '').trim()
    if (v) bibleParts.push(`${label}: ${v}`)
  }
  push('Brand', 'brand_name')
  const goalChips = s.chips.goal_90 || []
  const goal90 = [goalChips.join(', '), (s.answers.goal_90 || '').trim()].filter(Boolean).join('. ')
  if (goal90) bibleParts.push(`90-day goal: ${goal90}`)
  push('Secondary goal', 'goal_secondary')
  push('Differentiator and competitors', 'differentiator')
  push('Content pillars', 'pillars')
  push('Capacity and cadence', 'capacity')
  push('Proof and credibility', 'proof')
  push('Other notes', 'anything_else')
  if (bibleParts.length) out.brand_bible = bibleParts.join('\n')

  return out
}
