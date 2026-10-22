// One-click unsubscribe. Linked from every campaign footer and from the
// List-Unsubscribe header (Gmail / Yahoo call it with a POST).
//
//   GET  ?c=<contact id>&t=<token>&k=<campaign id>   unsubscribe + confirmation page
//   POST same params (List-Unsubscribe=One-Click body)
//
// The token is an HMAC of the contact id, so a link only works for the
// contact it was generated for. Public endpoint, no auth.

import { supaFetch, isUuid } from '../_lib/supabase.js'
import { verifyUnsubscribeToken } from '../_lib/email-render.js'

const enc = encodeURIComponent

function page({ title, body }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1c1e}
.card{max-width:460px;margin:80px auto;background:#fff;border-radius:14px;padding:36px;box-shadow:0 1px 2px rgba(0,0,0,.04);text-align:center}
h1{font-size:20px;margin:0 0 10px}p{margin:0;color:#55555c;font-size:15px;line-height:1.5}</style></head>
<body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).end()
  const q = { ...(req.query || {}), ...(typeof req.body === 'object' && req.body ? req.body : {}) }
  const contactId = String(q.c || '')
  const token = String(q.t || '')
  const campaignId = isUuid(String(q.k || '')) ? String(q.k) : null

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')

  if (!isUuid(contactId) || !verifyUnsubscribeToken(contactId, token)) {
    return res.status(400).send(page({ title: 'This link is not valid', body: 'The unsubscribe link looks incomplete. Reply to the email you received and we will take care of it.' }))
  }

  try {
    const rows = await supaFetch(`email_contacts?id=eq.${enc(contactId)}&select=id,profile_id,email,status`)
    const contact = rows?.[0]
    if (!contact) return res.status(200).send(page({ title: 'You are unsubscribed', body: 'That address is no longer on this list.' }))

    const already = contact.status === 'unsubscribed'
    if (!already) {
      await supaFetch(`email_contacts?id=eq.${enc(contactId)}`, {
        method: 'PATCH', body: { status: 'unsubscribed', updated_at: new Date().toISOString() }, prefer: 'return=minimal',
      })
      await supaFetch('email_suppressions', {
        method: 'POST', prefer: 'return=minimal',
        body: { profile_id: contact.profile_id, email: String(contact.email).toLowerCase(), reason: 'unsubscribe', source: campaignId ? `campaign:${campaignId}` : 'link' },
      }).catch((e) => { if (e?.status !== 409) throw e })
      if (campaignId) {
        await supaFetch('rpc/bump_email_campaign_counter', { method: 'POST', body: { p_campaign: campaignId, p_col: 'unsubscribed_count', p_n: 1 }, prefer: 'return=minimal' }).catch(() => {})
      }
    }
    return res.status(200).send(page({ title: 'You are unsubscribed', body: `${contact.email} will not receive any more marketing email from this sender.` }))
  } catch (e) {
    console.error('[email/unsubscribe]', e)
    return res.status(500).send(page({ title: 'Something went wrong', body: 'We could not process that just now. Reply to the email you received and we will remove you by hand.' }))
  }
}
