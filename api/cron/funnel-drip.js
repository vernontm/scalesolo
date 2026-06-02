// Vercel cron — funnel drip emails.
// Walks every funnel contact through the welcome → nurture → win-back
// sequences. State lives in email_contacts.tags so we never double-send.
//
// Triggered by a Vercel cron schedule (see vercel.json). Each run does
// one pass over due contacts and sends at most one email per contact
// per run (so a bad batch can be re-run safely).
//
// Tag conventions:
//   funnel:lead-opt-in          — added by /api/leads/subscribe
//   drip:welcome-N-sent         — N = 1..5 (sequence position)
//   drip:welcome-done           — sequence complete; ready for nurture
//   blueprint:sent              — Blueprint delivered (welcome #1 or decline)
//   declined:tripwire / declined:dfy
//   founding:scale              — SCALE bonus signup
//   setup-call:pending          — needs 1-on-1 booking
//
// To extend with Nurture / Win-back: add steps to STEPS with the right
// gate (e.g. require 'drip:welcome-done' + days since last send).

import { setCors, supaFetch } from '../_lib/supabase.js'
import { brandedEmail, ctaButton, sendEmailSafe } from '../_lib/email.js'

const APP_URL = process.env.SCALESOLO_DOMAIN || process.env.FRONTEND_URL || 'https://scalesolo.ai'

// Tracked-redirect builder. Every asset link in a drip email goes
// through /api/r/<asset> so we can log every click in contact_activity
// (event_type=asset_downloaded). Pass the contact's email so the
// redirect endpoint can resolve their contact_id and tie the click
// back to them.
const tracked = (asset, email, src) =>
  `${APP_URL}/api/r/${asset}?src=${encodeURIComponent(src)}&e=${encodeURIComponent(email)}`

const PAGE = {
  playbook:  `${APP_URL}/build-your-ai-empire`,
  founding:  `${APP_URL}/welcome?product=tripwire`, // SCALE upsell card lives on welcome page
  dfy:       `${APP_URL}/done-for-you`,
}

// Helper to compose a standard styled body.
function emailBody({ title, paragraphs, cta }) {
  return [
    `<p style="margin:0 0 12px;font-size:18px;font-weight:700;color:#0c0c0d;">${title}</p>`,
    ...paragraphs.map((p) => `<p style="margin:0 0 12px;">${p}</p>`),
    cta ? ctaButton(cta) : '',
    `<p style="margin:14px 0 0;">— Rayvaughn · ScaleSolo</p>`,
  ].filter(Boolean).join('')
}

// Sequence steps. Each step is { id, gate(contact, now)=>bool, send(contact)=>email }.
// `gate` decides eligibility based on tags + signed_up_at. `send` returns
// { subject, html, newTags? } — the runner adds the step's id tag too.
const HOURS = 60 * 60 * 1000
const DAYS  = 24 * HOURS

function hasTag(c, t)   { return Array.isArray(c.tags) && c.tags.includes(t) }
function needsTag(c, t) { return !hasTag(c, t) }
function ageMs(c, now)  { return now - new Date(c.signed_up_at || c.created_at || now).getTime() }
function lastSendMs(c, now) {
  // Use last_drip_at if we have it; otherwise fall back to signed_up_at.
  const last = c.last_drip_at ? new Date(c.last_drip_at).getTime() : null
  return last ? (now - last) : ageMs(c, now)
}

