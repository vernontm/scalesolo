// Rendering + sender resolution for campaign email.
//
//   resolveSender(profileId)   who a brand sends as, and whether it is allowed to
//   renderCampaignEmail(...)   merge tags, wrap in the responsive shell, append
//                              the CAN-SPAM footer with the unsubscribe link
//   unsubscribeToken(contact)  HMAC so an unsubscribe link cannot be forged for
//                              someone else's address
//
// Ported from the VTM CRM's email-html.js wrapper, with the footer and
// personalization moved server-side so every send gets them whether the
// body came from the AI composer or was pasted in as raw HTML.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { supaFetch } from './supabase.js'
import { sharedDomain, providerNameFor } from './email-provider.js'
import { domainOf } from './email-domain.js'

const APP_URL = process.env.SCALESOLO_DOMAIN || process.env.FRONTEND_URL || 'https://www.scalesolo.ai'

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// A slug a brand can send from on the shared domain: "Sanabreh Mediterranean"
// becomes sanabreh-mediterranean@mail.scalesolo.ai.
export function sharedLocalPart(businessName) {
  const slug = String(businessName || 'hello').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return slug || 'hello'
}

// Load the brand's email_config and decide whether its from address is
// allowed: either on the shared domain, or on one of the brand's verified
// domains. Returns { ok, config, profile, reason }.
export async function resolveSender(profileId) {
  const [profiles, configs] = await Promise.all([
    supaFetch(`profiles?id=eq.${encodeURIComponent(profileId)}&select=id,business_name,website_url,location`),
    supaFetch(`email_config?profile_id=eq.${encodeURIComponent(profileId)}&select=*&limit=1`),
  ])
  const profile = profiles?.[0] || null
  const config = configs?.[0] || null
  if (!profile) return { ok: false, reason: 'Brand profile not found', profile, config }
  if (!config?.from_email) return { ok: false, reason: 'Set a sender name and from address in the Sender tab first.', profile, config }

  const fromDomain = domainOf(config.from_email)
  if (!fromDomain) return { ok: false, reason: 'From address is not a valid email.', profile, config }

  // Each brand names its own provider; the shared fallback domain differs
  // per provider, so resolve that before deciding whether this From is usable.
  const provider = providerNameFor(config.email_provider)
  const shared = sharedDomain(provider)

  let verifiedVia = null
  if (fromDomain === shared) {
    verifiedVia = 'shared'
  } else {
    const rows = await supaFetch(`email_domains?profile_id=eq.${encodeURIComponent(profileId)}&domain=eq.${encodeURIComponent(fromDomain)}&select=status&limit=1`)
    if (rows?.[0]?.status === 'verified') verifiedVia = 'domain'
    else return { ok: false, reason: `${fromDomain} is not verified yet. Add the DNS records in the Sender tab, or send from ${shared}.`, profile, config, provider }
  }
  return { ok: true, profile, config, verifiedVia, provider }
}

const UNSUB_SECRET = () => process.env.EMAIL_LINK_SECRET || process.env.CRON_SECRET || process.env.SUPABASE_SERVICE_KEY || ''

export function unsubscribeToken(contactId) {
  return createHmac('sha256', UNSUB_SECRET()).update(String(contactId)).digest('hex').slice(0, 32)
}

export function verifyUnsubscribeToken(contactId, token) {
  if (!contactId || !token) return false
  const expected = Buffer.from(unsubscribeToken(contactId))
  const given = Buffer.from(String(token))
  return expected.length === given.length && timingSafeEqual(expected, given)
}

export function unsubscribeUrl({ contactId, campaignId }) {
  const u = new URL('/api/email/unsubscribe', APP_URL)
  u.searchParams.set('c', contactId)
  u.searchParams.set('t', unsubscribeToken(contactId))
  if (campaignId) u.searchParams.set('k', campaignId)
  return u.toString()
}

// {{name}}, {{first_name}}, {{email}}, {{business}} and {{unsubscribe_url}}.
// Unknown tags are left alone so a literal "{{" in copy does not vanish.
export function mergeTags(input, vars) {
  return String(input ?? '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, key) => {
    const k = key.toLowerCase()
    return Object.prototype.hasOwnProperty.call(vars, k) ? escapeHtml(vars[k] ?? '') : m
  })
}

