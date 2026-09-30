// api/mcp.js: hosted MCP endpoint (Streamable HTTP, stateless).
//
// Exposes the same ScaleSolo tools as the local stdio server (mcp/lib.js) over
// HTTP so another Claude client can drive posting WITHOUT cloning the repo.
// Add it in a client as a remote/custom MCP server with an Authorization
// bearer header, e.g. Claude Code:
//   claude mcp add --transport http scalesolo https://www.scalesolo.ai/api/mcp \
//     --header "Authorization: Bearer <SCALESOLO_MCP_HTTP_TOKEN>"
//
// SECURITY: these tools publish to real client socials. Every request must
// carry the bearer token in SCALESOLO_MCP_HTTP_TOKEN or it is rejected 401.
// The endpoint acts as SCALESOLO_USER_ID (single tenant). Tools that read a
// local file (upload_media, upload_carousel, add_to_backlog,
// batch_add_to_backlog) are NOT exposed here because a remote caller shares no
// filesystem with the server.
//
// Env (set on Vercel): SCALESOLO_MCP_HTTP_TOKEN, SCALESOLO_USER_ID, and the
// impersonation secret (SCALESOLO_INTERNAL_SECRET or WORKFLOW_INTERNAL_SECRET).

import { createHash, timingSafeEqual } from 'node:crypto'
import { TOOLS, impls, requireEnv } from '../mcp/lib.js'

const SERVER_INFO = { name: 'scalesolo', version: '0.1.0' }
const DEFAULT_PROTOCOL = '2025-06-18'

// Local-disk tools can't work for a remote caller (no shared filesystem).
const REMOTE_EXCLUDE = new Set(['upload_media', 'upload_carousel', 'add_to_backlog', 'batch_add_to_backlog'])
const REMOTE_TOOLS = TOOLS.filter((t) => !REMOTE_EXCLUDE.has(t.name))

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

// Constant-time token compare (hash first so unequal lengths don't throw and
// don't leak length via timing).
function tokenOk(presented, expected) {
  if (!expected || !presented) return false
  const a = createHash('sha256').update(String(presented)).digest()
  const b = createHash('sha256').update(String(expected)).digest()
  return timingSafeEqual(a, b)
}

async function handleRpc(msg) {
  const { id, method, params } = msg || {}
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, { tools: REMOTE_TOOLS })
    case 'tools/call': {
      const name = params?.name
      if (REMOTE_EXCLUDE.has(name)) {
        return rpcResult(id, {
          isError: true,
          content: [{ type: 'text', text: `Tool "${name}" isn't available over HTTP (it reads a local file). Use the local stdio MCP for that.` }],
        })
      }
      const fn = impls[name]
      if (!fn) return rpcError(id, -32602, `Unknown tool: ${name}`)
      try {
        return rpcResult(id, await fn(params?.arguments || {}))
      } catch (e) {
        return rpcResult(id, { isError: true, content: [{ type: 'text', text: `Error: ${e?.message || String(e)}` }] })
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`)
  }
}

const isNotification = (m) => m && (m.id === undefined || m.id === null)

export default async function handler(req, res) {
  // CORS: bearer token is the security boundary (no cookies), so reflect the
  // origin for browser-based clients and allow the MCP headers.
  const origin = req.headers.origin
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version')
  if (req.method === 'OPTIONS') return res.status(204).end()

  // Auth
  const presented = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!tokenOk(presented, process.env.SCALESOLO_MCP_HTTP_TOKEN)) {
    return res.status(401).json(rpcError(null, -32001, 'Unauthorized'))
  }

  // Config present?
  try {
    requireEnv()
  } catch (e) {
    return res.status(500).json(rpcError(null, -32603, e.message))
  }

  // Streamable HTTP: this stateless endpoint offers no SSE stream, so a GET
  // (server-initiated stream) is 405 per spec. Only POST carries JSON-RPC.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS')
    return res.status(405).json(rpcError(null, -32600, 'Method not allowed'))
  }

  let body = req.body
  if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch { return res.status(400).json(rpcError(null, -32700, 'Parse error')) }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json(rpcError(null, -32600, 'Invalid Request'))
  }

  try {
    if (Array.isArray(body)) {
      const responses = []
      for (const m of body) {
        if (isNotification(m)) { await handleRpc(m); continue }
        responses.push(await handleRpc(m))
      }
      if (!responses.length) return res.status(202).end()
      return res.status(200).json(responses)
    }
    if (isNotification(body)) {
      await handleRpc(body) // e.g. notifications/initialized
      return res.status(202).end()
    }
    return res.status(200).json(await handleRpc(body))
  } catch (e) {
    return res.status(500).json(rpcError(body?.id ?? null, -32603, e?.message || 'Internal error'))
  }
}
