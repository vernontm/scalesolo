// POST /api/content/generate
// Body: { profile_id, format: 'tiktok-script'|'ig-post'|'thread'|'email-subject'|'carousel-outline'|'youtube-short',
//         topic, count?, platforms?, dry_run? }
//
// Generates 1..N pieces of content using Claude, persists each as a content_scripts
// row with needs_approval flag honoring the brand's agent_aggressiveness setting:
//   quiet      → all need approval
//   balanced   → all need approval (default safe)
//   aggressive → auto-approved (skips the queue)
// Debits ai_tokens proportional to total Claude usage.
//
// dry_run=true skips both the content_scripts insert and the content_history
// log — used by space-graph nodes that just need a Claude response to feed
// downstream and must NOT leave behind a draft row. Credits are still metered.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { message } from '../_lib/anthropic.js'
import { loadBrandContext, renderBrandContextMarkdown } from '../_lib/brand-context.js'
import { embedOne } from '../_lib/openai.js'

const FORMAT_HINT = {
  'tiktok-script':    'A TikTok script with a hook (first 3 seconds) + body (15-60 seconds of value) + CTA.',
  'ig-post':          'An Instagram caption with a strong hook line, 3-5 short paragraphs, 1 CTA, and 5-10 hashtags.',
  'thread':           'An X / Threads post — 3-7 numbered tweets, each <280 chars, a hook in #1, payoff in last.',
  'email-subject':    'Five email subject lines (newline-separated) optimized for opens. No clickbait.',
  'carousel-outline': 'An Instagram/LinkedIn carousel outline: title slide, 5-7 content slides (each one short paragraph), CTA slide.',
  'youtube-short':    'A YouTube Short script: hook, value, CTA — 30-60 seconds spoken.',
  'blog-post':        'A short blog post: title, intro, 3 body sections with H2 headers, conclusion, CTA.',
}

