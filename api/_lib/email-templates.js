// Transactional email templates for billing lifecycle events. Each
// function returns { subject, html, text } that the Stripe webhook
// passes straight to sendEmailSafe(). Plain-text alternative is kept
// short — Gmail's clipping rule says messages over ~102KB get clipped,
// and most spam filters trust messages with both parts present.

import { brandedEmail, ctaButton } from './email.js'

const APP_URL = process.env.SCALESOLO_DOMAIN || process.env.FRONTEND_URL || 'https://scalesolo.ai'

const fmtUsd = (cents) => {
  if (cents == null) return ''
  const n = Number(cents) / 100
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
}

// Welcome / first-purchase confirmation. Fires when a user starts a
// new paid subscription (first time on this customer). Reassures them
// it processed and points at the dashboard.
export function purchaseEmail({ tierName, amountCents, billingCycle = 'monthly', email }) {
  const subject = `Welcome to ScaleSolo ${tierName}`
  const cycleLabel = billingCycle === 'annual' ? 'year' : 'month'
  const html = brandedEmail({
    preheader: `Your ${tierName} plan is active. Time to launch your faceless brand.`,
    body: `<h1 style="margin:0 0 14px;font-weight:800;font-size:22px;color:#0c0c0d;letter-spacing:-0.01em;">You're in.</h1>
<p style="margin:0 0 12px;">Your <strong>${tierName}</strong> plan is active${amountCents ? ` at <strong>${fmtUsd(amountCents)} / ${cycleLabel}</strong>` : ''}. Credits have been added to your workspace, and every workflow you've built is ready to run.</p>
<p style="margin:0 0 12px;">Start with a template, plug in your brand, and let the autopilot do the rest.</p>
${ctaButton({ label: 'Open your dashboard', url: `${APP_URL}/dashboard` })}
<p style="margin:18px 0 0;color:#74747a;font-size:13px;">Need help getting set up? Reply to this email and we'll point you in the right direction.</p>`,
  })
  const text = `You're in.\n\nYour ${tierName} plan is active${amountCents ? ` at ${fmtUsd(amountCents)} / ${cycleLabel}` : ''}. Credits have been added to your workspace.\n\nOpen your dashboard: ${APP_URL}/dashboard\n\nNeed help? Reply to this email.`
  return { subject, html, text }
}

// Plan upgrade — user moved from a lower tier to a higher one mid-cycle.
// Stripe prorates the difference; we just confirm what's now active.
export function upgradeEmail({ tierName, amountCents, billingCycle = 'monthly', previousTierName }) {
  const subject = `You're now on ScaleSolo ${tierName}`
  const cycleLabel = billingCycle === 'annual' ? 'year' : 'month'
  const html = brandedEmail({
    preheader: `Upgraded${previousTierName ? ` from ${previousTierName}` : ''}. Higher limits unlocked.`,
    body: `<h1 style="margin:0 0 14px;font-weight:800;font-size:22px;color:#0c0c0d;letter-spacing:-0.01em;">Upgraded.</h1>
<p style="margin:0 0 12px;">You're now on the <strong>${tierName}</strong> plan${previousTierName ? `, up from ${previousTierName}` : ''}${amountCents ? `. New rate: <strong>${fmtUsd(amountCents)} / ${cycleLabel}</strong>` : ''}. Stripe handled the proration on your last invoice.</p>
<p style="margin:0 0 12px;">Higher credit limits, more brand profiles, and any tier-gated templates are unlocked immediately.</p>
${ctaButton({ label: 'See what unlocked', url: `${APP_URL}/billing` })}`,
  })
  const text = `Upgraded to ScaleSolo ${tierName}${previousTierName ? ` from ${previousTierName}` : ''}${amountCents ? ` at ${fmtUsd(amountCents)} / ${cycleLabel}` : ''}.\n\nManage your plan: ${APP_URL}/billing`
  return { subject, html, text }
}

