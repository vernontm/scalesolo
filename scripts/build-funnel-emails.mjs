// Source of truth for the ScaleSolo funnel email automations.
//
// Authors all 18 emails across the 5 MailerLite flows in Rayvaughn's voice
// (founder-in-the-trenches, no em-dashes, value-stack not discount) and
// renders them with a dark branded HTML wrapper that mirrors the structure
// of api/_lib/email.js brandedEmail()/ctaButton() but in the funnel's dark
// theme: #0c0b0f background, #ef4444 red accents, Plus Jakarta Sans, white
// text, red gradient CTA buttons.
//
// Run:  node scripts/build-funnel-emails.mjs
// Out:  scripts/funnel-emails/<flow>.json  (name, trigger group_id, steps[])
//       Each steps[] is ready to hand straight to MailerLite create_automation.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'funnel-emails')

// ---- Canonical funnel links ------------------------------------------------
const SITE = 'https://scalesolo.ai'
const TRIPWIRE = `${SITE}/build-your-ai-empire`
const DFY = `${SITE}/done-for-you`
const WELCOME = `${SITE}/welcome`
const BLUEPRINT_PDF =
  'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/build-your-ai-empire.pdf'

// ---- MailerLite group ids (live account 2286074) ---------------------------
const GROUPS = {
  lead: '189087584860767671',
  buyerTripwire: '189087622956582636',
  buyerPack: '189087645266085304',
  buyerDfy: '189087669801715346',
  declinedTripwire: '189087683971122730',
  declinedDfy: '189087697198908619',
}

// ---- Dark branded wrapper (mirrors brandedEmail/ctaButton, dark theme) ------
const MARK = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ef4444"/><stop offset="100%" stop-color="#b91c1c"/>
    </linearGradient></defs>
    <rect x="0" y="0" width="36" height="36" rx="9" fill="url(#g)"/>
    <polygon points="20 8 12 19 18 19 16 28 24 17 18 17 20 8" fill="#ffffff"/>
  </svg>`
)}`

const FONT = `'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`

