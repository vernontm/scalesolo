# Vernon Tech & Media — Content Playbook (rayvaughn.ceo)

This file is the operating manual for a Claude Code session running content production for Rayvaughn's personal brand. Read this whole file before writing a single post.

## Mandatory reference files (read these first)

The persona, copy voice, and brand visual rules live in the user's `~/.claude` project memory and are auto-loaded when this project is opened:

- **Persona** — `feedback_vtm_persona.md` — who Rayvaughn is, who the audience is, the POV every post is written from. Page = personal brand, VTM = parent company, ScaleSolo = one product of many.
- **Copy voice** — `feedback_vtm_copy_voice.md` — voice patterns, the reframe shape, mechanical rules (no em-dashes, no contractions, short declaratives).
- **Threads voice anchors** — `feedback_vtm_threads_examples.md` — actual threads that landed. Reference these for tone matching. The 10-like winner is the bar.
- **Brand visuals** — `feedback_vtm_brand_visuals.md` — canvas, background, logos (locked sizes), typography (locked sizes), only-white-and-orange rule.

If any post sounds like a dev blog, a generic AI-hype post, or a corporate brand voice, rewrite it.

## Production setup

### Spaces (canvases) in use

- **Carousel Generator** (`51b690e1-efff-4389-b900-8d8b65553923`) — handles carousels AND single-image posts. 7 image_gen nodes wired to one `save_library`, plus a `manual_caption` node also wired to `save_library` so the title / caption / hashtags / first comment ride along into the saved draft.
  - For a 7-slide carousel: wire all 7 image_gens to save_library.
  - For a 5-slide carousel: only wire 5; leave the others unconnected.
  - For a single-image post: wire 1 image_gen.
  - For a text-only post: use the Text-Only space (below) instead.
- **Text-Only Space** (planned, not yet built) — `manual_caption` → `save_library`. No image gens. For threads, X long-form, FB text posts.

### Save behavior

When `save_library` runs without a `schedule_post` downstream, it now writes a row to `content_scripts` directly. The row's status comes from the SaveBody dropdown:
- `draft` (default) — lands on the Drafts tab in the Content page.
- `caption_ready` — auto-promotes to the next open `scheduled` slot if media is present.

The `manual_caption` node feeds title / caption / hashtags / first_comment into the same bundle. Whatever you type there shows up on the saved draft.

## Cadence — Month 1

- 2 posts per day, every day, on each platform.
- Minimum 10 posts per week of new content. Carousels can be re-used as a thread (slide copy → thread post) or as an X long-form, which extends a single carousel's reach.
- One carousel per week is the visual anchor. The rest of the week is threads + single-image posts.

## Workflow loop (how a session runs)

1. User says: **"start week N"** (or "next post").
2. Claude pulls this file + the memory files, drafts that week's content list as a scannable table (see Week 1 below for format).
3. User reviews, requests edits, says **"approved"**.
4. User says **"patch post 1"**.
5. Claude rewrites the right space's nodes via SQL (template below). For carousels: image_gen prompts. For threads / singles / captions: manual_caption fields. Confirm node count matches the post type (carousel needs 1–7 image gens connected; single needs 1; thread needs 0).
6. User says **"refresh"** — they reload the canvas, hit Run.
7. Run completes, save_library writes the draft.
8. User says **"next"** — Claude patches post 2.
9. Repeat until the week's drafts are all in the Content library, then user schedules them from the Content page.

## SQL patch templates

### Patching the Carousel Generator's image_gen prompts

Image_gen node ids in the Carousel Generator space (slide order = canvas left-to-right):

```
slot 1 (cover):  n_mp74ryy3_iv6p
slot 2 (body):   n_mp754l8l_0_9rw
slot 3 (body):   n_mp754nfz_0_t3m
slot 4 (body):   n_mp754vgi_0_bdy
slot 5 (cta):    n_mp754xd0_0_85e
slot 6 (body):   n_mp754xoz_0_sjj
slot 7 (body):   n_mp754y6j_0_zhi
```

When patching for a new carousel:
- Cover prompt → slot 1 node.
- Body prompts → slots 2, 3, 4, 6, 7 (5 body slots available).
- CTA prompt → slot 5.
- For shorter carousels (e.g. 5 slides): only patch the slots you'll use; the unused image_gen nodes can be disconnected from save_library on the canvas.

Patch template (one node at a time):

```sql
UPDATE spaces SET
  nodes = (
    SELECT jsonb_agg(
      CASE WHEN n->>'id' = '<NODE_ID>'
        THEN jsonb_set(n, '{data,props,prompt}', to_jsonb($prompt$<NEW PROMPT TEXT>$prompt$::text))
        ELSE n
      END
    )
    FROM jsonb_array_elements(nodes) n
  ),
  updated_at = now()
WHERE id = '51b690e1-efff-4389-b900-8d8b65553923';
```

### Patching the manual_caption node in the Carousel Generator

```
manual_caption node id: n_caption_w1_001
```

