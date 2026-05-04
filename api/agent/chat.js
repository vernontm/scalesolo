// AI CEO chat — Edge Runtime, SSE streaming.
// Body: { conversation_id?, profile_id, message, attachments? }
// Streams text deltas as `data: {"type":"text","text":"..."}\n\n`,
// then a final `data: {"type":"done","message_id":...,"usage":{...}}\n\n`.

import { embedOne } from '../_lib/openai.js'
import { streamMessage } from '../_lib/anthropic.js'
import { retrieveKnowledge } from '../_lib/embeddings.js'

export const config = { runtime: 'edge' }

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY
const ANON_KEY     = process.env.SUPABASE_ANON_KEY

// ── Supabase REST helper ────────────────────────────────────────────────────
async function supa(path, options = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await resp.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!resp.ok) {
    const err = new Error(`supa ${resp.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`)
    err.status = resp.status
    throw err
  }
  return data
}

async function getUser(authHeader) {
  if (!authHeader) return null
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY },
  })
  if (!r.ok) return null
  return r.json()
}

async function assertProfileAccess(userId, profileId) {
  const rows = await supa(`profile_access?user_id=eq.${userId}&profile_id=eq.${profileId}&select=role`)
  if (!rows?.length) throw Object.assign(new Error('Forbidden'), { status: 403 })
  return rows[0].role
}

// ── Build the system prompt: profile context + pinned facts + retrieved chunks ─
async function buildSystemPrompt(profileId, queryEmbedding) {
  const [profileRows, pinnedRows] = await Promise.all([
    supa(`profiles?id=eq.${profileId}&select=business_name,industry,brand_bible,target_audience,preferred_tone,agent_aggressiveness`),
    supa(`agent_pinned_facts?profile_id=eq.${profileId}&order=created_at.asc&select=fact`),
  ])
  const profile = profileRows?.[0]
  if (!profile) throw Object.assign(new Error('Profile not found'), { status: 404 })

  const chunks = queryEmbedding ? await retrieveKnowledge(profileId, queryEmbedding, { matchCount: 5 }) : []

  const lines = [
    `You are the AI CEO for ${profile.business_name || 'this brand'}, a brand that ScaleSolo is helping scale 10x faster.`,
    `You speak as a strategic operator: direct, candid, action-oriented. You never use em dashes — write with commas, periods, or restructured sentences instead.`,
  ]

  if (profile.industry)        lines.push(`Industry: ${profile.industry}.`)
  if (profile.target_audience) lines.push(`Target audience: ${profile.target_audience}.`)
  if (profile.preferred_tone)  lines.push(`Preferred tone: ${profile.preferred_tone}.`)

  // Behavior dial — affects proactivity / how strongly the agent suggests actions.
  const aggressiveness = profile.agent_aggressiveness || 'balanced'
  if (aggressiveness === 'quiet') {
    lines.push(`The user has set your behavior to QUIET. Answer what is asked, do not volunteer extra suggestions, do not nudge follow-up actions.`)
  } else if (aggressiveness === 'aggressive') {
    lines.push(`The user has set your behavior to AGGRESSIVE. After answering, proactively surface 1-3 concrete next actions with a single line each.`)
  } else {
    lines.push(`The user has set your behavior to BALANCED. After answering, suggest one natural next step if helpful — never more than one.`)
  }

  if (pinnedRows?.length) {
    lines.push('', '## Pinned facts (always-true rules from the founder)')
    for (const p of pinnedRows) lines.push(`- ${p.fact}`)
  }

  if (profile.brand_bible) {
    lines.push('', '## Brand bible summary (excerpt)')
    // Cap at ~1200 chars in the system prompt; full bible is in the retrieval index.
    lines.push(profile.brand_bible.slice(0, 1200) + (profile.brand_bible.length > 1200 ? '\n[...]' : ''))
  }

  if (chunks.length) {
    lines.push('', '## Retrieved relevant context')
    for (const c of chunks) {
      lines.push(`- (${c.source}) ${c.chunk_text.slice(0, 600)}`)
    }
  }

  return lines.join('\n')
}

