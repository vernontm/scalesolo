# Funnel Emails — Plain Text Rewrite

Paste these into the MailerLite dashboard, one per automation step.
Convert each automation email to `Plain text` type in the MailerLite
builder (or use the HTML builder and select the plain-text template,
no images, no buttons, no header/footer styling).

## How to handle the links

The bodies below use this convention for clickable CTAs:

```
>> Get the playbook for $17 <<
```

The `>>` and `<<` are visual signals to the reader. **In the MailerLite
builder, select only the inner anchor text (e.g. `Get the playbook for $17`)
and apply the hyperlink — leave the `>>` and `<<` as unlinked text.** That
way the chevrons read as cues without underlining or coloring.

For the second mention of the same URL inside one email, the body uses
an inline "click here" or "right here" pattern as part of a sentence,
rather than another bracketed CTA. That keeps the email from feeling
button-stacked. Hyperlink just the "click here" / "right here" phrase.

**Personalization tags** (MailerLite syntax):
- `{$name}` — first name from the opt-in form (blank if not provided)
- `{$email}` — subscriber's email (use to populate the tracked URL)

**Tracked download URLs** — these go through `/api/r/<asset>` so we log
every click in `contact_activity`. Each email has its own `src=<email-id>`
so we can attribute clicks back to the specific email in the activity log:

- Blueprint: `https://www.scalesolo.ai/api/r/blueprint?src=<email-id>&e={$email}`
- Playbook:  `https://www.scalesolo.ai/api/r/playbook?src=<email-id>&e={$email}`
- Content Pack: `https://www.scalesolo.ai/api/r/pack?src=<email-id>&e={$email}`

---

## ScaleSolo · Lead · Blueprint nurture
### 5 emails over 7 days · trigger: subscriber joins `Lead · Blueprint` group

### E1 · Day 0 — KEEP AS IS (HTML download email)

The existing "Your Faceless AI Brand Blueprint is inside" email. Leave it
untouched. It delivers the magnet on group-join.

---

### E2 · Day 1 — Have You Yet (plain text)

**Subject A:** Have you opened the Blueprint yet?
**Subject B:** Are you still trying to build the faceless brand, {$name}?
**Subject C:** {$name}, did you start yet?

**Body:**

```
If you've been moving on the Blueprint, you should already have your
avatar style picked and your first three video topics in your head.

How does that feel to say out loud?

If life got in the way and you haven't opened it yet, grab it here:

>> Open the Blueprint <<

Link the inner phrase to:
https://www.scalesolo.ai/api/r/blueprint?src=lead-day1&e={$email}

Take 25 minutes today. Open Chapter 2. That's the brand voice step
everyone skips, and that's exactly why most faceless pages end up
sounding like a robot.

If you follow the chapters in order, you'll have a brand that posts
on its own and pays you while you sleep.

Don't jump around. Chapter by chapter, in order. You can pop the
Blueprint back open right here whenever you need it.

(Hyperlink "right here" in the line above to the same Blueprint URL.)

You can scroll TikTok for an hour tonight, or you can spend that
hour building the thing that pays you next year.

My recommendation: take the time for yourself, do this instead.

Talk soon,
Rayvaughn
```

---

### E3 · Day 2 — GAIN (plain text)

**Subject A:** What the Blueprint doesn't show you
**Subject B:** Did you see this, {$name}?
**Subject C:** The other half of the equation

**Body:**

```
Hey {$name},

Thanks again for grabbing the Faceless AI Brand Blueprint. Quick
check-in: have you started using it to build your page yet?

Even better, have you posted your first video?

If not, you can open it again right here.

(Hyperlink "right here" to:
https://www.scalesolo.ai/api/r/blueprint?src=lead-day2&e={$email})

You'll now know exactly how to build the page (it really is that
simple).

IMPORTANT: if you actually want this to pay you, take a few minutes
and read this:

>> See the playbook (Build Your AI Empire, $17) <<

(Hyperlink the inner phrase to https://www.scalesolo.ai/build-your-ai-empire)

The Blueprint shows you HOW to build the page. Build Your AI Empire
shows you what to actually SELL on it. The two together is the full
system, and it's the second half that puts money in your account.

Inside the playbook:

- The 4 ways a faceless page actually makes money (most people only
  know one)
- The plug-and-play offer pages
- The exact ad scripts I run on cold traffic
- The audience growth method that works with no face on camera

Plus the Faceless Content Pack add-on if you want it: 50 ready-to-use
looks for your AI avatar (men and women), saves you weeks of styling
work.

All in for 17 bucks. One time. Yours forever.

This is the same process I used to set up my mom's brand. If you're
serious about making this pay, the playbook is the first step. At
seventeen bucks it's the tiniest investment you can make and still
expect real results.

Grab it before it gets buried in your inbox.

(Hyperlink "Grab it" or the full sentence to the same playbook URL.)

Talk soon,
Rayvaughn
```

