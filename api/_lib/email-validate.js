// Pre-send validation for campaign templates.
//
// One shared check so the Email page, the API and any MCP tool all refuse the
// same broken email. A merge tag that does not resolve is not cosmetic: it
// reaches the subscriber as literal braces, and a mistyped unsubscribe tag
// ships a dead unsubscribe link, which is a CAN-SPAM problem and the fastest
// route to spam complaints.
//
// Real example this exists to stop (2026-10-24): a campaign used
// {first_name} with single braces and {{UNSUBSCRIBE}} instead of
// {{unsubscribe_url}}. Single braces are never substituted, and because the
// HTML already contained the word "unsubscribe", renderCampaignEmail skipped
// appending its own footer, so there was no fallback link either.

// Every variable mergeVarsFor() provides. Keep in step with email-render.js.
export const MERGE_VARS = [
  { tag: 'first_name', what: "Contact's first name. Falls back to \"there\" when unknown." },
  { tag: 'name', what: "Contact's full name. Falls back to \"there\"." },
  { tag: 'email', what: "Contact's email address." },
  { tag: 'business', what: 'The brand name.' },
  { tag: 'unsubscribe_url', what: 'The real one-click unsubscribe link. Required if you write your own footer.' },
]

const KNOWN = new Set(MERGE_VARS.map((v) => v.tag))

// Cheap edit distance so "firstname" or "first_nme" suggests "first_name"
// instead of just being rejected.
function closest(word) {
  const w = word.toLowerCase()
  // A prefix match beats edit distance: "unsubscribe" is 4 edits from
  // "unsubscribe_url", past any sane threshold, but it is obviously what the
  // author meant. Same for someone writing {{first}} for {{first_name}}.
  for (const k of KNOWN) {
    if (k.startsWith(w) || w.startsWith(k)) return k
  }
  let best = null
  let bestScore = Infinity
  for (const k of KNOWN) {
    const d = distance(w, k)
    if (d < bestScore) { bestScore = d; best = k }
  }
  return bestScore <= Math.max(2, Math.floor(w.length / 3)) ? best : null
}

function distance(a, b) {
  const m = a.length; const n = b.length
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/**
 * Check a campaign's subject + body before it can be sent or scheduled.
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 *   errors block sending; warnings are shown but do not block.
 */
export function validateTemplate({ subject = '', html = '', previewText = '' } = {}) {
  const errors = []
  const warnings = []
  const all = `${subject}\n${previewText}\n${html}`

  if (!String(subject).trim()) errors.push('Add a subject line.')
  if (!String(html).trim()) errors.push('The email body is empty.')

  // 1. Unknown {{tags}}. These reach the subscriber as literal braces.
  const unknown = new Map()
  for (const m of all.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)) {
    const raw = m[1]
    const key = raw.toLowerCase()
    if (KNOWN.has(key)) continue
    if (!unknown.has(raw)) unknown.set(raw, closest(raw))
  }
  for (const [raw, suggestion] of unknown) {
    errors.push(
      `{{${raw}}} is not a merge tag, so it will be sent as literal text.` +
      (suggestion ? ` Did you mean {{${suggestion}}}?` : ' Replace it with a real value, or use one of the tags listed below.')
    )
  }

  // 2. Single braces. The most common mistake, and silent: the regex that
  //    does substitution only matches {{double}}.
  const singles = new Set()
  for (const m of all.matchAll(/(?<!\{)\{\s*([a-z_][a-z0-9_]*)\s*\}(?!\})/gi)) {
    const key = m[1].toLowerCase()
    if (KNOWN.has(key)) singles.add(m[1])
  }
  for (const s of singles) {
    errors.push(`{${s}} uses single braces and will never be filled in. Write {{${s.toLowerCase()}}} instead.`)
  }

  // 3. The unsubscribe trap. renderCampaignEmail only appends its own footer
  //    when the body does NOT already mention unsubscribe. So a body that
  //    says "unsubscribe" without a working {{unsubscribe_url}} ships with no
  //    usable link at all and no fallback.
  const mentionsUnsub = /unsubscribe/i.test(html)
  const hasUnsubTag = /\{\{\s*unsubscribe_url\s*\}\}/i.test(html)
  if (mentionsUnsub && !hasUnsubTag) {
    errors.push(
      'Your email has its own unsubscribe link but no {{unsubscribe_url}} tag. ' +
      'ScaleSolo only adds its own footer when the body does not mention unsubscribe, so this would send with a dead link. ' +
      'Point the link at {{unsubscribe_url}}.'
    )
  }

  // 4. Images that cannot load in an inbox. An email client fetches every
  //    image over the public internet from a cold cache, so anything that is
  //    not an absolute https URL renders as a broken box for the subscriber
  //    while looking perfect in the composer preview (the browser resolves a
  //    relative path against scalesolo.ai, and a data: URI survives the
  //    preview iframe but is stripped by Gmail and Outlook).
  for (const m of html.matchAll(/<img\b[^>]*?\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const src = String(m[2] ?? m[3] ?? m[4] ?? '').trim()
    if (!src) {
      errors.push('An <img> has an empty src, so it will show as a broken image. Upload the image and use the URL it gives you.')
      continue
    }
    if (/^\{\{/.test(src)) continue            // a merge tag resolves later
    if (/^https:\/\//i.test(src)) continue     // the only thing that works everywhere
    if (/^data:/i.test(src)) {
      errors.push('An <img> uses an inline data: URI. Gmail and Outlook strip those, so the image will not appear. Upload it instead and use the URL you get back.')
    } else if (/^http:\/\//i.test(src)) {
      errors.push(`An <img> loads over plain http (${src.slice(0, 60)}). Many clients block that as insecure, so use the https URL.`)
    } else if (/^(cid|file):/i.test(src)) {
      errors.push(`An <img> points at ${src.split(':')[0]}:, which only resolves on the machine that wrote the email. Upload the image and use its public URL.`)
    } else {
      errors.push(`An <img> has a relative src (${src.slice(0, 60)}). An inbox has no page to resolve that against, so upload the image and use the full https URL.`)
    }
  }

  // 5. Obvious leftovers from a template.
  for (const m of all.matchAll(/\b(PASTE_[A-Z_]+|REPLACE_ME|YOUR_LINK_HERE|TODO)\b/g)) {
    errors.push(`"${m[1]}" is still a placeholder. Replace it with the real value.`)
  }

  // 6. An href that never got a URL would be a dead call to action.
  for (const m of html.matchAll(/href\s*=\s*["']\s*(#|)\s*["']/gi)) {
    warnings.push('A link has an empty href, so clicking it does nothing.')
    break
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)] }
}

// One-line reference for error messages and MCP tool output.
export function mergeVarHelp() {
  return MERGE_VARS.map((v) => `{{${v.tag}}} ${v.what}`)
}
