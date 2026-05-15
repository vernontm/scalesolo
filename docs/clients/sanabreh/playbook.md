# Sanabreh Mediterranean Restaurant — Content Playbook

Operating manual for a Claude Code session producing content for Sanabreh. Read this whole file before drafting any post.

## Mandatory reference files (auto-loaded from user's ~/.claude memory)

- `client_sanabreh_persona.md` — who Sanabreh is, the audience, the owner POV
- `client_sanabreh_voice.md` — voice patterns, "Have you tried…?" hooks, max-20% rule, copy length
- `client_sanabreh_visuals.md` — aesthetic, locked logo placement, typography, per-post-type specs, negative prompts

If any draft sounds like generic chain restaurant marketing or violates the visual rules, rewrite.

## Production setup

### Spaces in use

- **Sanabreh Carousel Generator** (`3e574c24-f0f4-438a-8979-9dc25d4e0e51`) — handles carousels AND single-image posts. 7 image_gen nodes wired to one save_library + a manual_caption node for title / caption / hashtags / first_comment.
- **Sanabreh Text-Only Space** — not yet built. Most Sanabreh content is image-led so this is lower priority than VTM's.

### Asset library on the Upload Media node

The canvas Upload Media node already has 23 reference images. Use `@mention` form in image_gen prompts to pass them as references to KIE for realism + style grounding.

**Restaurant (5):** `@exterior`, `@exterior2`, `@exterior3`, `@interior`, `@seating`
**Ad style reference (1):** `@adstyle` (the existing $7 chicken shawarma promo Sanabreh ran — reference this on EVERY ad-style post so the new posts feel like they belong in the same series)
**Chicken shawarma (6):** `@chickenshawarma`, `@chickenshawarmaplate`, `@chickenshawarmaplate2`, `@chickenshawarmacloseup`, `@chickenshawarmawrap`, `@shawarmawithlemonade`
**Lamb chops (5):** `@lambchops`, `@lambchopplate`, `@lambchopplate2`, `@lambchopplate3`, `@lambchopplate4`
**Other dishes (4):** `@shawarmaplatter`, `@wrap`, `@salad`, `@hummusplate`, `@mintlemonade`
**Behind the counter (1):** `@shawarmacooking`
**Brand logo:** `@brand-logo` (from the brand profile)

### Sanabreh Carousel Generator node ids

Image_gen slots (positions on canvas, left to right):

```
slot 1 (cover):  sbr_n_mp74ryy3_iv6p
slot 2 (body):   sbr_n_mp754l8l_0_9rw
slot 3 (body):   sbr_n_mp754nfz_0_t3m
slot 4 (body):   sbr_n_mp754vgi_0_bdy
slot 5 (cta):    sbr_n_mp754xd0_0_85e
slot 6 (body):   sbr_n_mp754xoz_0_sjj
slot 7 (body):   sbr_n_mp754y6j_0_zhi
```

Caption node id: `sbr_n_caption_w1_001`
Save_library node id: `sbr_n_mp752too_4mqj`

For single-image posts, only patch slot 1 and leave the other slots disconnected from save_library on the canvas.

## SQL patch templates

### Patching an image_gen prompt

```sql
UPDATE spaces SET
  nodes = (
    SELECT jsonb_agg(
      CASE WHEN n->>'id' = '<NODE_ID>'
        THEN jsonb_set(n, '{data,props,prompt}', to_jsonb($prompt$<PROMPT TEXT>$prompt$::text))
        ELSE n
      END
    )
    FROM jsonb_array_elements(nodes) n
  ),
  updated_at = now()
WHERE id = '3e574c24-f0f4-438a-8979-9dc25d4e0e51';
```

### Patching the manual_caption fields

```sql
UPDATE spaces SET
  nodes = (
    SELECT jsonb_agg(
      CASE WHEN n->>'id' = 'sbr_n_caption_w1_001'
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
WHERE id = '3e574c24-f0f4-438a-8979-9dc25d4e0e51';
```

## Cadence — locked weekly anchors

2 posts/day, 7 days/week, every platform. Recurring anchor days never change:

| Day | Anchor | Format | Asset |
|---|---|---|---|
| Mon | Lunch special spotlight | Single image | rotate lunch-friendly dishes |
| Tue | Menu hero (rotating dish) | Single image | rotate among @lambchopplate, @hummusplate, etc. |
| **Wed** | **$7 chicken shawarma wrap day** | Single image | `@chickenshawarma` + `@adstyle` reference |
| Thu | Students eat 20% off | Single image | hero dish + "show your student ID" |
| Fri | Promo gimmick (the engagement driver) | Single image | rotate the gimmick library below |
| Sat | Loyalty / birthday club signup | Single image | warm interior or seating shot |
| Sun | Family / heritage story OR weekly carousel | Carousel (7 slides) OR single | varies |

**Second post each day** rotates among: review quote card, mint lemonade signature shot, hookah evening post (after 6 PM only), behind-the-counter shawarmacooking, neighborhood shoutout (Friendswood / Clear Lake / Bay Area / Nassau Bay / Webster).

### Promo gimmick library (rotate Friday)