---

### E4 · Day 4 — LOGIC (plain text)

**Subject A:** The easiest way to make money with this
**Subject B:** 17 dollars for the whole playbook
**Subject C:** {$name}, the missing piece

**Body:**

```
Hey {$name},

I'm a little surprised you haven't jumped on this yet:

>> Get the playbook for $17 <<

(Hyperlink the inner phrase to https://www.scalesolo.ai/build-your-ai-empire)

If you actually want this faceless brand thing to pay you (and you
wouldn't have downloaded the Blueprint otherwise), this is the next
step. Not optional. The Blueprint shows you the page. The playbook
shows you what to sell on it.

Remember, it's not just the playbook. You also get the ad scripts,
the offer pages, the audience growth playbook, and the 50-piece
Content Pack as an add-on.

It's the momentum you need to actually start, instead of "starting
next month" forever.

So do it now before it gets lost in the noise. You can grab it here.

(Hyperlink "here" to the same playbook URL.)

Talk soon,
Rayvaughn

P.S. At seventeen bucks this is the tiniest investment you can make
and still have a realistic shot at building something that pays.

P.P.S. The page price is going up the next time I touch the funnel.
Get it while it's still cheap.
```

---

### E5 · Day 7 — FEAR (plain text)

**Subject A:** Bad news on the Founding spots
**Subject B:** You're about to miss this
**Subject C:** Last call on the playbook, {$name}

**Body:**

```
Hey {$name},

Looks like this is your last shot at the Build Your AI Empire
playbook at this price, plus Founding membership with the SCALE
bonus.

A few reasons:

REASON #1: If you were interested, you'd have grabbed it already.
I'm not going to keep nagging.

REASON #2: The Founding tier is capped at 100 spots. Once those are
gone, the door closes and the next tier is 50% more for less in the
box.

REASON #3: 17 dollars is too cheap for what's in the playbook. I'm
bumping the price the next time I touch the funnel.

So you're either going to grab this now and use what I figured out
the hard way, or you're going to figure it out yourself.

I spent two years building this. I tried four faceless niches that
flopped before I found the one that worked. I burned around twelve
grand on AI tools that didn't do what they promised, which is why I
built ScaleSolo in the first place.

Save yourself the two years and twelve grand:

>> Get the playbook ($17) <<

(Hyperlink the inner phrase to https://www.scalesolo.ai/build-your-ai-empire)

Or lock in Founding while the spots last:

>> Lock in Founding with SCALE <<

(Hyperlink the inner phrase to https://www.scalesolo.ai/welcome?product=tripwire)

Talk soon,
Rayvaughn

P.S. The playbook works. Founding with the SCALE bonus is the
cheapest ScaleSolo will ever be. If you've been on the fence, this
is your sign. You can grab the playbook right here or lock in Founding
right here.

(Hyperlink the first "right here" to the playbook URL and the second
"right here" to the founding/welcome URL.)
```

---

## ScaleSolo · Buyer · Tripwire onboarding
### 4 emails over 7 days · trigger: subscriber joins `Buyer · Tripwire` group

### E1 · Day 0 — KEEP AS IS (HTML purchase receipt)

The existing "Your playbook is in" receipt from the Stripe webhook +
the MailerLite Day 0 email. Leave both as-is for now (canonical
download record). If you want to dedupe, see principle 19 in the
skill — the cleanest move is to delete the MailerLite Day 0 and let
the Resend Stripe receipt be the sole confirmation. Up to you.

---

### E2 · Day 1 — Have You Yet · action prompt (plain text)

**Subject A:** Pick your first niche, {$name}
**Subject B:** Have you started building yet?
**Subject C:** {$name}, what's your offer?

**Body:**

```
Hey {$name},

Quick one. Now that you have the playbook, most people get stuck on
the same thing: picking the niche.

Not the broad one. Not "fitness" or "money" or "AI." The specific
slice your brand will own.

The chapter on niching is short on purpose. Five minutes. Read it
today, then write your niche down on paper.

If you can't say your niche out loud in one sentence, you haven't
picked one yet, you've picked a category. Pick the slice.

>> Open the playbook <<

(Hyperlink the inner phrase to:
https://www.scalesolo.ai/api/r/playbook?src=tripwire-buyer-day1&e={$email})

Reply to this email with the niche you pick. I read every reply.
Even one sentence is fine.

Talk soon,
Rayvaughn

P.S. The biggest reason faceless brands stall is the niche being
too broad. If you're going to skip one chapter, do not skip this one.
You can revisit it any time right here.

(Hyperlink "right here" to the same playbook URL.)
```

