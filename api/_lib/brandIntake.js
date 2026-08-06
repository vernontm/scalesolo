// Shared Brand Intake question set + pure helpers.
//
// Canonical home for everything BOTH sides of the intake feature need:
//   - the public serverless endpoint (api/intake.js), which strictly
//     validates submitted answers and compiles the stored summary
//     SERVER-SIDE so the digest the operator reviews always matches the
//     answers that were actually stored (a client-sent summary is never
//     trusted), and
//   - the SPA (public questionnaire page src/pages/Intake.jsx and the
//     operator review / prefill flow in src/pages/Profiles.jsx) via the
//     re-exports in src/lib/brandIntake.js.
//
// Lives in api/_lib/ because that is this repo's shared-logic home for
// serverless code. The module itself is pure ESM with no browser or node
// dependencies, so the Vite build bundles it for the SPA without issue.
//
// The questionnaire "state" shape used everywhere here is:
//   {
//     answers: { [questionId]: string },   // typed / spoken free text
//     chips:   { [questionId]: string[] }, // quick-pick selections
//     rank:    { [questionId]: string[] }, // platform priority order
//     meta:    { ... }                     // optional small client metadata
//   }

// The 13 questions. `field` documents the real profiles column(s) each one
// informs; it is display-only in the UI and drives the mapping in
// src/lib/brandIntake.js.
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
    field: 'brand_bible (platform priority)',
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

// Defensive readers. Submission state can come from localStorage, from a
// public POST body, or from a stored DB row, so every nested read is
// type-checked instead of trusted. A hostile or malformed value degrades
// to an empty string / array instead of throwing.
export const asText = (v) => (typeof v === 'string' ? v.trim() : '')
export const asArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])

// A fresh, empty questionnaire state.
export function emptyIntakeState() {
  return { answers: {}, chips: {}, rank: {} }
}

// Normalize whatever came out of localStorage / the API into the canonical
// shape so downstream code never has to null-check the top level.
export function normalizeIntakeState(raw) {
  const base = emptyIntakeState()
  if (!raw || typeof raw !== 'object') return base
  return {
    answers: raw.answers && typeof raw.answers === 'object' && !Array.isArray(raw.answers) ? raw.answers : {},
    chips: raw.chips && typeof raw.chips === 'object' && !Array.isArray(raw.chips) ? raw.chips : {},
    rank: raw.rank && typeof raw.rank === 'object' && !Array.isArray(raw.rank) ? raw.rank : {},
  }
}

// A question counts as answered if it has free text or (for chip questions)
// at least one chip selected. Used for the progress bar.
export function isAnswered(state, q) {
  const text = asText(state.answers?.[q.id])
  if (text) return true
  if (q.chips && asArr(state.chips?.[q.id]).length) return true
  return false
}

export function answeredCount(state) {
  return INTAKE_QUESTIONS.filter((q) => isAnswered(state, q)).length
}

// Compile the answers into a clean markdown summary. Mirrors the prototype's
// compile() so the operator sees a familiar, readable digest. Called
// SERVER-SIDE by api/intake.js on the validated answers (the stored
// summary_md is always derived from the stored answers, never client-sent)
// and client-side for the pre-submit preview.
export function compileIntakeSummary(state) {
  const s = normalizeIntakeState(state)
  const lines = []
  lines.push('# ScaleSolo Brand Intake')
  lines.push('')
  INTAKE_QUESTIONS.forEach((q, i) => {
    lines.push(`## ${i + 1}. ${q.title}`)
    const parts = []
    if (q.chips) {
      const picks = asArr(s.chips[q.id])
      if (picks.length) parts.push(`Selected: ${picks.join(', ')}`)
    }
    if (q.rank) {
      const order = asArr(s.rank[q.id])
      if (order.length) parts.push('Priority order: ' + order.map((x, n) => `${n + 1}) ${x}`).join('  '))
    }
    const ans = asText(s.answers[q.id])
    if (ans) parts.push(ans)
    lines.push(parts.length ? parts.join('\n') : '(no answer)')
    lines.push('')
  })
  return lines.join('\n')
}