function wrap({ preheader, body }) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ScaleSolo</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:#0c0b0f;font-family:${FONT};-webkit-font-smoothing:antialiased;">
${preheader ? `<div style="display:none;font-size:1px;color:#0c0b0f;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>` : ''}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#0c0b0f;padding:36px 16px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="background:#141318;border-radius:14px;overflow:hidden;border:1px solid #221f29;">
      <tr><td style="padding:30px 36px 22px;border-bottom:1px solid #221f29;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
          <td style="vertical-align:middle;padding-right:12px;">
            <img src="${MARK}" width="36" height="36" alt="ScaleSolo" style="display:block;border-radius:9px;">
          </td>
          <td style="vertical-align:middle;font-family:${FONT};font-weight:800;font-size:18px;color:#ffffff;letter-spacing:-0.01em;">ScaleSolo</td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:30px 36px 8px;font-family:${FONT};color:#e7e5ea;font-size:15px;line-height:1.65;">
        ${body}
      </td></tr>
      <tr><td style="padding:18px 36px 30px;border-top:1px solid #221f29;font-family:${FONT};color:#86838f;font-size:12px;line-height:1.5;">
        You are getting this because you joined ScaleSolo through Rayvaughn at Vernon Tech &amp; Media.<br>
        Just reply if you ever want to reach me directly.<br>
        <a href="${SITE}" style="color:#ef4444;text-decoration:none;">scalesolo.ai</a>
        &nbsp;&nbsp;<a href="{$unsubscribe}" style="color:#86838f;text-decoration:underline;">Unsubscribe</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`
}

const cta = (label, url) =>
  `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:22px 0 10px;">
    <tr><td style="border-radius:10px;background:linear-gradient(135deg,#ef4444 0%,#b91c1c 100%);">
      <a href="${url}" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-weight:700;font-size:14px;color:#ffffff;text-decoration:none;border-radius:10px;">${label}</a>
    </td></tr>
  </table>`

const h = (t) => `<p style="margin:0 0 14px;font-size:21px;font-weight:800;color:#ffffff;letter-spacing:-0.01em;">${t}</p>`
const p = (t) => `<p style="margin:0 0 16px;">${t}</p>`
const red = (t) => `<span style="color:#ef4444;font-weight:700;">${t}</span>`
const sig = () => p(`Talk soon,<br>Rayvaughn<br><span style="color:#86838f;">Founder, Vernon Tech &amp; Media</span>`)

// email step helper
const email = (subject, preheader, ...bodyParts) => ({
  type: 'email',
  email_subject: subject,
  email_content: wrap({ preheader, body: bodyParts.join('\n') }),
})
const delay = (value, unit = 'days') => ({ type: 'delay', delay_value: value, delay_unit: unit })

// ===========================================================================
// FLOW 1 — Lead · Blueprint nurture (5 emails over 7 days)
// ===========================================================================
const leadFlow = {
  name: 'ScaleSolo · Lead · Blueprint nurture',
  trigger_group_id: GROUPS.lead,
  steps: [
    email(
      'Your Faceless AI Brand Blueprint is inside',
      'The blueprint plus what to read first.',
      h('It is here. Grab it now.'),
      p('You asked for the Faceless AI Brand Blueprint, so here it is. No fluff, no 40 page warm up. This is the exact framework I use to build faceless AI brands that run without me on camera.'),
      cta('Download the Blueprint', BLUEPRINT_PDF),
      p('Do me one favor. Do not just file it away. Open it today while the reason you signed up is still fresh.'),
      p(`When you are ready, start with the brand voice section. That is the part most people skip, and it is the exact part that makes a faceless brand feel like a real person instead of a content farm.`),
      sig()
    ),
    delay(1),
    email(
      'Did you get to Chapter 2 yet',
      'The one section that separates real brands from content farms.',
      h('The part everyone skips'),
      p('Quick nudge. If you only read one section of the Blueprint, make it the brand voice chapter.'),
      p(`Here is why I keep hammering this. Anyone can point an AI at a trend and spit out 30 videos. That is not a brand, that is noise. The thing that makes people follow, trust, and eventually buy is ${red('a voice that sounds like a person')}.`),
      p('Pick three words that describe how your brand talks. Bold, calm, funny, blunt, warm. Write them down. Every piece of content runs through that filter from now on.'),
      cta('Reread the Blueprint', BLUEPRINT_PDF),
      p('That one move will put you ahead of almost everyone trying this right now.'),
      sig()
    ),
    delay(1),
    email(
      'The Blueprint shows the what. This shows the how.',
      'The playbook that turns the framework into income.',
      h('Ready to actually build it'),
      p('The Blueprint gives you the map. A map is great, but at some point you have to drive.'),
      p(`I put the whole build into a step by step playbook. Niche selection, the content engine, posting cadence, and how to point it all at income instead of vanity views. It is ${red('$17')}. Less than lunch.`),
      cta('Get the $17 Playbook', TRIPWIRE),
      p('I priced it low on purpose. I would rather you take action this week than think about it for three months. If it saves you one wasted weekend it already paid for itself many times over.'),
      sig()
    ),
    delay(2),
    email(
      'What happens when you skip the workflow step',
      'The expensive mistake almost every beginner makes.',
      h('The mistake that costs people months'),
      p('Most people who try to build a faceless brand quit around week three. Not because the idea is bad. Because they never built a system, so every single post felt like starting from zero.'),
      p('They burn out doing it all by hand. Pick a topic, write it, make it, post it, repeat, forever. That is a job, not a brand.'),
      p(`The fix is a workflow. Build the engine once, then feed it. That is the entire middle section of the ${red('$17 playbook')}, the part that turns this from a hobby into something that runs while you sleep.`),
      cta('See how the workflow works', TRIPWIRE),
      sig()
    ),
    delay(3),
    email(
      'Last call on the playbook',
      'Last nudge, then I leave you alone.',
      h('I will stop emailing about this after today'),
      p('You grabbed the Blueprint, which tells me you are serious about building a faceless AI brand. So this is my last nudge on the playbook.'),
      p(`The ${red('$17 playbook')} is the fastest way to go from reading to actually shipping. And if you would rather skip the learning curve completely, I also build the whole thing for you done for you, brand voice, content engine, and launch.`),
      cta('Start with the $17 Playbook', TRIPWIRE),
      p(`If you want me to just build it for you instead, the done for you option is here: <a href="${DFY}" style="color:#ef4444;text-decoration:none;">scalesolo.ai/done-for-you</a>.`),
      p('Either way, do not let the Blueprint collect dust. The people who win here are the ones who start before they feel ready.'),
      sig()
    ),
  ],
}

// ===========================================================================
// FLOW 2 — Buyer · Tripwire onboarding (4 emails over 7 days)
// ===========================================================================
const tripwireFlow = {
  name: 'ScaleSolo · Buyer · Tripwire onboarding',
  trigger_group_id: GROUPS.buyerTripwire,
  steps: [
    email(
      'Your playbook is in. Here is where to start.',
      'Login, what is inside, and your first move.',
      h('You are in. Let me point you the right way.'),
      p('Thank you for grabbing the playbook. Real talk, this is the part where most people download and disappear. Not you. Let me make the first step stupid simple.'),
      p(`Log in here and open the playbook: <a href="${WELCOME}" style="color:#ef4444;text-decoration:none;">scalesolo.ai/welcome</a>`),
      cta('Open your account', WELCOME),
      p('Read the first section today. Just the first one. Momentum beats motivation every time, and the only goal right now is to start.'),
      sig()
    ),
    delay(1),
    email(
      'Pick your first niche today',
      'Your one job for the next 20 minutes.',
      h('Your one job today'),
      p('Time to make a decision. Pick your niche. Not the perfect niche, the first niche. You can adjust later, but you cannot edit a blank page.'),
      p(`Use this filter. Pick something you can talk about for 50 videos without getting bored, that other people clearly spend money on. ${red('Interest plus money')}. That is the sweet spot.`),
      p('Write it at the top of a doc right now. Then write five video ideas under it. That is your whole assignment. Twenty minutes, tops.'),
      cta('Jump back into the playbook', WELCOME),
      sig()
    ),
    delay(2),
    email(
      'Want me to just build it for you',
      'For when you would rather skip the setup.',
      h('Or I can do the building part for you'),
      p('You have the playbook, so you know exactly what goes into a faceless AI brand. Brand voice, the content engine, the posting system. It works, but it is real work.'),
      p(`If you would rather have it handed to you ready to run, that is what the done for you launch is. I build your brand voice, set up the content engine, and hand you something already moving. ${red('$397')}, done.`),
      cta('See the Done-For-You launch', DFY),
      p('No pressure at all. The playbook gets you there on your own. This is just the shortcut for people who would rather buy back the time.'),
      sig()
    ),
    delay(4),
    email(
      'Is the Founding spot still open',
      'Lock $79/mo before the founding window closes.',
      h('Lock your Founding rate while it is open'),
      p('Quick heads up while you are building. The Founding Member rate on ScaleSolo is still open, and it is the best deal this tool will ever have.'),
      p(`Founding Members lock in ${red('$79 a month')} for life, even when the price goes up later. And if you use code ${red('SCALE')} you also get ${red('+50% credits')} on top, plus a ${red('1 on 1 setup call')} with me to get your brand running right.`),
      p('This is not a discount gimmick. It is a value stack. More credits, a real call with me, and a rate that never moves, as a thank you for being early.'),
      cta('Lock in Founding with code SCALE', WELCOME),
      sig()
    ),
  ],
}

// ===========================================================================
// FLOW 3 — Buyer · Done-For-You onboarding (4 emails over 14 days)
// ===========================================================================
const dfyFlow = {
  name: 'ScaleSolo · Buyer · Done-For-You onboarding',
  trigger_group_id: GROUPS.buyerDfy,
  steps: [
    email(
      'Welcome to the build queue',
      'You are in the queue. Here is your kickoff call.',
      h('We are building your brand. Let us kick it off.'),
      p('This is the one I get excited about. You are officially in the build queue, which means I am about to build your faceless AI brand with you instead of leaving you to figure it out alone.'),
      p('First step is a quick kickoff call so I can hear your vision in your words. Grab a time that works for you and we will map the whole thing out together.'),
      cta('Book your kickoff call', WELCOME),
      p('Before the call, just sit with one question. If this brand worked exactly the way you wanted, what would it look like in 90 days. Bring that energy and we will reverse engineer it.'),
      sig()
    ),
    delay(1),
    email(
      'A few questions so I nail your brand voice',
      'The answers that make your brand sound like you.',
      h('Help me make this sound like you'),
      p('To build a brand that actually feels like yours, I need a little from you. Just reply to this email with your answers, plain text is perfect.'),
      p(`1. Who is this brand for. Describe your dream follower in one or two sentences.<br>