export function mergeVarsFor({ contact, profile, campaignId }) {
  const name = String(contact?.name || '').trim()
  const first = name.split(/\s+/)[0] || ''
  return {
    name: name || 'there',
    first_name: first || 'there',
    email: contact?.email || '',
    business: profile?.business_name || '',
    unsubscribe_url: contact?.id ? unsubscribeUrl({ contactId: contact.id, campaignId }) : '#',
  }
}

// Very small HTML -> text so every message has a plain-text part (spam
// filters trust multipart messages more, and some clients prefer it).
export function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => `${label.replace(/<[^>]+>/g, '').trim()} (${href})`)
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ── brand theming ──────────────────────────────────────────────────────────
//
// One shell that reads the brand rather than one template per brand. Eight
// copies of a template drift apart and every new brand needs another file;
// this way a brand is styled the moment someone fills in its profile.
//
// Everything here is defensive because the data is hand-entered and already
// wrong in three ways in production: a colour saved as " #ffcf00" with a
// leading space (silently breaks the CSS value it is pasted into), a brand
// with no colours at all, and website URLs with no scheme.

// Accept only a real hex colour. Anything else returns null and the caller
// falls back, so a typo cannot inject into a style attribute either.
export function safeHex(v) {
  const s = String(v ?? '').trim()
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return null
  if (s.length !== 4) return s.toLowerCase()
  // Expand #abc so downstream luminance maths has one shape to deal with.
  return ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase()
}

export const DARK_INK = '#1a1a2e'