// Plan downgrade — user moved from a higher tier to a lower one. The
// downgrade typically takes effect at the end of the current period;
// the message is informational with a soft "we'll be here when you
// want to come back" tone.
export function downgradeEmail({ tierName, previousTierName, periodEndIso }) {
  const subject = `Your ScaleSolo plan was updated`
  const dateLabel = periodEndIso ? new Date(periodEndIso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null
  const html = brandedEmail({
    preheader: `Switched to ${tierName}${dateLabel ? ` starting ${dateLabel}` : ''}.`,
    body: `<h1 style="margin:0 0 14px;font-weight:800;font-size:22px;color:#0c0c0d;letter-spacing:-0.01em;">Plan updated.</h1>
<p style="margin:0 0 12px;">Your subscription is moving to the <strong>${tierName}</strong> plan${previousTierName ? ` from ${previousTierName}` : ''}${dateLabel ? `, effective <strong>${dateLabel}</strong>` : ''}. Until then, you keep your current limits.</p>
<p style="margin:0 0 12px;">When the new plan kicks in, anything beyond ${tierName}'s limits stays in your workspace, just paused. Upgrade anytime to unlock it again.</p>
${ctaButton({ label: 'Manage billing', url: `${APP_URL}/billing` })}`,
  })
  const text = `Your ScaleSolo plan is moving to ${tierName}${previousTierName ? ` from ${previousTierName}` : ''}${dateLabel ? `, effective ${dateLabel}` : ''}.\n\nManage billing: ${APP_URL}/billing`
  return { subject, html, text }
}

// Cancellation — covers both immediate cancel and end-of-period cancel.
// We tell the user when access actually ends and give them a one-click
// path to come back.
export function cancelEmail({ tierName, periodEndIso, immediate = false }) {
  const subject = `Your ScaleSolo subscription was cancelled`
  const dateLabel = periodEndIso ? new Date(periodEndIso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null
  const accessLine = immediate
    ? 'Your access ends now.'
    : dateLabel
      ? `You'll keep <strong>${tierName}</strong> access until <strong>${dateLabel}</strong>.`
      : `You'll keep <strong>${tierName}</strong> access through the end of your current billing period.`
  const html = brandedEmail({
    preheader: `Cancelled. ${immediate ? 'Access ends now.' : `Access continues${dateLabel ? ` until ${dateLabel}` : ''}.`}`,
    body: `<h1 style="margin:0 0 14px;font-weight:800;font-size:22px;color:#0c0c0d;letter-spacing:-0.01em;">Cancellation confirmed.</h1>
<p style="margin:0 0 12px;">${accessLine}</p>
<p style="margin:0 0 12px;">Your spaces, brand profiles, and library stick around. If you ever come back, everything's exactly where you left it.</p>
${ctaButton({ label: 'Reactivate anytime', url: `${APP_URL}/billing` })}
<p style="margin:18px 0 0;color:#74747a;font-size:13px;">If something didn't work for you, we'd love to hear about it — just reply.</p>`,
  })
  const text = `Cancellation confirmed.\n\n${immediate ? 'Your access ends now.' : `You'll keep ${tierName} access${dateLabel ? ` until ${dateLabel}` : ' through the end of your current billing period'}.`}\n\nReactivate anytime: ${APP_URL}/billing`
  return { subject, html, text }
}

// Payment failed — Stripe will retry, but the user should know so they
// can update their card before the retry burns out. Different from
// cancel: subscription is still alive, just at risk.
export function paymentFailedEmail({ tierName, amountCents }) {
  const subject = `Payment issue on your ScaleSolo plan`
  const html = brandedEmail({
    preheader: `We couldn't charge your card. Update payment to keep your plan active.`,
    body: `<h1 style="margin:0 0 14px;font-weight:800;font-size:22px;color:#0c0c0d;letter-spacing:-0.01em;">Payment didn't go through.</h1>
<p style="margin:0 0 12px;">We tried to charge your card${amountCents ? ` <strong>${fmtUsd(amountCents)}</strong>` : ''} for your <strong>${tierName}</strong> plan and it didn't process. We'll retry automatically over the next few days, but updating your payment method now keeps your access uninterrupted.</p>
${ctaButton({ label: 'Update payment method', url: `${APP_URL}/billing` })}
<p style="margin:18px 0 0;color:#74747a;font-size:13px;">If the card on file is correct and you think this is an error, reply and we'll dig in.</p>`,
  })
  const text = `Payment didn't go through.\n\nWe couldn't charge${amountCents ? ` ${fmtUsd(amountCents)}` : ''} for your ${tierName} plan. Update payment to keep your access uninterrupted: ${APP_URL}/billing`
  return { subject, html, text }
}
