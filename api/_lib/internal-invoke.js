// In-process invocation of another Vercel serverless handler in this
// codebase. Use this anywhere you would otherwise self-fetch your own
// /api/* endpoint over HTTP.
//
// Why this exists: Vercel preview deployments have Deployment Protection
// enabled by default. A serverless function doing
//
//   fetch(`https://<preview-host>/api/x`, { headers: { Authorization: ... } })
//
// against its own public URL hits the SSO wall — the function has no
// SSO cookie, so Vercel returns 401 before our requireUser ever runs.
// The browser doesn't see this because the browser DOES have the SSO
// cookie; the failure only manifests in server-to-server calls.
//
// In-process invocation skips the HTTP layer entirely, so the SSO wall
// is never hit. We build a synthetic req that forwards the original
// caller's headers (so requireUser, billing, and CORS still see the
// real user) and a synthetic res that captures the status + body.
//
// Usage:
//   import { invokeHandler } from '../_lib/internal-invoke.js'
//   import targetHandler from './target-endpoint.js'
//
//   const { statusCode, body } = await invokeHandler(targetHandler, req, {
//     method: 'POST',
//     body: { ... },
//     query: { action: 'foo' },
//   })
//   if (statusCode >= 300) throw new Error(body?.error || `failed ${statusCode}`)

export async function invokeHandler(handler, originalReq, overrides = {}) {
  const captured = { statusCode: 200, body: null, headers: {} }

  const syntheticReq = {
    method: overrides.method || 'POST',
    query: overrides.query || {},
    body: overrides.body !== undefined ? overrides.body : (originalReq?.body ?? {}),
    // Forward the caller's headers so requireUser sees the same bearer,
    // setCors sees the same origin, etc. Allow the caller to override
    // individual headers (e.g. content-type) via overrides.headers.
    headers: {
      ...(originalReq?.headers || {}),
      'content-type': 'application/json',
      ...(overrides.headers || {}),
    },
    socket: originalReq?.socket,
    connection: originalReq?.connection,
  }

  const syntheticRes = {
    setHeader(name, value) {
      captured.headers[String(name).toLowerCase()] = value
      return this
    },
    getHeader(name) { return captured.headers[String(name).toLowerCase()] },
    removeHeader(name) {
      delete captured.headers[String(name).toLowerCase()]
      return this
    },
    status(code) { captured.statusCode = code; return this },
    json(payload) { captured.body = payload; return this },
    send(payload) { captured.body = payload; return this },
    end(payload) { if (payload !== undefined) captured.body = payload; return this },
  }

  await handler(syntheticReq, syntheticRes)
  return captured
}
