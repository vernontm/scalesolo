# Email engine on Amazon SES

ScaleSolo sends campaign email through Amazon SES in the VTM AWS project
(account 063280428943, region us-east-2). Transactional product mail
(receipts, board invites) still goes through Resend; see `api/_lib/email.js`.

## What exists in AWS (provisioned 2026-10-22)

| Thing | Name | Notes |
|---|---|---|
| Configuration set | `scalesolo` | TLS required, reputation metrics on, suppresses bounces + complaints |
| Event destination | `sns-events` on that set | SEND, REJECT, BOUNCE, COMPLAINT, DELIVERY, OPEN, CLICK, RENDERING_FAILURE, DELIVERY_DELAY, SUBSCRIPTION |
| SNS topic | `arn:aws:sns:us-east-2:063280428943:scalesolo-ses-events` | HTTPS subscription to `https://www.scalesolo.ai/api/email/ses-webhook` (confirmed). Topic policy carries an `AllowSESPublish` statement for `ses.amazonaws.com` scoped to the configuration set ARN; without it SES events were silently dropped, which is what the console adds for you and the API does not. |
| Shared sending identity | `mail.scalesolo.ai` | Easy DKIM (RSA 2048), custom MAIL FROM `bounce.mail.scalesolo.ai` |
| Account suppression list | bounces + complaints | account wide |
| IAM user | `scalesolo-vercel-ses` | inline policy `scalesolo-ses-send`: SendEmail, SendBulkEmail, identity create/get/delete, GetAccount, suppression read/write |
| Production access | requested 2026-10-22 | until approved the account is in sandbox: 200 messages/day, 1/second, verified recipients only |

Resend's own records live on `send.scalesolo.ai`. Do not touch those.

## DNS records for mail.scalesolo.ai (Namecheap, scalesolo.ai zone)

Namecheap wants the host relative to `scalesolo.ai`, so `x.mail` below
means the full name `x.mail.scalesolo.ai`.

| Type | Host | Value | Why |
|---|---|---|---|
| CNAME | `zexk2elguaeib3vilee2coypms467462._domainkey.mail` | `zexk2elguaeib3vilee2coypms467462.dkim.amazonses.com` | DKIM 1 of 3 |
| CNAME | `jihncrcju6kxnvq6ws6rqx7w4tadkiyh._domainkey.mail` | `jihncrcju6kxnvq6ws6rqx7w4tadkiyh.dkim.amazonses.com` | DKIM 2 of 3 |
| CNAME | `glg24tvaitkqixgzr7di2ekscnngmaem._domainkey.mail` | `glg24tvaitkqixgzr7di2ekscnngmaem.dkim.amazonses.com` | DKIM 3 of 3 |
| MX | `bounce.mail` | `feedback-smtp.us-east-2.amazonses.com` priority 10 | custom MAIL FROM |
| TXT | `bounce.mail` | `v=spf1 include:amazonses.com ~all` | SPF for MAIL FROM |

The root `_dmarc.scalesolo.ai` already says `v=DMARC1; p=none;`, which
covers the subdomain. SES marks the identity verified once the three
CNAMEs resolve (usually within an hour, up to 72 hours). Check with:

```bash
dig +short CNAME zexk2elguaeib3vilee2coypms467462._domainkey.mail.scalesolo.ai
```

## Vercel environment

Set on production and preview. The `SES_*` names are deliberate: Vercel
reserves `AWS_*`.

| Var | Value |
|---|---|
| `SES_ACCESS_KEY_ID` | access key for IAM user `scalesolo-vercel-ses` (create in IAM console, never commit) |
| `SES_SECRET_ACCESS_KEY` | its secret |
| `SES_REGION` | `us-east-2` |
| `SES_CONFIGURATION_SET` | `scalesolo` |
| `SES_SHARED_DOMAIN` | `mail.scalesolo.ai` |
| `SES_SNS_TOPIC_ARN` | the topic ARN above (the webhook rejects other topics) |
| `SES_SEND_RATE` | `8` (messages per second the worker paces to; raise after production access) |
| `EMAIL_LINK_SECRET` | optional HMAC secret for unsubscribe links; falls back to `CRON_SECRET` |

## Database

Migration `supabase/migrations/0077_ses_email_engine.sql` (propose-only,
apply by hand in the scalesolo project `vbvmfiepwyxlfafbwtkb`):

- `email_config`: provider check now allows `ses` (default), adds `postal_address`
- `email_campaigns`: delivered / bounced / complained / unsubscribed counters, sender snapshot, `started_at`, `last_error`
- new `email_domains`, `email_sends`, `email_suppressions`
- `bump_email_campaign_counter(uuid, text, int)` for atomic counter updates from the webhook

Nothing in the Email page works until this migration is applied.

## How a send works

1. The Email page saves the campaign (`api/email/campaigns.js`), then
   `action=send` flips it to `sending` and runs the worker inline for up to
   40 seconds.
2. `api/cron/email-send.js` runs every minute, promotes due scheduled
   campaigns, and keeps working through anything still `sending`.
3. The worker (`api/_lib/email-send-worker.js`) claims each contact by
   inserting an `email_sends` row before calling SES. The unique index on
   `(campaign_id, contact_id)` is the post-once guarantee. A refused send is
   recorded as failed and never retried; only a throttle releases the row.
4. SES events arrive via SNS at `api/email/ses-webhook.js` (signature
   verified). Permanent bounces and complaints suppress the address for
   every brand and flip the contact's status. Unsubscribes come through
   `api/email/unsubscribe.js` and suppress per brand.