// ── Send an SSE event helper ────────────────────────────────────────────────
function encodeSSE(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`
}

// ── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(req),
    })
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
    })
  }

  let user
  try {
    user = await getUser(req.headers.get('authorization'))
  } catch {
    return jsonError(401, 'Unauthorized', req)
  }
  if (!user?.id) return jsonError(401, 'Unauthorized', req)

  let body
  try { body = await req.json() } catch {
    return jsonError(400, 'Invalid JSON', req)
  }
  const profileId = body.profile_id
  const userMessage = body.message
  let conversationId = body.conversation_id
  if (!profileId)  return jsonError(400, 'profile_id required', req)
  if (!userMessage) return jsonError(400, 'message required', req)

  try {
    await assertProfileAccess(user.id, profileId)
  } catch (e) {
    return jsonError(e.status || 403, e.message || 'Forbidden', req)
  }

  // Find billing customer for credit metering
  const custRows = await supa(`billing_customers?user_id=eq.${user.id}&select=id`)
  const customerId = custRows?.[0]?.id || null

  // Pre-flight: minimum-balance check (1000 tokens — covers the smallest reply)
  if (customerId) {
    const pools = await supa(`credit_pools?customer_id=eq.${customerId}&pool_type=eq.ai_tokens&select=balance`)
    const balance = Number(pools?.[0]?.balance ?? 0)
    if (balance < 1000) {
      return new Response(JSON.stringify({ error: 'Insufficient AI tokens. Top up to continue.', code: 'insufficient_credits' }), {
        status: 402,
        headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
      })
    }
  }

  // Embed user message for retrieval
  let queryEmbedding = null
  try {
    const { embedding } = await embedOne(userMessage)
    queryEmbedding = embedding
  } catch (e) {
    // Retrieval is optional — proceed without if embedding fails.
    console.warn('embed failed:', e.message)
  }

  // Build system prompt + history
  const systemPrompt = await buildSystemPrompt(profileId, queryEmbedding)

  // Create conversation if needed
  if (!conversationId) {
    const newConv = await supa('agent_conversations', {
      method: 'POST',
      body: { profile_id: profileId, user_id: user.id, title: userMessage.slice(0, 80) },
    })
    conversationId = (Array.isArray(newConv) ? newConv[0] : newConv).id
  }

  // Pull last 20 messages to seed context
  const history = await supa(
    `agent_messages?conversation_id=eq.${conversationId}&order=created_at.asc&limit=20&select=role,content`
  )
  const claudeMessages = (history || []).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }))
  // Append the new user message
  claudeMessages.push({ role: 'user', content: [{ type: 'text', text: userMessage }] })

  // Persist the user message before streaming
  await supa('agent_messages', {
    method: 'POST',
    body: {
      conversation_id: conversationId,
      profile_id: profileId,
      role: 'user',
      content: [{ type: 'text', text: userMessage }],
    },
    prefer: 'return=minimal',
  })

  // Stream response
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      let assistantText = ''
      let usage = { input_tokens: 0, output_tokens: 0 }

      // Send initial event so the client gets conversation_id immediately
      controller.enqueue(enc.encode(encodeSSE({ type: 'start', conversation_id: conversationId })))

      try {
        for await (const evt of streamMessage({
          system: systemPrompt,
          messages: claudeMessages,
          max_tokens: 2048,
        })) {
          if (evt.type === 'text') {
            assistantText += evt.text
            controller.enqueue(enc.encode(encodeSSE({ type: 'text', text: evt.text })))
          } else if (evt.type === 'usage') {
            usage = evt.usage || usage
          } else if (evt.type === 'error') {
            controller.enqueue(enc.encode(encodeSSE({ type: 'error', error: evt.error })))
            controller.close()
            return
          }
        }

        // Persist assistant message
        const inserted = await supa('agent_messages', {
          method: 'POST',
          body: {
            conversation_id: conversationId,
            profile_id: profileId,
            role: 'assistant',
            content: [{ type: 'text', text: assistantText }],
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
          },
        })
        const messageId = (Array.isArray(inserted) ? inserted[0] : inserted).id

        // Meter credits — use total tokens (input+output). 1 token = 1 credit.
        const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0)
        if (customerId && totalTokens > 0) {
          await supa('rpc/consume_credits', {
            method: 'POST',
            body: {
              p_customer_id: customerId,
              p_pool_type: 'ai_tokens',
              p_amount: totalTokens,
              p_action: 'consume:agent-chat',
              p_ref_table: 'agent_messages',
              p_ref_id: messageId,
              p_profile_id: profileId,
              p_metadata: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
            },
          }).catch((e) => console.warn('consume failed:', e.message))
        }

        controller.enqueue(enc.encode(encodeSSE({
          type: 'done',
          message_id: messageId,
          conversation_id: conversationId,
          usage,
        })))
      } catch (err) {
        controller.enqueue(enc.encode(encodeSSE({ type: 'error', error: err.message })))
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      ...corsHeaders(req),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

// ── helpers ────────────────────────────────────────────────────────────────
function corsHeaders(req) {
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
  const origin = req.headers.get('origin')
  const h = {
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Client-Info',
  }
  if (origin && (!allowed.length || allowed.includes(origin))) {
    h['Access-Control-Allow-Origin'] = origin
    h['Vary'] = 'Origin'
  }
  return h
}

function jsonError(status, message, req) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  })
}
