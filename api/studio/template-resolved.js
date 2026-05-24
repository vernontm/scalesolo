// GET /api/studio/template-resolved?id=<template_id>&accent=<#hex>
//
// Returns the FULL resolved template object for a single id — every
// {accent} placeholder interpolated against the brand color. Used by the
// Fly worker (which doesn't share an import path with /api code) to read
// overlay_overrides + motion + composition_pool + zone_system at bake
// time without re-implementing or bundling templates.js.
//
// Auth: gated by the shared worker secret (NOT user auth). The worker
// passes x-worker-secret on every request to its dispatch endpoint —
// we reuse the same header here so this endpoint is callable only from
// the worker, not from end-user browsers.

import { TEMPLATE_BY_ID, resolveTemplate, SLEEK } from './_lib/templates.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  // Same shared secret the worker uses on its inbound endpoint.
  const expected = process.env.WORKER_SHARED_SECRET
  const got = req.headers['x-worker-secret']
  if (!expected) return res.status(500).json({ error: 'WORKER_SHARED_SECRET not configured' })
  if (got !== expected) return res.status(401).json({ error: 'unauthorized' })

  try {
    const id = String(req.query.id || '').trim()
    const accent = String(req.query.accent || '').trim() || null
    if (!id) return res.status(400).json({ error: 'id required' })
    if (!TEMPLATE_BY_ID[id]) {
      // Fall back to Sleek instead of 404'ing — same behavior as
      // getTemplate() in _lib/templates.js. Tells the worker (via
      // fallback_used) so render_progress can surface it.
      const tpl = resolveTemplate(SLEEK.id, accent)
      return res.status(200).json({ template: tpl, fallback_used: true, requested_id: id })
    }
    const tpl = resolveTemplate(id, accent)
    return res.status(200).json({ template: tpl, fallback_used: false })
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) })
  }
}