```sql
UPDATE spaces SET
  nodes = (
    SELECT jsonb_agg(
      CASE WHEN n->>'id' = 'n_caption_w1_001'
        THEN jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(n, '{data,props,title}',         to_jsonb($t$<TITLE>$t$::text)),
              '{data,props,caption}',                    to_jsonb($c$<CAPTION>$c$::text)),
            '{data,props,hashtags}',                     to_jsonb($h$<HASHTAGS>$h$::text)),
          '{data,props,first_comment}',                  to_jsonb($f$<FIRST COMMENT>$f$::text))
        ELSE n
      END
    )
    FROM jsonb_array_elements(nodes) n
  ),
  updated_at = now()
WHERE id = '51b690e1-efff-4389-b900-8d8b65553923';
```

### Prompt skeletons (use these verbatim, fill in the content)

The visual constraints in `feedback_vtm_brand_visuals.md` are already enforced inside the current image_gen prompts. When swapping content for a new carousel, only the headline / title / body / punchline strings change — everything else (canvas, background, logos, typography, hard negatives) stays exactly as-is. Copy the existing prompt for that slot and edit only the content fields.

## Month 1 plan (Introduction)

The goal of Month 1 is **trust + introduction**, not product pitching. ScaleSolo barely gets mentioned until Week 3. Lean hard into the threads-that-landed voice: reframe, self-disclosure, "that is what I do" closes.

| Week | Theme | Why this week |
|------|-------|---------------|
| W1   | Who I am, why I build | Audience meets Rayvaughn. Set the POV. |
| W2   | The pain solopreneurs feel | Show you see them. Reframe + self-disclosure. |
| W3   | What "AI architect" actually means | Plain language. Introduce VTM portfolio. |
| W4   | Invite to follow / connect | Direct outreach + ScaleSolo as one example. |

## Week 1 content list

**Total: 11 pieces.** 1 carousel + 7 threads + 3 single-image posts. Carousel slides also seed thread variants for cross-posting.

| # | Day | Type | Title / hook | Platforms |
|---|-----|------|--------------|-----------|
| 1 | Mon AM | Thread | "Nobody talks about the 3am moment when you wonder if anyone needs what you're building." | Threads, X |
| 2 | Mon PM | Single image | "I am Rayvaughn. I build AI systems for people like you." (portrait + name card) | IG, FB, LinkedIn |
| 3 | Tue AM | Thread | "Most small businesses do not have a marketing problem. They have a visibility problem. That is the fix. That is what I do." (signature reframe + close) | Threads, X |
| 4 | Tue PM | Thread | "Houston: I want to connect with small business owners and solopreneurs building with AI. Drop a follow if that is you." (direct outreach) | Threads |
| 5 | Wed AM | Carousel (7 slides) | "Who I am, what I build, and why it matters to you." Slides walk through Rayvaughn → VTM → what gets built → who it serves → CTA. | IG, FB, LinkedIn |
| 6 | Wed PM | Thread | (Repurposed from carousel slide 2) "Vernon Tech & Media is not an agency. It is an AI architecture studio for solopreneurs." | Threads, X |
| 7 | Thu AM | Thread | "There is a season in building where nobody asks how it is going. Just you, the work, and faith. That season is not failure. That season is foundation." | Threads, X |
| 8 | Thu PM | Single image | Quote card: "One person with the right systems can outwork a team of ten. I am proof." | IG, FB |
| 9 | Fri AM | Thread | (Repurposed from carousel slide 4) "I do not build apps to sell apps. I build apps to fix something I keep seeing." | Threads, X |
| 10 | Fri PM | Thread | "If AI could handle every part of your business except the relationships, what would you do with the extra hours?" (open question) | Threads, X |
| 11 | Sat | Single image | "Built in Houston. For solopreneurs everywhere." (city + tagline, brand visuals) | IG, FB, LinkedIn |

Sun is a rest day for new content but scheduling slots still go out (reshare top performer from earlier in the week).

### Content production order (what to patch first)

The carousel takes the longest to generate. Build it first, then the threads, then the single images.

1. Carousel (post #5) — patch all 7 image_gen prompts in one session, run, save draft.
2. Single image (post #2) — patch slot 1 only, leave the rest disconnected on the canvas.
3. Single image (post #8) — same approach.
4. Single image (post #11) — same approach.
5. Threads (posts #1, 3, 4, 6, 7, 9, 10) — patch `manual_caption` only, no image gens. Each takes ~30 seconds.

### Repurposing rule

When a carousel slide's copy works as a standalone thread, mark it in the list (posts #6 and #9 above are flagged "Repurposed from carousel slide X"). The thread post uses the slide's title + body + punchline as the thread text, in Rayvaughn's voice, with no link to the carousel (the carousel speaks for itself on its own platforms).

## Things this playbook does NOT cover (yet)

- Video / avatar content. Ray handles those separately.
- Month 2 through Month 12. We build Month 2 after seeing how Month 1 lands.
- Cross-platform per-platform variants. Threads/X copy is the same string for now. If a platform-specific rewrite is needed later, the `per_platform` field on `manual_caption` supports it.
