// Hosted ScaleSolo MCP endpoint.
//
// Connecting:
//   Claude Desktop / claude.ai   Add a custom connector with the URL
//                                https://www.scalesolo.ai/api/mcp?token=<token>
//   Claude Code                  claude mcp add --transport http scalesolo \
//                                  "<url>" --header "x-mcp-token: <token>"
//
// Auth: one row per person in scalesolo_mcp_tokens, so a token can be revoked
// on its own (active=false, no redeploy) and every call is attributable. The
// token is accepted from ?token=, the x-mcp-token header, or an Authorization
// bearer. Connector forms have no field for a custom header, which is why the
// query parameter exists, and why THE URL ITSELF IS THE CREDENTIAL: treat it
// like a password, it lands in logs and browser history.
//
// SCALESOLO_MCP_HTTP_TOKEN still works as a full-access owner token so the
// existing setup keeps running; it behaves like role=publish on every brand.
//
// Transport is the SDK's stateless web-standard StreamableHTTP, which answers
// GET/SSE properly. A hand-rolled JSON-RPC handler 405s on GET, which leaves
// Claude Desktop stuck on "verifying".
//
// Env (Vercel): SCALESOLO_USER_ID, WORKFLOW_INTERNAL_SECRET (impersonation),
// optional SCALESOLO_MCP_HTTP_TOKEN (owner token).

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { supaFetch } from './_lib/supabase.js'
import { TOOLS, impls, resolveBrand, api } from '../mcp/lib.js'

const SERVER_INFO = { name: 'scalesolo', version: '0.2.0' }

// Local-disk tools cannot work for a remote caller (no shared filesystem).
const REMOTE_EXCLUDE = new Set(['upload_media', 'upload_carousel', 'add_to_backlog', 'batch_add_to_backlog'])
const REMOTE_TOOLS = TOOLS.filter((t) => !REMOTE_EXCLUDE.has(t.name))

// What each role may call. publish = every remote tool.
const READONLY = ['list_brands', 'get_brand', 'get_post', 'next_slots']
const ROLE_TOOLS = {
  readonly: new Set(READONLY),
  draft: new Set([...READONLY, 'autocaption', 'update_post', 'set_platforms', 'generate_image', 'generate_video', 'add_from_url']),
  publish: new Set(REMOTE_TOOLS.map((t) => t.name)),
}

// Resolve the caller from ?token= / x-mcp-token / Authorization: Bearer.
// Returns { name, role, profileIds } or null. profileIds empty = all brands.
async function resolveCaller(req) {
  const q = Array.isArray(req.query?.token) ? req.query.token[0] : req.query?.token
  const bearer = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '')
  const raw = String(req.headers?.['x-mcp-token'] || q || bearer || '').trim()
  if (!raw) return null

  // Owner token from env: full access, every brand.
  const owner = process.env.SCALESOLO_MCP_HTTP_TOKEN
  if (owner && raw === owner) return { id: null, name: 'owner', role: 'publish', profileIds: [] }

  const rows = await supaFetch(
    `scalesolo_mcp_tokens?token=eq.${encodeURIComponent(raw)}&active=is.true&select=id,name,role,profile_ids&limit=1`
  ).catch(() => null)
  const row = rows?.[0]
  if (!row) return null
  // Fire-and-forget: a slow audit write must never delay a tool call.
  supaFetch(`scalesolo_mcp_tokens?id=eq.${row.id}`, {
    method: 'PATCH', body: { last_used: new Date().toISOString() }, prefer: 'return=minimal',
  }).catch(() => {})
  return {
    id: row.id,
    name: row.name || 'token',
    role: ROLE_TOOLS[row.role] ? row.role : 'readonly',
    profileIds: Array.isArray(row.profile_ids) ? row.profile_ids.filter(Boolean) : [],
  }
}

function audit(caller, tool, args, result, isError, ip) {
  supaFetch('scalesolo_mcp_audit', {
    method: 'POST',
    body: {
      token_id: caller.id, token_name: caller.name, token_role: caller.role,
      tool, args: args || {}, result: String(result ?? '').slice(0, 1000), is_error: !!isError, ip: ip || null,
    },
    prefer: 'return=minimal',
  }).catch(() => {})
}