const STEPS = [
  {
    id: 'drip:welcome-1-sent',
    gate: (c) => needsTag(c, 'drip:welcome-1-sent'),
    send: (c) => ({
      subject: 'Here is your Faceless AI Brand Blueprint',
      html: brandedEmail({
        preheader: 'Your free Faceless AI Brand Blueprint is inside.',
        body: emailBody({
          title: 'Your Blueprint is ready.',
          paragraphs: [
            'Thanks for grabbing the Faceless AI Brand Blueprint. Here it is, yours to keep.',
            'One tip: do not skip Chapter 2, the brand voice step. It is the part most people skip, and the reason most pages end up sounding like a robot.',
            'Tomorrow I will tell you why I really built this. It might surprise you.',
          ],
          cta: { label: 'Download the Blueprint', url: tracked('blueprint', c.email, 'drip-welcome-1') },
        }),
      }),
      newTags: ['blueprint:sent'],
    }),
  },
  {
    id: 'drip:welcome-2-sent',
    gate: (c, now) => hasTag(c, 'drip:welcome-1-sent') && needsTag(c, 'drip:welcome-2-sent') && lastSendMs(c, now) >= 1 * DAYS,
    send: (c) => ({
      subject: 'Why I built this for my mom',
      html: brandedEmail({
        preheader: 'She is not who you would expect.',
        body: emailBody({
          title: 'Real talk for a second.',
          paragraphs: [
            'I did not build this for tech people. I built it for my mom.',
            'She is from a generation that came up long before any of this AI technology existed. She had tried the courses, the groups, the mentorships, and every single one of them lost her.',
            'So I made it simple enough that she could actually do it. She built a faceless brand from scratch, monetizes it, and runs the whole thing herself.',
            'If you have ever felt like this stuff was not for someone like you, that is the line I want you to hear. You do not have a discipline problem. You have a process problem. This is the process.',
          ],
          cta: { label: 'Open the Blueprint again', url: tracked('blueprint', c.email, 'drip-welcome-2') },
        }),
      }),
    }),
  },
  {
    id: 'drip:welcome-3-sent',
    gate: (c, now) => hasTag(c, 'drip:welcome-2-sent') && needsTag(c, 'drip:welcome-3-sent') && lastSendMs(c, now) >= 2 * DAYS,
    send: (c) => ({
      subject: 'Building the page is the easy part',
      html: brandedEmail({
        preheader: 'It is everything after the view that pays.',
        body: emailBody({
          title: 'Real quick.',
          paragraphs: [
            'Building a faceless page is the easy part now. You can do that in a weekend. The part nobody hands you is everything that happens after the view.',
            'Your page is a storefront. Content brings people through the door. But a store with empty shelves does not make a dime, no matter how many people walk in.',
            'That is exactly why I wrote Build Your AI Empire. It is the money half. What to actually sell, how to grow an audience you own, how to turn a viewer into a buyer, and how to scale it with ads.',
            'Seventeen dollars. One time. Yours forever.',
          ],
          cta: { label: 'Get the playbook for $17', url: PAGE.playbook },
        }),
      }),
    }),
  },
  {
    id: 'drip:welcome-4-sent',
    gate: (c, now) => hasTag(c, 'drip:welcome-3-sent') && needsTag(c, 'drip:welcome-4-sent') && lastSendMs(c, now) >= 2 * DAYS,
    send: (c) => ({
      subject: '"But I have no audience yet"',
      html: brandedEmail({
        preheader: 'Good. Build it in the right order.',
        body: emailBody({
          title: 'The most common objection I hear.',
          paragraphs: [
            'You do not need a big audience to start making money. You need an offer, and a way to capture the people who are already watching. A small page with the right system beats a huge page with no system, every single time.',
            'That is what Build Your AI Empire walks you through, step by step. The offer. The list. The funnel. The four ways a faceless page actually makes money.',
            'It is the difference between a page that collects views and a page that pays your bills.',
          ],
          cta: { label: 'Grab the playbook', url: PAGE.playbook },
        }),
      }),
    }),
  },
  {
    id: 'drip:welcome-5-sent',
    gate: (c, now) => hasTag(c, 'drip:welcome-4-sent') && needsTag(c, 'drip:welcome-5-sent') && lastSendMs(c, now) >= 2 * DAYS,
    send: (c) => ({
      subject: 'The tool my mom actually used',
      html: brandedEmail({
        preheader: 'And a deal I put together for you.',
        body: emailBody({
          title: 'The Blueprint shows you the system. ScaleSolo is the engine that runs it.',
          paragraphs: [
            'It builds your avatar, your looks, and your voice, then generates and posts your content on its own. The same tool my mom used.',
            'Because you have been reading along, I want to make starting a no-brainer. Use the code SCALE on Founding Member and you do not get a discount, you get more. Fifty percent more video and AI credits, plus a one-on-one setup call where we help you get your brand live. Same price, more in the box.',
            'One catch. Founding is capped at one hundred spots, and once they are gone, that door closes.',
          ],
          cta: { label: 'Unlock the SCALE bonus', url: PAGE.founding },
        }),
      }),
      newTags: ['drip:welcome-done'],
    }),
  },
]

// Cron auth — Vercel cron sends `Authorization: Bearer <CRON_SECRET>` by
// convention. We also accept the legacy `x-cron-secret` header so manual
// curl invocations keep working. If CRON_SECRET is not set we let any
// caller in (this endpoint has no side effects an attacker would want —
// the worst they can do is trigger the next due email a bit early).
function cronAuthed(req) {
  const secret = process.env.CRON_SECRET
  if (!secret) return true
  const auth = req.headers.authorization || ''
  if (auth === `Bearer ${secret}`) return true
  if (req.headers['x-cron-secret'] === secret) return true
  return false
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (!cronAuthed(req)) return res.status(401).json({ error: 'unauthorized' })

  const profileId = process.env.FUNNEL_PROFILE_ID
  if (!profileId) return res.status(200).json({ ok: true, skipped: 'FUNNEL_PROFILE_ID not set' })

  const limit = Math.min(Number(req.query?.limit || 200), 500)

  // Pull active funnel contacts that haven't finished the welcome series.
  // We over-fetch a bit and gate per-step in-process; the contacts table
  // is small enough for this to be cheap.
  const rows = await supaFetch(
    `email_contacts?profile_id=eq.${profileId}&status=eq.active&tags=cs.{"funnel:lead-opt-in"}&select=id,email,name,tags,signed_up_at,last_drip_at&order=signed_up_at.asc&limit=${limit}`
  )

  const now = Date.now()
  const summary = { processed: 0, sent: 0, skipped: 0, errors: 0 }

  for (const c of (rows || [])) {
    summary.processed++

    // Welcome series is gated on opt-in age. Email #1 fires immediately
    // (the Blueprint-delivery safety net for bouncers). Later emails
    // have day-spacing gates inside each step.
    const step = STEPS.find((s) => s.gate(c, now))
    if (!step) { summary.skipped++; continue }

    const { subject, html, newTags = [] } = step.send(c)
    const result = await sendEmailSafe({ to: c.email, subject, html })
    if (!result) { summary.errors++; continue }

    const tagSet = new Set(c.tags || [])
    tagSet.add(step.id)
    for (const t of newTags) tagSet.add(t)
    await supaFetch(`email_contacts?id=eq.${c.id}`, {
      method: 'PATCH',
      body: { tags: Array.from(tagSet), last_drip_at: new Date().toISOString() },
    }).catch(() => {})
    await supaFetch('rpc/log_activity', {
      method: 'POST',
      body: {
        p_profile_id: profileId,
        p_contact_id: c.id,
        p_event_type: 'drip_email_sent',
        p_payload: { step: step.id, subject },
        p_source: 'cron',
      },
    }).catch(() => {})
    summary.sent++
  }

  return res.status(200).json({ ok: true, ...summary })
}
