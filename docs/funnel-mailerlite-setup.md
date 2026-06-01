# Funnel MailerLite Setup

Wires the marketing funnel (free-blueprint → tripwire → DFY) into the
Vernon Tech & Media MailerLite account so we can run nurture and
win-back automations on every contact regardless of where they fell off.

> Per-tenant MailerLite (configured per ScaleSolo customer in
> `email_config`) is unrelated. This integration is for the **funnel** —
> Rayvaughn's own list.

---

## 1. Get an API key

1. Log in to MailerLite ▸ Integrations ▸ MailerLite API.
2. Generate a new API token. Name it `scalesolo-funnel`.
3. Save the token as `MAILERLITE_API_KEY` in Vercel Project Settings ▸
   Environment Variables (Production + Preview).

## 2. Create the groups

In MailerLite ▸ Subscribers ▸ Groups, create six groups:

| Group name (suggested)               | Env var                                 | Receives                                                                   |
|--------------------------------------|-----------------------------------------|----------------------------------------------------------------------------|
| `ScaleSolo · Lead · Blueprint`       | `MAILERLITE_GROUP_LEAD`                 | Anyone who opted in on `/free-blueprint`. Also every buyer (they are also confirmed leads). |
| `ScaleSolo · Buyer · Tripwire`       | `MAILERLITE_GROUP_BUYER_TRIPWIRE`       | Paid the $17 playbook.                                                     |
| `ScaleSolo · Buyer · Content Pack`   | `MAILERLITE_GROUP_BUYER_PACK`           | Took the $9 order bump (always also in Tripwire).                          |
| `ScaleSolo · Buyer · Done-For-You`   | `MAILERLITE_GROUP_BUYER_DFY`            | Paid the $397 DFY launch (direct, OTO, or 3DS fallback).                   |
| `ScaleSolo · Declined · Tripwire`    | `MAILERLITE_GROUP_DECLINED_TRIPWIRE`    | Clicked "no thanks" on the tripwire shame-decline modal.                   |
| `ScaleSolo · Declined · DFY`         | `MAILERLITE_GROUP_DECLINED_DFY`         | Clicked "no thanks" on the DFY shame-decline modal.                        |

For each group, copy its id (visible in the URL when you click it) and
save it to the matching env var. Groups without a configured env var are
silently skipped — handy for staging.

## 3. How tagging fires

| Event                                                | Endpoint                       | Groups added              |
|------------------------------------------------------|--------------------------------|---------------------------|
| Visitor submits free-blueprint opt-in                | `POST /api/leads/subscribe`    | `lead`                    |
| Visitor confirms decline on tripwire modal           | `POST /api/leads/decline-offer`| `declined-tripwire`       |
| Visitor confirms decline on DFY modal                | `POST /api/leads/decline-offer`| `declined-dfy`            |
| Stripe Checkout completed (tripwire, $17)            | webhook `checkout.session.completed` | `lead`, `buyer-tripwire`           |
| Stripe Checkout completed (tripwire + bump, $26)     | same                           | `lead`, `buyer-tripwire`, `buyer-pack` |
| Stripe Checkout completed (DFY direct, $397)         | same                           | `lead`, `buyer-dfy`       |
| One-click OTO succeeded (off-session $397)           | webhook `payment_intent.succeeded` | `lead`, `buyer-dfy`   |
| OTO 3DS-fallback Checkout completed                  | webhook `checkout.session.completed` | `lead`, `buyer-dfy`   |

Tagging is **fire-and-forget**: if MailerLite is down or the API key is
missing, the funnel keeps working and the error is logged to the function
output.

## 4. Suggested automations

Build these inside MailerLite once the groups are receiving subscribers:

### `Lead · Blueprint` (entry: subscriber joins group)
1. Day 0 · "Your free Blueprint is on the way" (immediate)
2. Day 1 · "Did you read Chapter 2?" (nudge to brand-voice section)
3. Day 2 · "Want the playbook that monetizes this?" → `/build-your-ai-empire`
4. Day 4 · "What happens if you skip the workflow step" → tripwire
5. Day 7 · "Last call on the playbook" + DFY mention

### `Buyer · Tripwire` (entry: subscriber joins group)
1. Day 0 · "Your playbook is in" (covers + login)
2. Day 1 · "Pick your first niche" (action prompt)
3. Day 3 · "Want me to just build it?" → `/done-for-you`
4. Day 7 · "Founding spot still open?" → SCALE pitch

### `Buyer · Done-For-You` (entry: subscriber joins group)
1. Day 0 · "Welcome to the build queue" + kickoff-call link
2. Day 1 · Brand questionnaire (text answers)
3. Day 7 · Onboarding video walkthrough
4. Day 14 · Check-in: how is the brand going

### `Declined · Tripwire`
1. Day 1 · "Hey, I get it" — soft re-pitch, half off (or value-stack) for 48h
2. Day 3 · Case-study email
3. Day 7 · Drop them into the regular Lead nurture

### `Declined · DFY`
1. Day 1 · "If $397 is the issue, try the playbook" → `/build-your-ai-empire`
2. Day 7 · Drop them into the regular Lead nurture

> **Mutual exclusion:** decline automations should be set to remove the
> subscriber from the active Lead nurture so the visitor doesn't get
> two cadences at once. Use MailerLite "Action ▸ Remove from group" at
> the start of the decline flow.

## 5. Testing

```
# Set the envs locally first
vercel env pull .env.local

# Opt in flow
curl -X POST http://localhost:3000/api/leads/subscribe \
  -H 'Content-Type: application/json' \
  -d '{"email":"you+test@yourdomain.com","name":"Test Lead"}'

# Decline tripwire flow (after the opt-in above)
curl -X POST http://localhost:3000/api/leads/decline-offer \
  -H 'Content-Type: application/json' \
  -d '{"email":"you+test@yourdomain.com","offer":"tripwire"}'
```

Then check MailerLite ▸ Subscribers and confirm the email landed in
the right groups.
