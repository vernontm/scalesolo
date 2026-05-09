// Shared email helpers — Resend client + branded HTML layout. Used by
// the Stripe webhook for transactional billing emails. Supabase auth
// emails are configured separately in the Supabase dashboard (the HTML
// templates live in supabase/email-templates/ for source control).

const RESEND_API_KEY = process.env.RESEND_API_KEY
const FROM = process.env.RESEND_FROM || 'ScaleSolo <noreply@scalesolo.ai>'
const REPLY_TO = process.env.RESEND_REPLY_TO || 'support@scalesolo.ai'

// Inline SVG mark used in every email header. Embedded as an <img> with
// a data URI so it renders without an external host (which would cost
// us deliverability — many clients block external images by default).
// SVG renders crisply at any zoom and most clients support it inline.
// We provide a PNG fallback URL via a public asset for the small set of
// clients that don't render inline SVG (notably some Outlook desktop
// versions); they'll fall back to the brand text wordmark.
const BRAND_MARK_SVG_DATA = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#ef4444"/>
        <stop offset="100%" stop-color="#b91c1c"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="36" height="36" rx="9" fill="url(#g)"/>
    <polygon points="20 8 12 19 18 19 16 28 24 17 18 17 20 8" fill="#ffffff"/>
  </svg>`
)}`

// Light, deliverable email layout. Single CTA button. Brand red used
// only as accent + button, white background, clean typography. Inline
// styles only — Gmail strips <style> blocks. 600px max width is the
// industry standard for client compatibility.
export function brandedEmail({ preheader, body }) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ScaleSolo</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
${preheader ? `<div style="display:none;font-size:1px;color:#fefefe;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>` : ''}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f4f5;padding:36px 16px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,0.04);">
      <tr><td style="padding:30px 36px 22px;border-bottom:1px solid #f0f0f3;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0">
          <tr>
            <td style="vertical-align:middle;padding-right:12px;">
              <img src="${BRAND_MARK_SVG_DATA}" width="36" height="36" alt="ScaleSolo" style="display:block;border-radius:9px;">
            </td>
            <td style="vertical-align:middle;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-weight:800;font-size:18px;color:#0c0c0d;letter-spacing:-0.01em;">
              ScaleSolo
            </td>
          </tr>
        </table>
      </td></tr>
      <tr><td style="padding:30px 36px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1c1e;font-size:15px;line-height:1.6;">
        ${body}
      </td></tr>
      <tr><td style="padding:18px 36px 30px;border-top:1px solid #f0f0f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#74747a;font-size:12px;line-height:1.5;">
        Questions? Reply to this email and we'll get back to you.<br>
        <a href="https://scalesolo.ai" style="color:#ef4444;text-decoration:none;">scalesolo.ai</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`
}

// Standard CTA button as an inline-style HTML snippet. Email clients
// require width/padding inline for consistent rendering.
export function ctaButton({ label, url }) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:18px 0 8px;">
    <tr><td style="border-radius:10px;background:linear-gradient(135deg,#ef4444 0%,#b91c1c 100%);">
      <a href="${url}" style="display:inline-block;padding:13px 26px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-weight:700;font-size:14px;color:#ffffff;text-decoration:none;border-radius:10px;">${label}</a>
    </td></tr>
  </table>`
}

// Send via Resend. Throws on failure so callers can decide whether to
// surface the error. We deliberately don't wrap in try/catch here —
// the webhook handler swallows email errors so a Resend outage doesn't
// 500 a Stripe webhook (which would put it in retry-hell).
export async function sendEmail({ to, subject, html, text, replyTo }) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured')
  if (!to || !subject || !html) throw new Error('to, subject, html required')
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text: text || undefined,
      reply_to: replyTo || REPLY_TO,
    }),
  })
  if (!r.ok) {
    const detail = await r.text().catch(() => '')
    throw new Error(`Resend ${r.status}: ${detail.slice(0, 300)}`)
  }
  return r.json().catch(() => ({}))
}

// Best-effort variant that swallows + logs errors. Use this from
// non-critical paths (webhook handlers) so a Resend hiccup never
// breaks the upstream flow.
export async function sendEmailSafe(params) {
  try {
    return await sendEmail(params)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[email] send failed:', e.message)
    return null
  }
}
