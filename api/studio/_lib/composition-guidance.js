// Per-template guidance string for Claude prompts that pick compositions
// and fill their variables. Variable slot names differ between templates
// (Sleek: title_chrome/title_accent ; Atlas: title_pre/title_highlight),
// so any prompt that mentions composition slots MUST resolve through this
// helper instead of hardcoding Sleek terminology.
//
// Two consumers today: api/studio/generate-map.js (initial segmentation)
// and api/studio/refresh-motion-graphics.js (pre-render motion refresh).
// Keep both pointing at this single source of truth.

export function buildCompositionGuidance(tmpl) {
  if (tmpl?.id === 'atlas') {
    return `Choosing the right HyperFrames composition (Atlas v1 — four options, pick by content shape):

- atlas-scene-headline-v1: any "big text on screen" moment. Use for
  titles, single-line punchlines, quotes, AND stat reveals. The
  composition has two slots that render side-by-side:
    title_pre        → the lead-in phrase (white chrome gradient)
    title_highlight  → the punchy word / number / brand name (indigo→purple sweep)
  Examples:
    Script: "We grew 10x." → title_pre:"We grew", title_highlight:"10x"
    Script: "The future is one person with a stack." → title_pre:"The future is", title_highlight:"one person"

- atlas-scene-list-v1: enumerated lists. Set:
    list_title_pre / list_title_highlight — same chrome+highlight pair
    items — JSON array (STRING) of {text, accent?}, max 5 entries
  The composition auto-numbers them with gradient circle badges.
  items array length MUST match the actual count of items in
  script_text. If the avatar says "voice, video, and image" → 3
  entries, not 5. If 6+ items, split into two segments.

- atlas-scene-claude-chat-v1: when the script literally describes
  the speaker prompting / asking / telling Claude something. Shows
  a Claude.ai-style chat UI with the user's prompt and Claude's reply
  typing out word-by-word. Slots:
    user_message     — what the speaker said to Claude. Quote it
                       verbatim from the script. Strip "I told Claude"
                       framing. Example: script "I told Claude to build
                       me a React CRM" → user_message: "Build me a
                       React CRM."
    claude_response  — what Claude said back. If the script doesn't
                       state it, write a short, on-brand reply (2-3
                       sentences, Claude voice).
  Use ONLY when the script explicitly names Claude.

- atlas-scene-cta-v1: the LAST segment of the video only. Slots:
    cta_headline_pre / cta_headline_highlight — final headline pair
    cta_subhead — one-line description under the headline
    cta_button_text — the button label, e.g. "Link In Description"
    hero_handle — big @handle bottom-center, defaults to brand handle

These are the only four compositions. Use atlas-scene-headline-v1 for
anything that would have been a quote-card, stat-reveal, or title-card.

List-item counting rule:
- The items array passed to atlas-scene-list-v1 MUST be the literal
  count of things mentioned in the script. If the avatar enumerates
  "voice, video, and image generation" → exactly 3 items. Never pad,
  never shrink.`
  }

  // Sleek (default).
  return `Choosing the right HyperFrames composition (Sleek v2 — four options, pick by content shape):

- sleek-scene-headline-v1: any "big text on screen" moment. Use for
  titles, single-line punchlines, quotes, AND stat reveals. The
  composition has two slots that render side-by-side:
    title_chrome   → the lead-in phrase (white chrome gradient)
    title_accent   → the punchy word / number / brand name (red glow)
  Examples:
    Script: "We grew 10x." → title_chrome:"We grew", title_accent:"10x"
    Script: "The future is one person with a stack." → title_chrome:"The future is", title_accent:"one person"
    Script: "Here's the thing." → title_chrome:"Here's", title_accent:"the thing"
  Optional: subtitle (one line under the headline), eyebrow (small
  red label above headline).

- sleek-scene-list-v1: enumerated lists. Set:
    list_title_chrome / list_title_accent — same chrome+accent pair
    items — JSON array (STRING) of {text, highlight?}, max 5 entries
  The composition auto-numbers them 01, 02, 03 from the array order.
  items array length MUST match the actual count of items in
  script_text. If the avatar says "voice, video, and image" → 3
  entries, not 5. If 6+ items, split into two segments.

- sleek-scene-claude-chat-v1: when the script literally describes
  the speaker prompting / asking / telling Claude something. Shows
  a Claude.ai-style chat UI with the user's prompt and Claude's reply
  typing out word-by-word. Slots:
    user_message     — what the speaker said to Claude. Quote it
                       verbatim from the script. Strip "I told Claude"
                       framing and keep only what was actually asked.
                       Example: script "I told Claude to build me a
                       React CRM" → user_message: "Build me a React
                       CRM."
    claude_response  — what Claude said back. If the script doesn't
                       state Claude's actual response, write a short,
                       on-brand reply (2-3 sentences, Claude voice).
                       Example: "I will set up a clean React + Supabase
                       project with auth and a deal pipeline. Let me
                       scaffold the schema first."
  Use ONLY when the script names Claude or describes prompting an AI.
  Don't use this for generic "AI did X" — needs explicit Claude mention.

- sleek-scene-cta-v1: the LAST segment of the video only. Slots:
    cta_headline_chrome / cta_headline_accent — final headline pair
    cta_subhead — one-line description under the headline
    cta_button_text — the button label, e.g. "Link In Description"
    hero_handle — big @handle bottom-center, defaults to brand handle
    eyebrow — optional small red label above headline

These are the only three compositions. There is no quote-card,
stat-reveal, comparison, lower-third, title-card, or end-card. Use
sleek-scene-headline-v1 for anything that would have been one of those.

List-item counting rule:
- The items array passed to sleek-scene-list-v1 MUST be the literal
  count of things mentioned in the script. If the avatar enumerates
  "voice, video, and image generation" → exactly 3 items. Never pad
  to make it longer, never shrink. If the script doesn't enumerate
  but loosely lists, pick the items count that fits the spoken content.`
}
