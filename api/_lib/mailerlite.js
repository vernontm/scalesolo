// MailerLite integration for the marketing funnel.
//
// Provides a single function — mailerliteUpsert — that creates or updates
// a subscriber in MailerLite and optionally adds them to one or more
// groups. Used by the funnel endpoints to route contacts into the right
// automation sequence based on what they did (opted in, declined, bought
// the tripwire, bought the DFY launch, etc.).
//
// Required env: MAILERLITE_API_KEY
//
// Optional env (group ids — find these in MailerLite under Subscribers ▸
// Groups, then in the URL bar):
//   MAILERLITE_GROUP_LEAD              → funnel:lead-opt-in
//   MAILERLITE_GROUP_BUYER_TRIPWIRE    → buyer of the $17 playbook
//   MAILERLITE_GROUP_BUYER_PACK        → buyer of the $9 Content Pack bump
//   MAILERLITE_GROUP_BUYER_DFY         → buyer of the $397 Done-For-You
//   MAILERLITE_GROUP_DECLINED_TRIPWIRE → declined the tripwire upsell
//   MAILERLITE_GROUP_DECLINED_DFY      → declined the DFY upsell
//
// All errors are swallowed and logged — the funnel keeps working even if
// MailerLite is down, the API key is missing, or a group id is wrong.

const ML_BASE = 'https://connect.mailerlite.com/api'

function isConfigured() {
  return Boolean(process.env.MAILERLITE_API_KEY)
}

function groupIdFor(slug) {
  switch (slug) {
    case 'lead': return process.env.MAILERLITE_GROUP_LEAD
    case 'buyer-tripwire': return process.env.MAILERLITE_GROUP_BUYER_TRIPWIRE
    case 'buyer-pack': return process.env.MAILERLITE_GROUP_BUYER_PACK
    case 'buyer-dfy': return process.env.MAILERLITE_GROUP_BUYER_DFY
    case 'declined-tripwire': return process.env.MAILERLITE_GROUP_DECLINED_TRIPWIRE
    case 'declined-dfy': return process.env.MAILERLITE_GROUP_DECLINED_DFY
    default: return null
  }
}

// Map our internal group slugs to env-configured MailerLite group ids and
// drop any that are not configured. Lets us pass ['lead', 'buyer-tripwire']
// without worrying about which envs are set yet.
function resolveGroupIds(slugs) {
  if (!Array.isArray(slugs)) slugs = [slugs].filter(Boolean)
  const ids = []
  for (const slug of slugs) {
    const id = groupIdFor(slug)
    if (id) ids.push(id)
  }
  return ids
}

// MailerLite's POST /subscribers endpoint creates or updates the subscriber
// based on email and accepts a `groups` array of group ids to assign on
// upsert. Splits first name out of `name` if provided. Best-effort: returns
// { ok, status, data } and never throws.
//
//   mailerliteUpsert({ email, name?, groups?: ['lead'], fields?: {...} })
//
export async function mailerliteUpsert({ email, name, groups, fields } = {}) {
  if (!isConfigured()) {
    return { ok: false, skipped: true, reason: 'MAILERLITE_API_KEY missing' }
  }
  if (!email || typeof email !== 'string') {
    return { ok: false, error: 'email required' }
  }

  const payload = { email: email.toLowerCase().trim() }
  if (name) {
    const trimmed = name.trim()
    const space = trimmed.indexOf(' ')
    payload.fields = {
      name: space > 0 ? trimmed.slice(0, space) : trimmed,
      last_name: space > 0 ? trimmed.slice(space + 1) : '',
      ...(fields || {}),
    }
  } else if (fields) {
    payload.fields = fields
  }

  const groupIds = resolveGroupIds(groups)
  if (groupIds.length) payload.groups = groupIds

  try {
    const r = await fetch(`${ML_BASE}/subscribers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.MAILERLITE_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    })
    const text = await r.text()
    let data = null
    try { data = JSON.parse(text) } catch {}
    if (!r.ok) {
      console.warn('[mailerlite] upsert failed', r.status, text.slice(0, 240))
      return { ok: false, status: r.status, error: data?.message || text.slice(0, 240) }
    }
    return { ok: true, status: r.status, data, subscriberId: data?.data?.id }
  } catch (err) {
    console.warn('[mailerlite] upsert error', err?.message || err)
    return { ok: false, error: err?.message || String(err) }
  }
}

// Add an existing subscriber to a group (used when we already created them
// at lead time and need to add a buyer tag later). Best-effort.
export async function mailerliteAssignGroup({ email, group }) {
  if (!isConfigured()) return { ok: false, skipped: true }
  const groupId = groupIdFor(group)
  if (!groupId) return { ok: false, skipped: true, reason: `no group id for ${group}` }

  // The /subscribers endpoint is an upsert that accepts groups — easier
  // and idempotent. (The dedicated /subscribers/{id}/groups/{groupId} path
  // also exists but needs a lookup first.)
  return mailerliteUpsert({ email, groups: [group] })
}

// Convenience helpers used by the funnel — semantic names beat passing
// magic slugs around at call sites.
export async function mailerliteTagLead({ email, name }) {
  return mailerliteUpsert({ email, name, groups: ['lead'] })
}
export async function mailerliteTagDeclined({ email, name, offer }) {
  const group = offer === 'dfy' ? 'declined-dfy' : 'declined-tripwire'
  return mailerliteUpsert({ email, name, groups: [group] })
}
export async function mailerliteTagBuyer({ email, name, product, bump }) {
  // product: 'tripwire' | 'dfy' | 'dfy_oto'
  const groups = ['lead'] // every buyer is also a confirmed lead
  if (product === 'tripwire') {
    groups.push('buyer-tripwire')
    if (bump) groups.push('buyer-pack')
  } else if (product === 'dfy' || product === 'dfy_oto') {
    groups.push('buyer-dfy')
  }
  return mailerliteUpsert({ email, name, groups })
}