---

### E3 · Day 3 — GAIN · pitch DFY (plain text)

**Subject A:** Want me to just build it for you?
**Subject B:** {$name}, the hand-off option
**Subject C:** Skip the build, keep the result

**Body:**

```
Hey {$name},

Some of you are going to follow the playbook step by step and ship
your brand in a couple of weekends. I love that.

Some of you are going to read it, agree with all of it, and never
post a thing because life got in the way. I see that too.

If you're in the second camp, I have an option for you:

>> See the Done-For-You launch <<

(Hyperlink the inner phrase to https://www.scalesolo.ai/done-for-you)

My team builds the whole thing for you. Your AI avatar, multiple
looks, your brand voice, your first batch of ready-to-post videos,
and the auto-posting workflow wired up. We hand it off on a call.

You walk away with a brand that is already live, not a project on
your to-do list.

Here's what's in the box:

- A custom AI avatar, trained and ready
- Multiple looks, outfits, settings, and angles
- Your brand voice dialed in for your niche
- Your first batch of videos, posted on a schedule
- A 1-on-1 handoff call so you can run it yourself going forward

It's 397 dollars, one time. Cheapest agency I have seen for this
quotes 5,000.

If you'd rather build it yourself, the playbook still works. No
pressure. But if the workflow part is what's stopping you, this
fixes that. You can check it out right here.

(Hyperlink "right here" to https://www.scalesolo.ai/done-for-you)

Talk soon,
Rayvaughn
```

---

### E4 · Day 7 — FEAR · Founding pitch (plain text)

**Subject A:** Founding spots still open?
**Subject B:** {$name}, the last cheap month
**Subject C:** A heads up on the Founding tier

**Body:**

```
Hey {$name},

Two questions:

1. Have you actually started building from the playbook yet?
2. Do you want ScaleSolo running the engine while you do?

If yes to both, this is your sign:

>> Lock in Founding with SCALE <<

(Hyperlink the inner phrase to https://www.scalesolo.ai/welcome?product=tripwire)

The SCALE code on Founding membership unlocks 50% more video and
AI credits every month, plus a 1-on-1 setup call where my team
gets your brand live with you.

Founding is locked at 79 dollars a month. For life. That price
never goes up for you, even when the public tier eventually does.

REASON #1 to do it now: the Founding tier is capped at 100 spots.
Once they're gone, the door closes. The next tier is more for less.

REASON #2: the SCALE code only applies on the Founding signup. Sign
up at full price later and you can't apply it after the fact.

REASON #3: you already have the playbook. The page is mapped. The
only thing missing is the engine that runs it for you.

If that lands, lock it in right here.

(Hyperlink "right here" to the same Founding URL.)

Talk soon,
Rayvaughn

P.S. If you're not ready for that, no hard feelings. The playbook
still works on its own. But if you've been on the fence about the
membership, Founding plus SCALE is the cheapest entry point this
will ever have.
```

---

## ScaleSolo · Buyer · Done-For-You onboarding
### 4 emails over 14 days · trigger: subscriber joins `Buyer · Done-For-You` group

### E1 · Day 0 — KEEP AS IS (HTML kickoff confirmation)

The existing "Welcome to the build queue" email with the kickoff-call
link. This one stays styled because it includes the booking CTA prominently.

---

### E2 · Day 1 — Brand questionnaire (plain text)

**Subject A:** A few questions before we start, {$name}
**Subject B:** {$name}, help me build this faster
**Subject C:** The 8-minute intake

**Body:**

```
Hey {$name},

Welcome to the build queue. The faster we get these answers, the
faster your brand goes live.

Here's the intake:

>> Fill out the 8-minute intake <<

(Hyperlink the inner phrase to https://vernontm.com/dfy-intake)

Eight minutes. Five questions. The more honest you are about your
niche, your audience, and what you've tried before, the better the
brand we ship.

The big ones we need:

- Your niche, in one sentence
- The customer your brand serves (be specific, not "everyone")
- Your offer or product, if you have one
- The tone you want your brand to have (calm and authoritative,
  punchy and direct, warm and friendly, etc.)
- One or two pages you admire (any niche, any platform)

If you have a kickoff call booked already, the intake fills in the
context so we don't waste your call time on basics.

If you haven't booked yet, you can do that right here.

(Hyperlink "right here" to https://vernontm.com/book-call)

Talk soon,
Rayvaughn

P.S. The most common mistake at this stage is making the niche too
broad. If you find yourself writing "AI for everyone," go narrower.
We can always widen later. Going narrow at the start is what makes
this work.
```