const SYSTEM = `You are a content writer for a brand. Your output must:
- Match the brand voice and audience defined in the brand bible verbatim.
- Be production-ready (no placeholders like [insert hook here]).
- Never use em dashes anywhere. Use commas, periods, or restructured sentences.
- Return a JSON object with keys: { "title": "...", "hook": "...", "full_script": "...", "caption": "...", "hashtags": "...", "first_comment": "..." }
  Always include title and full_script. Other fields are optional but encouraged.
- For email-subject format, return { "title": "Subjects", "full_script": "<5 lines>" }.
- Do NOT wrap the JSON in code fences. Output the JSON object only.`

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const {
      profile_id, format, topic, count = 1, platforms, target_length_secs, dry_run,
      structural_format, voice_model_id, avatar_id,
      // Remix mode — when set with reference_transcript, the system
      // prompt swaps from "write a fresh script on this topic" to
      // "rewrite this reference in the user's brand voice". Topic
      // becomes an optional angle hint.
      mode, reference_transcript, reference_meta,
    } = req.body || {}
    const isRemix = mode === 'remix' && typeof reference_transcript === 'string' && reference_transcript.trim().length > 30
    if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
    if (!isRemix && !topic) return res.status(400).json({ error: 'topic required' })
    if (!FORMAT_HINT[format]) return res.status(400).json({ error: `Unknown format: ${format}` })
    if (count < 1 || count > 10) return res.status(400).json({ error: 'count must be 1..10' })

    // Spoken-script length sizing. Average TikTok / short-form delivery is
    // ~150 wpm = 2.5 wps. We give Claude a target word count so the script
    // actually fits the duration the user picked instead of free-running.
    // Hard word-count ceilings per duration. We were overshooting the
    // target window because the previous prompt softly aimed for
    // "~150 wpm ± 12%", which gave the model permission to run long.
    // Real-world delivery on TikTok / Shorts averages ~3.3 words/sec;
    // the user wants clear caps, not a center-of-mass number:
    //   15s → ≤50 words   (≈3.3 wps)
    //   30s → ≤100 words  (≈3.3 wps)
    //   60s → ≤200 words  (≈3.3 wps)
    // Other durations slot proportionally.
    let lengthDirective = ''
    if ((format === 'tiktok-script' || format === 'youtube-short') && Number(target_length_secs) > 0) {
      const secs = Math.max(8, Math.min(180, Number(target_length_secs)))
      // Anchor on the three explicit bands the user named, then fall
      // back to the same 3.33 wps ratio for arbitrary durations.
      const maxWords = secs <= 15 ? 50
        : secs <= 30 ? 100
        : secs <= 60 ? 200
        : Math.round(secs * 3.33)
      lengthDirective = `\n\n## Target length (HARD CAP)\n` +
        `Aim for roughly ${secs} seconds of spoken delivery. ` +
        `**The full_script must be ${maxWords} words OR LESS.** This is a ceiling, not a target — ` +
        `coming in shorter is fine if the message is complete; going over is NOT allowed. ` +
        `Pace the content (hook → 2-3 beats of substance → CTA) so it lands inside the window without padding.`
    }

    await assertProfileAccess(auth.user.id, profile_id)

    // Pre-flight credit check
    const cust = await supaFetch(`billing_customers?user_id=eq.${auth.user.id}&select=id`)
    const customerId = cust?.[0]?.id
    if (customerId) {
      const pools = await supaFetch(`credit_pools?customer_id=eq.${customerId}&pool_type=eq.ai_tokens&select=balance`)
      if ((Number(pools?.[0]?.balance ?? 0)) < 1500 * count) {
        return res.status(402).json({ error: 'Insufficient AI tokens. Top up to continue.', code: 'insufficient_credits' })
      }
    }

    // Brand context: profile + voice summary + rated exemplars + hooks
    // + disliked patterns + hard rules, loaded in one parallel pass.
    // The renderer below stitches them into the same markdown blocks
    // we used to hand-build inline — see api/_lib/brand-context.js.
    const ctx = await loadBrandContext(profile_id)
    const profile = ctx.profile
    if (!profile) return res.status(404).json({ error: 'Profile not found' })

    const aggressiveness = profile.agent_aggressiveness || 'balanced'
    const autoApprove = aggressiveness === 'aggressive'

    // ── Uniqueness check: pull the most-similar past pieces for this brand
    // and feed them back so Claude doesn't restate them. Lowered the
    // similarity floor to 0.40 (was 0.55) and bumped the match count to
    // 10 because the original threshold was missing topically-similar
    // hooks ("if he wants to show up he will" written 5 different ways
    // rated 0.45-0.50 each — they should all read as 'you said this'
    // to the model). Also fetches the 12 most-recent rows
    // unconditionally so the model has a hard corpus to diff against
    // even when embeddings are noisy. Best-effort — if either query
    // fails we just generate without dedup context.
    let avoidBlock = ''
    let topicEmbedding = null
    try {
      const { embedding } = await embedOne(`Topic: ${topic}\nFormat: ${format}`)
      topicEmbedding = embedding
      const semantic = await supaFetch('rpc/match_content_history', {
        method: 'POST',
        body: {
          p_profile_id: profile_id,
          p_query_embedding: embedding,
          p_match_count: 10,
          p_min_similarity: 0.40,
          p_kinds: ['script', 'caption'],
        },
      }).catch(() => [])
      // Latest-by-time fallback. Embeddings catch semantic matches;
      // this catches "I literally wrote about this an hour ago".
      const recent = await supaFetch(
        `content_history?profile_id=eq.${profile_id}&kind=eq.script&order=created_at.desc&limit=12&select=text,topic,created_at`
      ).catch(() => [])
      const seen = new Set()
      const merged = []
      for (const m of (Array.isArray(semantic) ? semantic : [])) {
        const k = String(m.text || '').slice(0, 200)
        if (seen.has(k)) continue
        seen.add(k); merged.push({ kind: 'similar', text: m.text, similarity: m.similarity })
      }
      for (const r of (Array.isArray(recent) ? recent : [])) {
        const k = String(r.text || '').slice(0, 200)
        if (seen.has(k)) continue
        seen.add(k); merged.push({ kind: 'recent', text: r.text, topic: r.topic })
      }
      if (merged.length) {
        avoidBlock = `\n\n## Previously written for this brand — DO NOT restate the angles, examples, hooks, or core talking points from any of these:\n` +
          merged.slice(0, 16).map((m, i) => `${i + 1}. ${String(m.text || '').slice(0, 240).replace(/\s+/g, ' ')}…`).join('\n') +
          `\n\nRULES — read carefully:` +
          `\n- "Don't repeat" means at the IDEA level, not just word level. If the previous script's central insight was "his actions tell you who he is", DON'T write a script with that same insight phrased differently.` +
          `\n- Pick a different angle: a different scenario, a different lesson, a different emotional beat, a different platform-native format (story-time vs hot take vs myth-bust vs before/after).` +
          `\n- If you find yourself reaching for a thesis you've already used, switch the framing entirely (e.g. flip from "what to avoid" to "what to do instead").` +
          `\n- Use a fresh hook in the first sentence — different setup, different word choice.` +
          `\n- Stay on the brand's voice + niche, but the SUBSTANCE must be new.`
      }
    } catch (e) {
      console.warn('content_history dedup skipped:', e.message)
    }

    // Structural format pin. When the caller sets structural_format
    // (e.g. 'story' / 'listicle' / 'hot_take'), look up the directive
    // from the script_formats catalog and prepend it to the prompt.
    // No-op when blank — Claude picks a shape on its own.
    let structuralBlock = ''
    if (structural_format) {
      try {
        const fmt = await supaFetch(
          `script_formats?key=eq.${encodeURIComponent(structural_format)}&active=eq.true&select=label,prompt_directive&limit=1`
        )
        if (fmt?.[0]) {
          structuralBlock = `\n\n## Structural format (pinned)\n${fmt[0].label}: ${fmt[0].prompt_directive}\n\nFollow this shape precisely. The hook archetype rotation below applies WITHIN this structure.`
        }
      } catch (e) { console.warn('structural_format lookup failed:', e?.message) }
    }

    // ── ElevenLabs v3 expression-tag mode ────────────────────────────────
    // When this script is destined for an avatar voiced via the v3 model
    // (either passed in directly via voice_model_id, or resolved via
    // avatar_id), prepend a directive that teaches Claude the v3 inline
    // tag vocabulary. Tags are zero-cost on Turbo / Multilingual (the
    // model just renders them literally if they slip through), so we
    // only flip this on for explicit v3.
    let resolvedVoiceModel = voice_model_id || null
    if (!resolvedVoiceModel && avatar_id) {
      try {
        const aRows = await supaFetch(`avatars?id=eq.${avatar_id}&select=voice_model_id`)
        resolvedVoiceModel = aRows?.[0]?.voice_model_id || null
      } catch {}
    }
    let v3TagsBlock = ''
    if (resolvedVoiceModel === 'eleven_v3') {
      v3TagsBlock = `\n\n## ElevenLabs v3 expression tags (THIS SCRIPT WILL BE VOICED BY ELEVENLABS V3)
Add inline emotion / pacing tags inside the script body so the voice
delivery matches the meaning. Use sparingly — 2 to 5 tags per ~30 sec
of speech is usually right; over-tagging makes delivery feel forced.
Place tags directly before the affected words, in square brackets.

Approved tag vocabulary:
- Emotion: [whispers], [sighs], [laughs], [laughs softly], [excited],
  [tired], [crying], [angry], [confused], [thoughtful], [serious]
- Breath / mouth: [exhales], [inhales], [clears throat], [snorts]
- Pacing: [short pause], [long pause]
- Style framing at line start: [warm], [matter-of-fact], [conspiratorial]

Examples of GOOD use:
  "[whispers] You don't want what you say you want. [short pause]
   And your behavior is telling the truth your mouth will not."

  "I used to think discipline was the answer. [sighs] It wasn't."

DO NOT:
- Tag every line — let the voice breathe.
- Use tags outside the approved list above.
- Use stage directions like [points at camera] — these are voice tags
  only, the avatar's video already has its own gestures.`
    }

    // Brand voice blocks — bible + summary + exemplars + good hooks +
    // disliked patterns + hard rules — all rendered through the shared
    // helper. Identity header is rendered separately below so the
    // section ordering stays the same as the previous hand-built prompt.
    const brandBibleAndVoiceBlocks = renderBrandContextMarkdown(ctx, {
      include: ['bible', 'summary', 'exemplars', 'hooks', 'bad_patterns', 'rules'],
      bibleCharLimit: 2000,
    })

    // Hook archetype rotation — solves the "every script starts with
    // 'If he…'" pattern even when the brand has no saved hooks. Pick
    // one archetype per generation, rotated by variation index, so a
    // count=10 batch covers 10 different opener shapes.
    const HOOK_ARCHETYPES = [
      'Direct address ("You\'re going to lose her if…")',
      'Counterintuitive claim ("Most advice on X is wrong because…")',
      'Confession ("I used to think X. Here\'s what changed.")',
      'Sharp observation ("The thing nobody talks about: …")',
      'Statistic / number ("9 out of 10 [audience] do X. Here\'s why it backfires.")',
      'Question to the viewer ("What if X were actually Y?")',
      'Mini-story scene ("She walked in, dropped the keys, and said one thing that…")',
      'Comparison / contrast ("There are two kinds of [audience]. Which one are you?")',
      'Promise + curiosity ("In 30 seconds I\'m going to show you…")',
      'Bold imperative ("Stop doing X. Here\'s what to do instead.")',
    ]

    // Identity header is rendered up here so brandBibleAndVoiceBlocks
    // can be the cacheable suffix — Claude's prompt cache rewards a
    // stable string, and the brand context blocks change far less
    // often than the per-call topic / format directives.
    const identityHeader =
      `## Brand: ${profile.business_name || 'this brand'}` +
      (profile.preferred_tone ? `\nVoice: ${profile.preferred_tone}` : '') +
      (profile.target_audience ? `\nAudience: ${profile.target_audience}` : '')
    // Remix mode adds a directive that flips the model's job from
    // "write fresh on a topic" to "rewrite this transcript in the
    // user's voice while preserving its hook + structure". The full
    // brand context block above still applies — that's what makes
    // the remix sound like the user, not a generic adaptation.
    const remixBlock = isRemix
      ? `\n\n## Remix mode (RE-WRITE, do not invent)
A reference transcript is provided in the user message. Your job is
to rewrite it in this brand's voice. Preserve:
  - the original hook archetype (if it works for this brand)
  - the structural beats (same number of beats, same ordering)
  - the CTA shape

Replace:
  - vocabulary that doesn't match this brand
  - examples that don't fit the brand's audience
  - any phrasing that violates the brand rules above
  - the language register (formal/casual/etc.) when it clashes with the brand's tone

The output must read as if THIS brand wrote it from scratch — not as
a translation, not as a parody. If a beat in the original directly
contradicts the brand's voice or rules, drop or rework it. Quote the
original's hook archetype label in your reasoning if helpful, but
NOT in the output.`
      : ''

    const systemPrompt = `${SYSTEM}

${identityHeader}${brandBibleAndVoiceBlocks}${structuralBlock}${v3TagsBlock}${remixBlock}

## Format
${FORMAT_HINT[format]}${lengthDirective}${avoidBlock}

## Opener variety (CRITICAL)
This brand has been using the SAME opener archetype repeatedly. You
MUST rotate. For THIS specific generation, pick from the archetypes
below — DO NOT default to a conditional "If [pronoun] [verb]…"
opener unless the user's saved hooks above demonstrate they
specifically prefer it.

Hook archetypes (rotate across generations — pick based on the
variation index):
${HOOK_ARCHETYPES.map((a, i) => `${i + 1}. ${a}`).join('\n')}

If the brand owner has saved approved hooks above, prefer one of
those (rotate within them). Otherwise pick an archetype from the
list and write a hook in that shape — explicitly DIFFERENT from any
opener in the "Previously written for this brand" list.`

    let totalUsage = { input: 0, output: 0 }

    // Fan out the Claude calls in parallel — each variation is
    // independent. Sequential `for await` was 30-60s wall time at
    // count=10 because we waited for each response before starting
    // the next; this drops total time to roughly the slowest call.
    // Anthropic's per-account concurrency limit is the only ceiling.
    const claudePromises = Array.from({ length: count }, (_, i) => {
      // Force a different opener archetype index per variation so a
      // batch of 10 doesn't all converge on the same hook shape. The
      // archetype list is in the system prompt; pick by index here.
      const archetypeIdx = i % 10
      // Remix mode: the reference transcript carries the substance;
      // topic (when set) is just an angle hint. Stuff the transcript
      // in a fenced block so prompt injection inside it lands as
      // data, not instructions.
      const remixHeader = isRemix
        ? `Reference transcript${reference_meta?.creator_handle ? ` (from @${reference_meta.creator_handle})` : ''}:\n"""\n${String(reference_transcript).slice(0, 6000)}\n"""\n\n${topic ? `Angle hint from the user: ${topic}\n\n` : ''}`
        : ''
      const variationLine = count === 1
        ? (isRemix
            ? `Rewrite the reference above in this brand's voice. Use opener archetype #${archetypeIdx + 1} from the list.`
            : `For THIS script, use opener archetype #${archetypeIdx + 1} from the list. Write the hook in that shape.`)
        : (isRemix
            ? `This is variation ${i + 1} of ${count} of the same remix. Use opener archetype #${archetypeIdx + 1} — every variation must use a DIFFERENT archetype.`
            : `This is variation ${i + 1} of ${count}. Use opener archetype #${archetypeIdx + 1} from the list — every variation in this batch must use a DIFFERENT archetype. Make the script substantively distinct from the others (different angle, different example, different lesson — not just different words).`)
      const userPrompt = isRemix
        ? `${remixHeader}${variationLine}`
        : `Topic: ${topic}\n\n${variationLine}`
      return message({
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        max_tokens: 1500,
      }).then((resp) => {
        if (resp?.usage) {
          totalUsage.input  += resp.usage.input_tokens  || 0
          totalUsage.output += resp.usage.output_tokens || 0
        }
        const text = resp?.content?.[0]?.text || ''
        // Strip markdown code fences before JSON extraction. Claude
        // periodically wraps responses in ```json blocks even though
        // the prompt forbids it; if we don't pre-strip those, the
        // greedy {...} match can include the trailing ``` or grab the
        // wrong block, JSON.parse blows up, and the catch path stuffs
        // the entire raw response (including the markdown fences and
        // field names) into full_script — which then leaks straight
        // out as the post caption on TikTok / IG / etc.
        const cleaned = text
          .replace(/```json\s*/gi, '')
          .replace(/```\s*/g, '')
          .trim()
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/)?.[0]
        let parsed = {}
        if (jsonMatch) {
          try { parsed = JSON.parse(jsonMatch) }
          catch { /* fall through to text fallback below */ }
        }
        // Fallback: parse failed or no JSON block. Salvage what we
        // can. Even when parse fails we never want to ship the raw
        // JSON dump (curly braces, field names) downstream — strip
        // those first so the resulting full_script reads as prose.
        if (!parsed.full_script && !parsed.title && !parsed.caption) {
          const stripped = cleaned
            .replace(/^[\s\S]*?"full_script"\s*:\s*"/i, '')
            .replace(/",\s*"[a-z_]+"\s*:[\s\S]*$/i, '')
            .replace(/\\n/g, '\n')
            .replace(/\\"/g, '"')
            .trim()
          parsed = { full_script: stripped || cleaned }
        }
        return { parsed, text }
      })
    })
    const claudeResults = await Promise.all(claudePromises)

    // Persist + log to content_history sequentially. The DB inserts are
    // cheap and embedding throughput on small text is fine; doing them
    // in order also produces a deterministic `created` ordering.
    const created = []
    for (const { parsed, text } of claudeResults) {
      const row = {
        profile_id,
        title: parsed.title || `${format} — ${topic}`.slice(0, 80),
        hook: parsed.hook || null,
        full_script: parsed.full_script || text,
        caption: parsed.caption || null,
        hashtags: parsed.hashtags || profile.core_hashtags || null,
        first_comment: parsed.first_comment || null,
        media_type: format === 'carousel-outline' ? 'carousel' : (format === 'tiktok-script' || format === 'youtube-short' ? 'video' : 'text'),
        post_type: 'post',
        platforms: platforms || null,
        status: 'draft',
        needs_approval: !autoApprove,
        approval_status: autoApprove ? 'approved' : 'pending',
        approved_by: autoApprove ? auth.user.id : null,
        approved_at: autoApprove ? new Date().toISOString() : null,
        generated_by: 'agent',
        generation_prompt: `${format}: ${topic}`,
      }
      let item
      if (dry_run) {
        item = { ...row, id: null, dry_run: true }
        created.push(item)
      } else {
        const insertRows = await supaFetch('content_scripts', { method: 'POST', body: row })
        item = Array.isArray(insertRows) ? insertRows[0] : insertRows
        created.push(item)
        try {
          const scriptText = parsed.full_script || text
          const { embedding } = await embedOne(scriptText.slice(0, 4000))
          await supaFetch('content_history', {
            method: 'POST',
            prefer: 'return=minimal',
            body: {
              profile_id,
              content_id: item?.id || null,
              kind: 'script',
              topic,
              text: scriptText.slice(0, 8000),
              embedding,
              source: 'agent',
            },
          })
        } catch (e) { console.warn('content_history insert failed:', e.message) }
      }
    }

    // Meter credits
    if (customerId && totalUsage.input + totalUsage.output > 0) {
      const total = totalUsage.input + totalUsage.output
      try {
        await supaFetch('rpc/consume_credits', {
          method: 'POST',
          body: {
            p_customer_id: customerId,
            p_pool_type: 'ai_tokens',
            p_amount: total,
            p_action: 'consume:content-generate',
            p_ref_table: 'content_scripts',
            p_ref_id: created.map((c) => c.id).filter(Boolean).join(',') || null,
            p_profile_id: profile_id,
            p_metadata: { format, topic, count, dry_run: !!dry_run, ...totalUsage },
          },
        })
      } catch (e) {
        console.warn('credit consume failed:', e.message)
      }
    }

    return res.status(200).json({ items: created, auto_approved: autoApprove, usage: totalUsage })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
