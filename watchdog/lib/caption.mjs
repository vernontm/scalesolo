// Decide whether a LIVE post's caption is acceptable.
//
// This is the heart of the watchdog: given the caption text we scraped
// from the real published post, say whether it is a genuine caption with
// hashtags, or junk that should never have gone out (empty, or a leftover
// transcript / music tag like "[outro jingle]", or missing hashtags).
//
// It is deliberately conservative: we only return NOT-ok when we are
// confident something is wrong, because a false positive here sends an
// URGENT text to a real person.

// Phrases that, when they make up essentially the whole caption, mean a
// raw transcript / audio description leaked in place of a real caption.
// (This is the exact class of bug the app-side fix prevents at the source;
//  this watchdog is the last line of defense for anything that slips by.)
const AUDIO_TAG_PATTERNS = [
  /\boutro\s+jingle\b/i,
  /\bintro\s+jingle\b/i,
  /\bon[-\s]?hold\s+music\b/i,
  /\bbackground\s+music\b/i,
  /\bupbeat\s+music\b/i,
  /\bsoft\s+music\b/i,
  /\bambient\s+music\b/i,
  /\bmusic\s+playing\b/i,
  /\bno\s+speech\b/i,
  /\binaudible\b/i,
  /\binstrumental\b/i,
  /\[\s*music\s*\]/i,
]

// A caption that is nothing but a single [bracketed] or (parenthetical)
// tag, e.g. "[outro jingle]" or "(on-hold music)".
const BRACKET_ONLY = /^[\s]*[[(][^\])]{0,80}[\])][\s]*$/

// Count "real" content characters (letters/digits), ignoring #, @, emoji,
// punctuation and whitespace. Used to tell a real caption from a stub.
function contentChars(s) {
  return (s.match(/[A-Za-z0-9]/g) || []).length
}

function wordCount(s) {
  return (s.trim().match(/\S+/g) || []).length
}

/**
 * @param {object} args
 * @param {string} args.caption   Scraped caption text (may include inline #tags).
 * @param {string[]} [args.hashtags] Hashtags scraped as a separate field, if any.
 * @param {string} [args.platform] tiktok | instagram | youtube
 * @param {boolean} [args.requireHashtags=true] Flag posts with no hashtags.
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function evaluateCaption({ caption, hashtags = [], platform = '', requireHashtags = true }) {
  const reasons = []
  const text = String(caption || '').trim()

  if (!text) {
    reasons.push('caption is empty')
    // No text at all: nothing more to check, hashtags are moot.
    return { ok: false, reasons }
  }

  if (BRACKET_ONLY.test(text)) {
    reasons.push(`caption is just a placeholder tag: "${text.slice(0, 60)}"`)
  } else {
    // Whole-caption audio/transcript tag (short caption dominated by the tag).
    const looksLikeAudioTag = AUDIO_TAG_PATTERNS.some((re) => re.test(text))
    if (looksLikeAudioTag && wordCount(text) <= 5) {
      reasons.push(`caption looks like a leftover transcript/music tag: "${text.slice(0, 60)}"`)
    }
    // Caption with no readable letters (only symbols / emoji / numbers).
    if (contentChars(text) < 3 || !/[A-Za-z]/.test(text)) {
      reasons.push('caption has no readable text')
    }
  }

  // Hashtags: present inline in the caption, or in a separate scraped field.
  const hasInlineTag = /#\w/.test(text)
  const hasFieldTag = Array.isArray(hashtags) && hashtags.some((h) => String(h || '').replace(/^#/, '').trim())
  if (requireHashtags && !hasInlineTag && !hasFieldTag) {
    reasons.push('post has no hashtags')
  }

  return { ok: reasons.length === 0, reasons }
}