---

### E3 · Day 7 — Walkthrough (plain text)

**Subject A:** How to get the most out of your build
**Subject B:** {$name}, two things to do this week
**Subject C:** Your brand is going live soon

**Body:**

```
Hey {$name},

Your build is in motion. While we're working on your end, here are
two things you can do this week that will multiply what we ship.

ONE: pick a posting cadence and stick to it.

We hand off the workflow that auto-posts for you, but the rhythm has
to fit your life. Three videos a week is plenty. Five if you're
ambitious. Seven only if you have a lot of source material. Pick
the number and commit to it for 90 days. Do not change it in week
two.

TWO: open a Notes file called "topic bank."

Every time you see a video on TikTok or YouTube that hits in your
niche, screenshot it and drop the screenshot in the file. Every
time you have a thought about your audience while in line at the
grocery store, voice memo it and drop it in. You will run out of
ideas faster than you think. The topic bank is what saves you when
you do.

If you want a walkthrough video of how to use the auto-posting
workflow once it's live, it's here:

>> Watch the workflow walkthrough <<

(Hyperlink the inner phrase to https://vernontm.com/dfy-walkthrough)

Talk soon,
Rayvaughn

P.S. Most DFY clients want to "tweak" the brand voice the moment
they see it. Resist the urge for 30 days. The voice is built for
the audience research we did at kickoff, and it usually feels off
to the founder for the first two weeks. Trust the audience response
data over your gut for the first month.
```

---

### E4 · Day 14 — Check-in (plain text)

**Subject A:** How is it going so far?
**Subject B:** {$name}, two-week check-in
**Subject C:** Real talk, what's working

**Body:**

```
Hey {$name},

Two weeks in. Three honest questions:

1. What is actually working that you didn't expect?

2. What is stuck or confusing, and what would unstick it?

3. If you had to point at one thing that would 2x your results from
   here, what would it be?

Reply to this email with one sentence on each. I read every reply
personally. Most clients tell me one of three things, and the answer
points us to what to optimize next.

If you have a win to share, even a small one, I would love to hear
it. With your permission I drop client wins on the page and in the
ads, which helps us land the next round of clients faster.

Talk soon,
Rayvaughn

P.S. If you are stuck on something specific, do not wait until the
next call. Reply now. I'd rather knock down a blocker today than
let it sit for two weeks.
```

(No external CTA — this email is a pure reply prompt. Keep it text-only.)

---

## ScaleSolo · Declined · Tripwire win-back
### 3 emails · trigger: subscriber joins `Declined · Tripwire` group
### IMPORTANT: First step of this automation must be "Remove from group: Lead · Blueprint"
### Currently the win-back automation is DISABLED. Enable after adding the remove-from-Lead step.

### E1 · Day 1 — Hey I get it · soft re-pitch (plain text)

**Subject A:** Hey, {$name}, I get it
**Subject B:** No hard feelings, {$name}
**Subject C:** Real talk

**Body:**

```
Hey {$name},

Tripwires are not for everyone. No hard feelings on passing.

But here's a thing most people miss when they say no to a playbook
like this: the "I'll figure it out myself" path usually costs more
than the playbook. Not in dollars, in months.

I'm two years and twelve thousand dollars in figuring this out the
hard way. The playbook is what I would have paid that twelve grand
for, on day one.

If that lands with you, the door is still open:

>> Take another look at the playbook <<

(Hyperlink the inner phrase to https://www.scalesolo.ai/build-your-ai-empire)

If not, also fine. The Blueprint is yours either way, and I'll send
a couple more emails on the bigger picture over the next few days.

Talk soon,
Rayvaughn
```

---

### E2 · Day 3 — Case study (plain text)

**Subject A:** The part nobody tells you about faceless brands
**Subject B:** {$name}, look at this
**Subject C:** A real example, not a pitch

**Body:**