// Which brand a call targets: tools take either `brand` or `content_id`.
// null means "not brand specific" (e.g. list_brands), which is always allowed.
async function targetProfileId(args) {
  if (args?.brand) return (await resolveBrand(args.brand))?.id || null
  if (args?.content_id) {
    const row = (await api('/api/content', { query: { id: args.content_id } }))?.item
    return row?.profile_id || null
  }
  return null
}

export default async function handler(req, res) {
  const origin = req.headers?.origin
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-mcp-token, mcp-session-id, mcp-protocol-version')
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id')
  if (req.method === 'OPTIONS') return res.status(204).end()

  const caller = await resolveCaller(req)
  if (!caller) {
    return res.status(401).json({
      jsonrpc: '2.0', id: null,
      error: { code: -32001, message: 'Invalid or missing token. Pass ?token= in the URL or the x-mcp-token header.' },
    })
  }
  const allowed = ROLE_TOOLS[caller.role]
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null

  // Rebuild a Web Standard Request for the transport. Vercel may already have
  // parsed the body, so prefer re-serializing it over reading a spent stream.
  let bodyBuf = Buffer.alloc(0)
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.body !== undefined && req.body !== null && req.body !== '') {
      bodyBuf = Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
    } else {
      const chunks = []
      await new Promise((resolve) => { req.on('data', (c) => chunks.push(c)); req.on('end', resolve); req.on('error', resolve) })
      bodyBuf = Buffer.concat(chunks)
    }
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'www.scalesolo.ai'
  const proto = req.headers['x-forwarded-proto'] || 'https'
  const webRequest = new Request(`${proto}://${host}${req.url}`, {
    method: req.method,
    headers: new Headers(Object.entries(req.headers).flatMap(([k, v]) =>
      Array.isArray(v) ? v.map((val) => [k, String(val)]) : [[k, String(v)]])),
    body: bodyBuf.length ? bodyBuf : undefined,
  })

  // Fresh stateless server + transport per request (right shape for serverless).
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: REMOTE_TOOLS.filter((t) => allowed.has(t.name)),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params
    const deny = (msg) => {
      audit(caller, name, args, msg, true, ip)
      return { content: [{ type: 'text', text: msg }], isError: true }
    }
    if (!allowed.has(name)) {
      return deny(`Access denied: ${caller.name} (${caller.role}) cannot use ${name}.`)
    }
    try {
      // Brand scope. An empty allowlist means every brand.
      if (caller.profileIds.length) {
        const target = await targetProfileId(args)
        if (target && !caller.profileIds.includes(target)) {
          return deny(`Access denied: ${caller.name} is not allowed to act on that brand.`)
        }
      }
      let out = await impls[name](args)
      // A brand-scoped caller should only ever see their own brands listed.
      if (name === 'list_brands' && caller.profileIds.length) {
        const txt = out?.content?.[0]?.text
        if (txt) {
          const kept = JSON.parse(txt).filter((b) => caller.profileIds.includes(b.id))
          out = { content: [{ type: 'text', text: JSON.stringify(kept, null, 2) }] }
        }
      }
      audit(caller, name, args, out?.content?.[0]?.text, false, ip)
      return out
    } catch (e) {
      const msg = `Error: ${e?.message || String(e)}`
      audit(caller, name, args, msg, true, ip)
      return { content: [{ type: 'text', text: msg }], isError: true }
    }
  })

  await server.connect(transport)
  const webResponse = await transport.handleRequest(webRequest)

  res.status(webResponse.status)
  webResponse.headers.forEach((value, key) => res.setHeader(key, value))
  if (!webResponse.body) return res.end()

  // Stream the body through instead of buffering it. A GET opens a long-lived
  // SSE stream that never completes on its own, so awaiting arrayBuffer() here
  // would block forever and the client would receive nothing (which is what
  // leaves Claude Desktop hanging). Streaming also flushes POST replies
  // immediately. Cancel the reader if the client hangs up first.
  const reader = webResponse.body.getReader()
  let cancelled = false
  const stop = () => { if (!cancelled) { cancelled = true; reader.cancel().catch(() => {}) } }
  req.on('close', stop)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || cancelled) break
      res.write(Buffer.from(value))
      res.flush?.()
    }
  } catch { /* client went away mid-stream */ }
  stop()
  res.end()
}
