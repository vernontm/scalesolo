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
import { SHARED_DOMAIN, domainOf } from './ses.js'

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

  let verifiedVia = null
  if (fromDomain === SHARED_DOMAIN) {
    verifiedVia = 'shared'
  } else {
    const rows = await supaFetch(`email_domains?profile_id=eq.${encodeURIComponent(profileId)}&domain=eq.${encodeURIComponent(fromDomain)}&select=status&limit=1`)
    if (rows?.[0]?.status === 'verified') verifiedVia = 'domain'
    else return { ok: false, reason: `${fromDomain} is not verified yet. Add the DNS records in the Sender tab, or send from ${SHARED_DOMAIN}.`, profile, config }
  }
  return { ok: true, profile, config, verifiedVia }
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

// Wrap a body (plain text, an HTML fragment, or a full document) in the
// responsive shell and append the footer. The footer is always appended,
// even to full documents, because the unsubscribe link is not optional.
export function renderCampaignEmail({ subject, previewText, body, fromName, profile, config, vars }) {
  const raw = mergeTags(body || '', vars)
  const preheader = previewText
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f5f7fa;opacity:0;">${escapeHtml(mergeTags(previewText, vars))}</div>`
    : ''

  const footerLines = [
    escapeHtml(profile?.business_name || fromName || ''),
    config?.postal_address ? escapeHtml(config.postal_address) : '',
    profile?.website_url ? `<a href="${escapeHtml(profile.website_url)}" style="color:#8e8ea0;">${escapeHtml(profile.website_url.replace(/^https?:\/\//, ''))}</a>` : '',
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
          <tr>
            <td style="padding:36px 32px;font-size:15px;line-height:1.65;color:#1a1a2e;">
              ${inner}
            </td>
          </tr>
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
