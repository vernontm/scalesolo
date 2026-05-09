# ScaleSolo email templates

Branded HTML for every email ScaleSolo sends. Two layers:

| Layer | Where it's defined | Where it's sent from |
|---|---|---|
| **Auth** (signup confirm, magic link, password reset, email change) | `supabase/email-templates/*.html` (this folder) | Supabase Auth — paste into the dashboard |
| **Transactional** (purchase, upgrade, downgrade, cancel, payment failed) | `api/_lib/email-templates.js` | Stripe webhook → Resend |

Both layers use the same brand mark, fonts, layout, and CTA-button style so user-visible mail looks consistent across the lifecycle.

## Required env vars (Vercel — Production)

| Name | Value |
|---|---|
| `RESEND_API_KEY` | `re_…` from Resend → API Keys |
| `RESEND_FROM` | `ScaleSolo <noreply@scalesolo.ai>` |
| `RESEND_REPLY_TO` | `support@scalesolo.ai` |

The auth layer doesn't read these — Supabase ships the auth emails over its own SMTP wired to Resend. The transactional layer (Stripe webhook → Resend HTTP API) is the only consumer.

## Wiring Supabase to send via Resend (one-time)

Supabase dashboard → **Authentication → Emails → SMTP Settings** → toggle **Enable Custom SMTP** and fill in:

| Field | Value |
|---|---|
| Sender email | `noreply@scalesolo.ai` |
| Sender name | `ScaleSolo` |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` (literally that string, not your Resend account email) |
| Password | the same `re_…` API key you put in Vercel |

Save. The auth emails Supabase already sends will now come from Resend over your verified `scalesolo.ai` domain.

## Pasting the auth templates

For each `.html` file in this folder, copy the entire contents (skip the `{# … #}` header comment — that's documentation only) and paste it into the matching Supabase template:

| File | Supabase template name | Suggested subject |
|---|---|---|
| `confirm-signup.html` | Confirm signup | `Confirm your ScaleSolo account` |
| `magic-link.html` | Magic Link | `Your ScaleSolo sign-in link` |
| `reset-password.html` | Reset Password | `Reset your ScaleSolo password` |
| `change-email.html` | Change Email Address | `Confirm your new ScaleSolo email` |

Set the matching subject line in the field above each template editor.

## Auth template variables

Supabase substitutes Go-template variables at send time. The templates here use:

- `{{ .ConfirmationURL }}` — the click-through URL (already includes the token + redirect to `/auth/callback`)
- `{{ .Email }}` — the user's current email
- `{{ .NewEmail }}` — only meaningful in `change-email.html`
- `{{ .SiteURL }}` — configured in Auth → URL Configuration; we don't reference it directly because `ConfirmationURL` already has it baked in

## Transactional emails (auto, no action needed)

Triggered by `api/stripe-webhook.js` based on Stripe events:

| Event | Email |
|---|---|
| `customer.subscription.created` (status active/trialing) | Welcome / first-purchase |
| `customer.subscription.updated` (tier rank up) | Upgrade |
| `customer.subscription.updated` (tier rank down) | Downgrade |
| `customer.subscription.updated` (cancel_at_period_end → true) | Cancellation scheduled |
| `customer.subscription.deleted` | Cancellation final |
| `invoice.payment_failed` | Payment issue |

No emails fire on:
- billing-cycle swap (monthly ↔ annual same tier)
- routine `invoice.payment_succeeded` (would spam at every renewal)
- `incomplete` / `incomplete_expired` status (transient)

## Customizing copy

- Auth templates: edit the corresponding `.html` file, then re-paste into the Supabase dashboard. (No automatic deploy — Supabase only knows the version you pasted.)
- Transactional: edit `api/_lib/email-templates.js` and redeploy. Vercel picks it up on next webhook.

## Local testing the transactional layer

The webhook runs on Edge Runtime, so you can replay an event with the Stripe CLI:

```
stripe trigger customer.subscription.created
stripe trigger invoice.payment_failed
```

Use `stripe listen --forward-to https://scalesolo.ai/api/stripe-webhook` (or your local tunnel) to point Stripe at the webhook. Resend's dashboard → Logs will show the outbound email almost immediately.

## Deliverability checklist

If emails land in spam:

1. Resend dashboard → Domains → `scalesolo.ai` should show all four DNS records green (MX, SPF, DKIM, DMARC).
2. From-address must be on a verified domain. We use `noreply@scalesolo.ai` — this only works because the domain is verified in Resend.
3. Reply-To must also be on a real domain (`support@scalesolo.ai` works even before that mailbox exists, because Resend doesn't try to deliver TO it; it's just the header).
4. No image-only content — every template here has actual prose, which spam filters reward.
5. Plain-text alternative — the transactional layer ships one alongside the HTML. Auth templates don't (Supabase handles plain-text fallback automatically).
