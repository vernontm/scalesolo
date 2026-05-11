// GET /api/debug/worker-config
//
// Tiny diagnostic — returns whether the env vars polish.js needs to
// route through the Fly worker are visible to this Vercel function.
// Use to debug "why isn't my polish going through the worker?" when
// fly logs show zero incoming requests.
//
// No auth — doesn't return any secret values, just booleans + the
// public Fly hostname + the secret's string length. Safe to hit from
// a browser tab during debugging.

import { setCors } from '../_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const workerUrl = process.env.WORKER_URL || ''
  const workerSecret = process.env.WORKER_SHARED_SECRET || ''
  const shotstackKey = process.env.SHOTSTACK_API_KEY || ''

  let workerHealth = null
  if (workerUrl) {
    try {
      const r = await fetch(`${workerUrl.replace(/\/$/, '')}/healthz`, { method: 'GET' })
      const body = await r.text()
      workerHealth = { status: r.status, body: body.slice(0, 200), reachable: r.ok }
    } catch (e) {
      workerHealth = { reachable: false, error: e?.message || String(e) }
    }
  }

  return res.status(200).json({
    env: {
      WORKER_URL_set: !!workerUrl,
      WORKER_URL_host: workerUrl ? new URL(workerUrl).host : null,
      WORKER_SHARED_SECRET_set: !!workerSecret,
      WORKER_SHARED_SECRET_length: workerSecret.length,
      SHOTSTACK_API_KEY_set: !!shotstackKey,
    },
    worker_health: workerHealth,
    vercel_region: process.env.VERCEL_REGION || null,
    vercel_env: process.env.VERCEL_ENV || null,
    deployed_at: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null,
  })
}