// Relative luminance, WCAG definition.
export function luminance(hex) {
  const h = safeHex(hex)
  if (!h) return null
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrastRatio(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  if (la === null || lb === null) return 1
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// Pick the text colour that is actually more readable on a background, by
// comparing contrast ratios rather than guessing at a luminance cutoff.
//
// A threshold gets this wrong in the middle of the range: gold (#c9a84c) sits
// just dark enough to look like it wants white text, but white on it is a
// ratio of about 2.3 against roughly 9 for dark ink. Two of these brands are
// gold or teal, so the middle of the range is exactly where they live.
export function readableOn(hex) {
  if (!safeHex(hex)) return DARK_INK
  return contrastRatio(hex, '#ffffff') >= contrastRatio(hex, DARK_INK) ? '#ffffff' : DARK_INK
}

// A URL an inbox can actually follow. A scheme-less value like
// "lisavgreeninspires.com" becomes a RELATIVE href in an email client, which
// is a dead link, so it gets https:// put in front of it.
export function emailSafeUrl(v) {
  const s = String(v ?? '').trim()
  if (!s) return null
  if (/^https?:\/\//i.test(s)) return s
  if (/^(mailto|tel):/i.test(s)) return s
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s)) return `https://${s}`
  return null
}

export function brandTheme(profile) {
  const primary = safeHex(profile?.brand_primary_color)
  const secondary = safeHex(profile?.brand_secondary_color)
  // The header band only appears when the brand actually has a colour or a
  // logo. Without either, the email stays on the neutral shell rather than
  // inventing a look for a brand nobody has set up.
  const band = primary || null
  return {
    primary,
    secondary,
    band,
    onBand: band ? readableOn(band) : '#1a1a2e',
    // Links pick the darker of the two brand colours so they stay legible on
    // the white body; a pale brand colour falls back to the default blue.
    link: [primary, secondary].find((c) => c && readableOn(c) === '#ffffff') || '#2563eb',
    logo: emailSafeUrl(profile?.logo_url),
    site: emailSafeUrl(profile?.website_url),
  }
}

// The masthead. A logo if the brand has one, otherwise its name set on the
// brand colour. Returns '' when the brand has neither, so an unconfigured
// brand keeps the plain shell instead of getting an empty coloured bar.
//
// Height is capped rather than set, because logos here range from a square
// mark to a wide wordmark and a fixed height distorts one of them. Outlook
// ignores max-height on images, hence the explicit height:auto and the band
// being a table cell rather than a div.
function brandHeader(theme, profile, fromName) {
  const name = profile?.business_name || fromName || ''
  if (!theme.logo && !theme.band) return ''
  const bg = theme.band || '#ffffff'
  const fg = theme.band ? theme.onBand : '#1a1a2e'
  const content = theme.logo
    ? `<img src="${escapeHtml(theme.logo)}" alt="${escapeHtml(name)}" height="40" style="display:block;margin:0 auto;height:40px;width:auto;max-height:40px;border:0;outline:none;text-decoration:none;" />`
    : `<span style="font-size:19px;font-weight:700;letter-spacing:-0.01em;color:${fg};">${escapeHtml(name)}</span>`
  return `<tr>
            <td align="center" style="background:${bg};padding:22px 32px;">
              ${content}
            </td>
          </tr>`
}

// Wrap a body (plain text, an HTML fragment, or a full document) in the
// responsive shell and append the footer. The footer is always appended,
// even to full documents, because the unsubscribe link is not optional.
export function renderCampaignEmail({ subject, previewText, body, fromName, profile, config, vars }) {
  const raw = mergeTags(body || '', vars)
  const theme = brandTheme(profile)
  const header = brandHeader(theme, profile, fromName)
  const preheader = previewText
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f5f7fa;opacity:0;">${escapeHtml(mergeTags(previewText, vars))}</div>`
    : ''

  const footerLines = [
    escapeHtml(profile?.business_name || fromName || ''),
    config?.postal_address ? escapeHtml(config.postal_address) : '',
    theme.site ? `<a href="${escapeHtml(theme.site)}" style="color:#8e8ea0;">${escapeHtml(theme.site.replace(/^https?:\/\//, ''))}</a>` : '',
  ].filter(Boolean).join('<br>')
  const footer = `<div style="font-size:11px;line-height:1.6;color:#8e8ea0;padding:18px 10px 0;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  ${footerLines}${footerLines ? '<br>' : ''}
  You are receiving this because you signed up for updates from ${escapeHtml(profile?.business_name || fromName || 'us')}.
  <a href="${vars.unsubscribe_url}" style="color:#8e8ea0;text-decoration:underline;">Unsubscribe</a>
</div>`

  // Full document: inject preheader + footer, leave the rest alone.
  if (/<!DOCTYPE|<html[\s>]/i.test(raw)) {
    let doc = raw
    if (preheader && !/preheader/i.test(doc)) doc = doc.replace(/<body[^>]*>/i, (m) => `${m}\n${preheader}`)
    if (!/unsubscribe/i.test(doc)) doc = doc.replace(/<\/body>/i, `${footer}\n</body>`)
    else doc = doc.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, vars.unsubscribe_url)
    return doc
  }

  const hasBlockTags = /<(p|div|h[1-6]|ul|ol|li|br|a|strong|em|b|i|img|table)\b/i.test(raw)
  const inner = hasBlockTags
    ? raw
    : escapeHtml(raw).split(/\n{2,}/).map((p) => `<p style="margin:0 0 16px 0;">${p.replace(/\n/g, '<br>')}</p>`).join('\n')

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject || '')}</title>
</head>
<body style="margin:0;padding:0;background:#f5f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a2e;">
  ${preheader}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fa;padding:30px 10px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(10,20,40,0.06);overflow:hidden;">
          ${header}
          <tr>
            <td style="padding:${header ? '28px' : '36px'} 32px;font-size:15px;line-height:1.65;color:#1a1a2e;">
              ${inner}
            </td>
          </tr>
          ${theme.band ? `<tr><td style="height:6px;background:${theme.band};font-size:0;line-height:0;">&nbsp;</td></tr>` : ''}
        </table>
        ${footer}
      </td>
    </tr>
  </table>
</body>
</html>`
}

// Headers that make Gmail / Yahoo show their native "Unsubscribe" button.
export function listUnsubscribeHeaders(unsubUrl) {
  return [
    { Name: 'List-Unsubscribe', Value: `<${unsubUrl}>` },
    { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
  ]
}