2. What are three words that describe how your brand should talk.<br>
3. What do you want people to feel when they land on your page.<br>
4. Any brands or creators whose vibe you love. Drop a couple of names.`),
      p(`That is it. The more honest you are here, the more it will sound like ${red('you')} and not a template. This is the part that makes a faceless brand feel human.`),
      sig()
    ),
    delay(6),
    email(
      'Your walkthrough video is ready',
      'A full tour of what I built for you.',
      h('Here is everything I built, explained'),
      p('Your brand setup is taking shape, so I recorded a full walkthrough that shows you exactly what I built and how every piece fits together.'),
      p('You will see your brand voice in action, the content engine, and how the whole system runs day to day so nothing feels like a black box.'),
      cta('Watch your walkthrough', WELCOME),
      p('Watch it all the way through, then reply with anything you want adjusted. This is your brand. I want it dialed in exactly how you pictured it.'),
      sig()
    ),
    delay(7),
    email(
      'Checking in. How is the brand running',
      'Two weeks in. Let us tune it together.',
      h('Two weeks in. How does it feel.'),
      p('It has been about two weeks since we kicked off, so I want to check in like a real person, not a drip sequence. How is it going. What is working. What feels clunky.'),
      p('Just reply and tell me honestly. If something needs tuning, this is exactly when we tune it. The first two weeks tell us a lot, and small adjustments now compound fast.'),
      p(`And if you are ready to push harder, lock your Founding rate at ${red('$79 a month')} with code ${red('SCALE')} for ${red('+50% credits')} and a setup call to scale what is already working.`),
      cta('Lock Founding with code SCALE', WELCOME),
      sig()
    ),
  ],
}

// ===========================================================================
// FLOW 4 — Declined · Tripwire win-back (3 emails)
//   NOTE: a "remove from Lead nurture" action + a final "add to Lead" action
//   must be added in the MailerLite UI (the automation API only supports
//   email + delay steps). See docs/funnel-mailerlite-setup.md.
// ===========================================================================
const declinedTripwireFlow = {
  name: 'ScaleSolo · Declined · Tripwire win-back',
  trigger_group_id: GROUPS.declinedTripwire,
  steps: [
    delay(1),
    email(
      'Hey, I get it',
      'No hard sell. Just one honest thought.',
      h('No pitch. Just a quick honest note.'),
      p('You looked at the playbook and passed, and that is completely fine. I am not going to chase you with fake countdown timers.'),
      p(`But I will say one thing. The reason it is only ${red('$17')} is that I would rather you take one real step this week than think about it for another three months. That is the whole point of it.`),
      p('If the timing was just off, the door is still open. Same playbook, same price, whenever you are ready.'),
      cta('Take another look', TRIPWIRE),
      sig()
    ),
    delay(2),
    email(
      'The part nobody tells you about faceless brands',
      'What actually happens when someone commits.',
      h('What changes when you actually start'),
      p('Let me tell you what usually happens. Someone sits on the fence for months, finally commits, builds the system, and within a few weeks they cannot believe they waited so long.'),
      p('Not because it got easy. Because once the engine is built, the work stops feeling like pushing a boulder. You feed the system and it runs. That shift is the whole game.'),
      p(`The ${red('$17 playbook')} is the shortcut to that shift. It is the difference between guessing for six months and following a path that already works.`),
      cta('Get the playbook', TRIPWIRE),
      sig()
    ),
    delay(4),
    email(
      'I will leave the playbook here',
      'Last note. Then back to the good stuff.',
      h('Last note on this one'),
      p('I am going to stop nudging you about the playbook now. You will still hear from me with the free stuff, the breakdowns, and the lessons I learn building these brands in real time.'),
      p('But the door does not close. Whenever you decide you are ready to actually build, the playbook is right here waiting.'),
      cta('It is right here when you are ready', TRIPWIRE),
      p('Glad you are still around. The best stuff is the stuff I share for free anyway.'),
      sig()
    ),
  ],
}

// ===========================================================================
// FLOW 5 — Declined · DFY win-back (2 emails)
//   NOTE: same as above, the "remove from Lead nurture" + final "add to Lead"
//   actions are added manually in the MailerLite UI.
// ===========================================================================
const declinedDfyFlow = {
  name: 'ScaleSolo · Declined · DFY win-back',
  trigger_group_id: GROUPS.declinedDfy,
  steps: [
    delay(1),
    email(
      'If $397 is the issue, start here instead',
      'Same destination. Smaller first step.',
      h('Totally fair. Here is the smaller door.'),
      p('You looked at the done for you launch and passed, and I completely understand. $397 is a real decision, not an impulse buy.'),
      p(`So here is the honest move. If the price was the hold up, do not wait. Start with the ${red('$17 playbook')} instead. Same destination, you just drive part of the way yourself.`),
      cta('Start with the $17 Playbook', TRIPWIRE),
      p('You will build the exact same brand, just with your own hands on the wheel. And if you ever want me to take it the rest of the way, the done for you door stays open.'),
      sig()
    ),
    delay(6),
    email(
      'Still here, still in your corner',
      'No pitch. Just sticking around.',
      h('Sticking around either way'),
      p('Last note on the launch. Whether you go done for you, grab the playbook, or just hang out and read the free stuff, I am glad you are here.'),
      p('I will keep sending the breakdowns and the lessons from building these brands in real time. When you are ready to move, you will know exactly where to find me.'),
      cta('Whenever you are ready', TRIPWIRE),
      sig()
    ),
  ],
}

// ---- Render -----------------------------------------------------------------
const flows = {
  lead: leadFlow,
  'buyer-tripwire': tripwireFlow,
  'buyer-dfy': dfyFlow,
  'declined-tripwire': declinedTripwireFlow,
  'declined-dfy': declinedDfyFlow,
}

mkdirSync(OUT, { recursive: true })
for (const [slug, flow] of Object.entries(flows)) {
  writeFileSync(join(OUT, `${slug}.json`), JSON.stringify(flow, null, 2))
  // Also emit one standalone .html per email — ready to paste into
  // MailerLite's "Custom HTML" email editor (the MCP/API cannot set the
  // email design itself, so this is the import path).
  let n = 0
  for (const step of flow.steps) {
    if (step.type !== 'email') continue
    n += 1
    const file = `${slug}-${n}.html`
    writeFileSync(join(OUT, file), step.email_content)
    console.log(`  ${file}  —  "${step.email_subject}"`)
  }
  const emails = flow.steps.filter((s) => s.type === 'email').length
  console.log(`${slug}: ${emails} emails, ${flow.steps.length} steps`)
}
console.log('done')