Hard ceiling: 20% off. Bonuses on top of paid orders keep the math clean.

1. "First 10 people today to walk in and show this post get a free mint lemonade with any platter."
2. "Bring a friend, both get 15% off your entrées today."
3. "Mention 'Sanabreh CEO' at the register, get a free baba ghanoush."
4. "Order any shawarma platter today, free side of hummus on us."
5. "Tag a foodie friend in the comments. We'll DM one of you a free chicken tawook combo."
6. "Repost to your story + tag @sanabreh_mediterranean = 15% off your next visit."

## Month 1 plan (Discovery)

The goal of Sanabreh's Month 1 is **awareness + first visit**. Houstonians in the SE corridor should know Sanabreh exists, what it serves, and that today is a good day to try it.

| Week | Theme | Focus |
|------|-------|-------|
| W1   | Introduction | "Houston's best kept Mediterranean secret" — who, what, where |
| W2   | The menu, dish by dish | Each weekday a different hero dish |
| W3   | Community + students | Student 20%, lunch crowd, neighborhood callouts |
| W4   | Promo push | Stronger promos, review echoes, loyalty signup CTA |

## Week 1 content list (Discovery)

Total: **14 posts** (2/day × 7 days). 1 carousel + 13 single images.

| # | Day | When | Type | Hook / Visual | Asset | Promo? |
|---|-----|------|------|---------------|-------|--------|
| 1 | Mon | AM | Single | "Lunch breaks are better with a chicken shawarma wrap. $14.99 with fries, 35 minutes door to door." | @chickenshawarmawrap | — |
| 2 | Mon | PM | Single | "Mint lemonade housemade daily. The signature drink that ends every meal at Sanabreh." | @mintlemonade | — |
| 3 | Tue | AM | Single | "Have you tried the lamb chops? Seared, marinated overnight, served with rice + two sides. $19.99." | @lambchopplate2 | — |
| 4 | Tue | PM | Single | "Hummus that took three generations to perfect. Family recipe. $5.99 the side, $13.99 the app sampler." | @hummusplate | — |
| 5 | Wed | AM | **Single (ad-style)** | "Every Wednesday: $7 chicken shawarma wrap. Today only. Open 11 AM – 11 PM." | @chickenshawarma + style-match @adstyle | $7 anchor |
| 6 | Wed | PM | Single | "Smoky. Citrus-bright. Stacked. The chicken shawarma we're known for." | @chickenshawarmacloseup | — |
| 7 | Thu | AM | **Single (ad-style)** | "Students: show your ID, save 20%. Every Thursday. Bay Area Blvd." | @shawarmaplatter | Thu student 20% |
| 8 | Thu | PM | Single | "Fattoush. Mixed greens, crispy pita, sumac dressing. The salad you'll actually finish." | @salad | — |
| 9 | Fri | AM | **Single (promo gimmick)** | "First 10 people today to walk in and show us this post = free mint lemonade with any platter. Go." | @lambchopplate (hero) | Fri 1 (rotation) |
| 10 | Fri | PM | Single | "Come for the lamb chops. Stay for the hookah. Covered patio. 20+ flavors. No reservations needed." | @seating | — |
| 11 | Sat | AM | Single | "Your birthday month: you eat free. The Sanabreh family welcomes you to the table. Join the loyalty list (link in bio)." | @interior | Sat loyalty |
| 12 | Sat | PM | Single | "Behind the counter. Every plate is hand-built, every shawarma carved to order." | @shawarmacooking | — |
| 13 | Sun | AM | **Carousel (7 slides)** | "Houston's best kept Mediterranean secret. Welcome to Sanabreh." Slides: cover → exterior → interior → 3 menu heroes → CTA. | mix | — |
| 14 | Sun | PM | Single | "Sunday dinner is a family thing. Bring yours. 487 Bay Area Blvd, open until 11 PM." | @exterior or @interior | — |

### Production order

Carousel first (slowest), then ad-style anchors (Wed, Thu, Fri promos — most strategic), then rotating single images.

1. Post #13 — Sunday carousel
2. Post #5 — Wed $7 shawarma (the most-repeated visual — get the template perfect)
3. Post #7 — Thu student 20% (second locked recurring)
4. Post #9 — Fri promo gimmick
5. Post #11 — Sat loyalty signup
6. Remaining 9 single-image posts in calendar order

## Workflow loop

1. User says **"ready for Sanabreh Week N"** → Claude shows the list.
2. User says **"approved"** or requests edits.
3. User says **"patch post N"** → Claude rewrites the right nodes via SQL.
4. User refreshes ScaleSolo, runs the space.
5. save_library writes the draft to content_scripts. The row appears on the Content > Drafts tab (or auto-schedules to next slot if `caption_ready` status was picked in the SaveBody dropdown).
6. User says **"next"** → Claude patches the next post.

## Things this playbook does NOT cover

- Video / avatar content. Ray handles those separately.
- Threads / X copy. Sanabreh is image-led; threads are low priority.
- Month 2+. Build after Month 1 has actually posted.
- Live review-screenshot ingestion. Once Ray drops 5–10 review screenshots into a folder, Week 3+ can add review-quote-card posts using the actual text + reviewer names.