```
Hey {$name},

Real example, not a pitch.

I have a client who came in convinced the hard part was the AI tools.
She had tried six of them. None stuck. She kept telling me she "just
needed the right tool."

The thing she actually needed was a niche. We narrowed her brand
from "AI for moms" (way too wide) to "AI hacks for moms who run a
home daycare." Twelve weeks later her page is doing real numbers and
she's converting at almost twice the rate she did before, on smaller
traffic.

The tool was never the problem. The niche was.

That is exactly what the playbook walks you through. Not the
"build a faceless avatar" part. The "make it a brand that actually
sells" part.

If you've been spinning on the tools without picking your niche,
the playbook fixes that:

>> Get the playbook ($17) <<

(Hyperlink the inner phrase to https://www.scalesolo.ai/build-your-ai-empire)

If not, no worries. I will leave you alone after one more email.

Talk soon,
Rayvaughn
```

---

### E3 · Day 7 — Final attempt (plain text)

**Subject A:** I'll leave the playbook here, {$name}
**Subject B:** Last one from me
**Subject C:** No nag, just a link

**Body:**

```
Hey {$name},

This is the last email I'll send you on the playbook. I'm not going
to keep nagging.

If at some point in the next few months you decide you want the
faceless brand thing to actually pay, the playbook is still here:

>> The playbook lives here <<

(Hyperlink the inner phrase to https://www.scalesolo.ai/build-your-ai-empire)

If not, you've got the free Blueprint, and that's a real start on
its own.

Either way, good luck on the build. If you ever want to reply with
a question, my email goes to my actual inbox.

Talk soon,
Rayvaughn

P.S. After this email I'll add you back to the regular nurture so
you'll see general tips and stories I post, but no more pitches on
the playbook. Promise.
```

---

## ScaleSolo · Declined · DFY win-back
### 2 emails · trigger: subscriber joins `Declined · DFY` group
### IMPORTANT: First step must be "Remove from group: Lead · Blueprint"
### Currently DISABLED. Enable after adding the remove-from-Lead step.

### E1 · Day 1 — Honest downsell (plain text)

**Subject A:** If 397 is the friction, try this, {$name}
**Subject B:** A smaller way in
**Subject C:** {$name}, the in-between option

**Body:**

```
Hey {$name},

Totally fair if the Done-For-You build isn't the right fit right
now. 397 is real money, and not everyone wants the hand-off path.

If you want to start smaller and run the build yourself, the
playbook covers the same outcome at a fraction of the cost:

>> See the playbook ($17) <<

(Hyperlink the inner phrase to https://www.scalesolo.ai/build-your-ai-empire)

Here's what's in it:

- The 4 ways a faceless page actually makes money
- The plug-and-play offer pages
- The exact ad scripts I run on cold traffic
- The audience growth method with no face on camera

It's 17 dollars. One time. Yours forever.

The DFY door stays open if you change your mind later, but the
playbook is the cheapest first step. You can grab it right here.

(Hyperlink "right here" to the same playbook URL.)

Talk soon,
Rayvaughn
```

---

### E2 · Day 7 — Re-add to Lead nurture (no email)

This step is **not an email**. In the MailerLite automation builder
add an Action step:

- Action: Add to group → `ScaleSolo · Lead · Blueprint`
- Action: Remove from group → `ScaleSolo · Declined · DFY`

That re-enters them in the general Lead nurture. End the automation
after this step.

---

## Final checklist before enabling each automation

For each of the 5 automations:

- [ ] Open in the MailerLite builder
- [ ] Click each email step → switch builder to "Plain text" template
- [ ] Paste the body from this doc, replacing existing content
- [ ] For each `>> Anchor <<` line: select the inner anchor text only
      (not the chevrons) and apply the hyperlink using the URL noted
      directly below it
- [ ] For inline "click here" / "right here" / "open it again" phrases:
      select that phrase and apply the same URL referenced for that
      email
- [ ] Update the subject line(s) — A/B test the top 2 if you like
- [ ] Confirm sender is `Rayvaughn <ray@vernontm.com>` (or your verified
      sender)
- [ ] For the two Declined automations: add "Remove from group:
      Lead · Blueprint" as the very FIRST step before any delay or email
- [ ] For the two Buyer onboarding automations: same — add "Remove from
      group: Lead · Blueprint" as the first step (a buyer should not get
      lead nurture)
- [ ] Hit "Enable automation"
- [ ] Send yourself a test email from the first step (MailerLite has a
      Test Email feature) before going live

## Quick visual check on each email after pasting

In the MailerLite preview, the `>>` and `<<` should appear as plain
characters (no underline, no link color). The text between them should
appear underlined or colored as a link. If the whole `>> Anchor <<`
string is underlined, you accidentally included the chevrons in the
hyperlink selection — undo and reselect just the inner text.