// ── Server-side payload validation (api/intake.js POST) ───────────────────
//
// The public endpoint accepts JSON from anyone holding the intake link, so
// the nested shape is validated STRICTLY: unknown top-level keys, wrong
// types, or oversized values are rejected (the endpoint turns the returned
// error into a 400). On success it returns a normalized copy containing
// ONLY the documented keys, so nothing beyond the known shape is stored.

const MAX_STATE_KEYS = 100        // keys per top-level object (answers / chips / rank)
const MAX_KEY_CHARS = 100         // question ids are short slugs
const MAX_ANSWER_CHARS = 10000    // per free-text answer
const MAX_LIST_ITEMS = 50         // per chips / rank array
const MAX_LIST_ITEM_CHARS = 500   // per chips / rank entry
const MAX_META_BYTES = 2000       // small optional metadata blob

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

// Returns { ok: true, value } with the normalized state, or
// { ok: false, error } describing the first rejected field. Error strings
// keep echoed keys short so a hostile key cannot bloat the response.
export function validateIntakeAnswers(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: 'answers must be an object' }

  const KNOWN = new Set(['answers', 'chips', 'rank', 'meta'])
  for (const key of Object.keys(raw)) {
    if (!KNOWN.has(key)) {
      return { ok: false, error: `answers has an unknown key: ${String(key).slice(0, 50)}` }
    }
  }

  const value = { answers: {}, chips: {}, rank: {} }

  const badKeys = (obj, label) => {
    const keys = Object.keys(obj)
    if (keys.length > MAX_STATE_KEYS) return `${label} has too many keys`
    for (const k of keys) {
      if (k.length > MAX_KEY_CHARS) return `${label} has an oversized key`
    }
    return null
  }

  if (raw.answers !== undefined) {
    if (!isPlainObject(raw.answers)) return { ok: false, error: 'answers.answers must be an object' }
    const keyErr = badKeys(raw.answers, 'answers.answers')
    if (keyErr) return { ok: false, error: keyErr }
    for (const [k, v] of Object.entries(raw.answers)) {
      const short = k.slice(0, 50)
      if (typeof v !== 'string') return { ok: false, error: `answers.answers.${short} must be a string` }
      if (v.length > MAX_ANSWER_CHARS) return { ok: false, error: `answers.answers.${short} is too long` }
      value.answers[k] = v
    }
  }

  for (const listKey of ['chips', 'rank']) {
    const src = raw[listKey]
    if (src === undefined) continue
    if (!isPlainObject(src)) return { ok: false, error: `answers.${listKey} must be an object` }
    const keyErr = badKeys(src, `answers.${listKey}`)
    if (keyErr) return { ok: false, error: keyErr }
    for (const [k, v] of Object.entries(src)) {
      const short = k.slice(0, 50)
      if (!Array.isArray(v)) return { ok: false, error: `answers.${listKey}.${short} must be an array` }
      if (v.length > MAX_LIST_ITEMS) return { ok: false, error: `answers.${listKey}.${short} has too many items` }
      for (const item of v) {
        if (typeof item !== 'string') return { ok: false, error: `answers.${listKey}.${short} items must be strings` }
        if (item.length > MAX_LIST_ITEM_CHARS) return { ok: false, error: `answers.${listKey}.${short} has an oversized item` }
      }
      value[listKey][k] = v
    }
  }

  if (raw.meta !== undefined) {
    if (!isPlainObject(raw.meta)) return { ok: false, error: 'answers.meta must be an object' }
    let metaJson
    try { metaJson = JSON.stringify(raw.meta) } catch {
      return { ok: false, error: 'answers.meta is not serializable' }
    }
    if (metaJson.length > MAX_META_BYTES) return { ok: false, error: 'answers.meta is too large' }
    value.meta = raw.meta
  }

  return { ok: true, value }
}