## Brand domains

A brand adds its domain in Email > Sender. That creates an SES identity
with Easy DKIM and MAIL FROM `bounce.<domain>`, shows the DNS records, and
"Verify" re-reads the status from SES. Until verified the brand can send
from any address on `mail.scalesolo.ai`.

## Sandbox testing

While the account is in sandbox, every recipient (including test sends)
must be a verified identity in SES. Verify an address from the SES console
(Identities > Create identity > Email address) and SES emails a
confirmation link to it.

## Mailgun (added 2026-10-24)

SES production access was DENIED (case 179269796600754), so that account can
only reach verified addresses. Mailgun was added alongside it rather than
replacing it: SES is roughly ten times cheaper, so if the appeal lands a brand
can be moved back by changing one column.

Which provider a brand uses is `email_config.email_provider` (`ses` or
`mailgun`). `api/_lib/email-provider.js` dispatches; `api/_lib/ses.js` and
`api/_lib/mailgun.js` implement the same interface.

| Thing | Value |
|---|---|
| Shared sending domain | `mg.scalesolo.ai` (SPF + DKIM + tracking CNAME, verified 2026-10-24) |
| Per-client domains | `<client>.mg.scalesolo.ai`, created via the Mailgun API + the Namecheap MCP |
| Event webhook | `https://www.scalesolo.ai/api/email/mailgun-webhook` |

Keep client marketing under `mg.`. Never put it on `send.scalesolo.ai`
(Resend, transactional) or `mail.scalesolo.ai` (SES): a client's stale list
must not sit next to password resets and board invites.

### Env (Vercel, never committed)

| Name | Notes |
|---|---|
| `MAILGUN_API_KEY` | Private API key. Rotate if it is ever pasted anywhere. |
| `MAILGUN_WEBHOOK_SIGNING_KEY` | Webhook signing key, NOT the sending key. Without it the webhook rejects everything with 401. |
| `MAILGUN_SHARED_DOMAIN` | Defaults to `mg.scalesolo.ai`. |
| `MAILGUN_BASE_URL` | Defaults to `https://api.mailgun.net`. Use the EU host for the EU region. |
| `EMAIL_PROVIDER` | Default for brands with nothing saved. Defaults to `ses` (changed from `mailgun` on 2026-10-29, once SES production access was granted). |

### Two things that fail silently, both covered by tests

Mailgun returns a message id wrapped in angle brackets on send and reports it
bare on every webhook event. If the two are not normalized, a bounce never
finds its send row and the address is never suppressed, so it is mailed again
forever. Both sides go through `normalizeMessageId`.

The webhook verifies Mailgun's HMAC and rejects anything older than 15
minutes. Without the signing key set, anyone who learns the URL could mark a
brand's whole list as bounced.


## Adding leads from outside ScaleSolo

`POST /api/email/subscribe` puts a lead or customer onto one brand's list.
Use it from a website backend, a Zapier or Make automation, or a webhook from
Shopify, Calendly or Stripe.

```bash
curl -X POST https://www.scalesolo.ai/api/email/subscribe \
  -H "x-api-key: ssk_live_..." \
  -H "content-type: application/json" \
  -d '{"email":"jane@example.com","name":"Jane","phone":"+15551234567",
       "tags":["funnel:lead-opt-in"],"source":"website-footer"}'
```

Returns `200 {"ok":true,"contact_id":"...","created":true}`. Issue and revoke
keys on the Email page, Sender tab, as a brand admin.

**Send a tag.** A drip automation triggers on a tag, so a lead posted with
`tags:["funnel:lead-opt-in"]` starts that brand's sequence on the next runner
tick, within a minute. With no tag the contact just lands on the list and
waits for a broadcast.

**The key is scoped to one brand**, which is why this endpoint exists at all.
The only credential that could previously add a tagged contact was
`WORKFLOW_INTERNAL_SECRET`, and that impersonates a user across every brand on
the account, so it could never be given to a client or a third-party tool.

**Keep it server side.** There is deliberately no CORS header, so a browser
cannot call it. A key that writes to a client's mailing list is a secret, and
anything pasted into a public page is not. Website forms do not need a key:
the Forms and Landing Pages tabs already capture leads publicly, and both now
tag what they capture as `form:<slug>` and `landing:<slug>`.

Only the SHA-256 of a key is stored. The UI shows a new key once and it
cannot be read back, so a lost key is replaced rather than recovered.

### What it refuses, and why that is not an error

| Response | Meaning |
|---|---|
| `{"ok":true,"skipped":"suppressed"}` | The address bounced or reported spam before. It is not added. |
| `{"ok":true,"skipped":"unsubscribed"}` | That person opted out. Their tags still update, but they stay unsubscribed. |
| `{"ok":true,"skipped":"unchanged"}` | Already on the list with these details. |
| `401 {"code":"bad_key"}` | Unknown, malformed or revoked key. The same message for all three, so a caller learns nothing about which keys exist. |
| `429 {"code":"rate_limited"}` | Over 600 per hour on one key. |

These come back as `ok: true` rather than an error because the caller did
nothing wrong and a retry will not change the outcome.

Refusing to reactivate someone who unsubscribed is the rule worth keeping. A
sync pointed at a stale export would otherwise quietly re-subscribe everyone
who had opted out, which is the fastest route to a complaint, and complaints
are measured against the one SES account that every brand sends through.
Someone who genuinely re-subscribes is reactivated by hand on the Subscribers
tab, which is a deliberate act and leaves a trail.
