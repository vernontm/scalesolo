// Cap a hashtags string to at most `max` tags (default 5), regardless of what
// the model returned. Handles "#a #b", "a, b", or mixed input and always
// returns space-separated "#tag" tokens. Central chokepoint so every content
// path (bulk-actions, generate-month, campaigns, etc.) stores the same limit.

export const MAX_HASHTAGS = 5

export function capHashtags(raw, max = MAX_HASHTAGS) {
  if (!raw) return raw || null
  const hashed = String(raw).match(/#[\p{L}\p{N}_]+/gu)
  const tokens = (hashed && hashed.length)
    ? hashed
    : String(raw).split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith('#') ? t : '#' + t))
  const capped = tokens.slice(0, max).join(' ')
  return capped || null
}
