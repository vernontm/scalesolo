#!/usr/bin/env node
// ScaleSolo MCP server (stdio).
//
// Thin stdio transport wrapper. All tool definitions + implementations live
// in ./lib.js (shared with the hosted HTTP endpoint api/mcp.js). Auth model,
// env vars and safety notes are documented there and unchanged.
//
// Env: SCALESOLO_API_BASE, SCALESOLO_INTERNAL_SECRET, SCALESOLO_USER_ID

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { TOOLS, impls, requireEnv } from './lib.js'

// Fail fast locally so a missing secret is obvious at launch.
try {
  requireEnv()
} catch (e) {
  console.error(`scalesolo-mcp: ${e.message}`)
  process.exit(1)
}

const server = new Server({ name: 'scalesolo', version: '0.1.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const fn = impls[req.params.name]
  if (!fn) throw new Error(`Unknown tool: ${req.params.name}`)
  try {
    return await fn(req.params.arguments || {})
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Error: ${e?.message || String(e)}` }] }
  }
})

await server.connect(new StdioServerTransport())
console.error('scalesolo-mcp ready (stdio)')
