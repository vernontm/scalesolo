#!/usr/bin/env node
// Smoke test: api/studio/_lib/overlay-renderer.js and
// public/studio-compositions/_overlay-renderer.js MUST produce byte-
// identical HTML for the same input. They're hand-kept in sync because
// the iframe can't import from /api and Node serverless can't import
// from /public, so we ship two copies.
//
// Run from the repo root:
//   node scripts/smoke-overlay-renderer.mjs
//
// Exits non-zero if any fixture diverges. Wire into CI before shipping
// overlay changes.

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import * as serverRenderer from '../api/studio/_lib/overlay-renderer.js'
import * as browserRenderer from '../public/studio-compositions/_overlay-renderer.js'
import { resolveTemplate } from '../api/studio/_lib/templates.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const sleek = resolveTemplate('sleek', '#e3151e')
const overrides = sleek.overlay_overrides

// Fixtures: one per overlay, plus a full-layer composition. Pick
// realistic content so any null-coalescing differences surface.
const fixtures = [
  {
    name: 'stat-callout-v1 / standard',
    args: {
      overlay_id: 'stat-callout-v1',
      content: { label: 'Ship Speed', number: '10', unit: 'x', sub: 'Faster' },
      tokens: overrides['stat-callout-v1'],
      accent: '#e3151e',
    },
  },
  {
    name: 'word-emphasis-v1',
    args: {
      overlay_id: 'word-emphasis-v1',
      content: { word: '10X' },
      tokens: overrides['word-emphasis-v1'],
      accent: '#e3151e',
    },
  },
  {
    name: 'caption-overlay-v1 with highlight',
    args: {
      overlay_id: 'caption-overlay-v1',
      content: { text: 'a stack that thinks', highlight: 'thinks' },
      tokens: overrides['caption-overlay-v1'],
      accent: '#e3151e',
    },
  },
  {
    name: 'tool-logo-v1',
    args: {
      overlay_id: 'tool-logo-v1',
      content: { logo: 'C', name: 'Claude', desc: 'AI Co-Pilot' },
      tokens: overrides['tool-logo-v1'],
      accent: '#e3151e',
    },
  },
  {
    name: 'watermark-v1 default prefix',
    args: {
      overlay_id: 'watermark-v1',
      content: { handle: 'raytheaiguy' },
      tokens: overrides['watermark-v1'],
      accent: '#e3151e',
    },
  },
  {
    name: 'watermark-v1 custom prefix',
    args: {
      overlay_id: 'watermark-v1',
      content: { handle: 'raytheaiguy' },
      tokens: { ...overrides['watermark-v1'], prefix: { char: '#', color: '#e3151e', margin_right_px: 6 } },
      accent: '#e3151e',
    },
  },
  {
    name: 'action-prompt-v1',
    args: {
      overlay_id: 'action-prompt-v1',
      content: { text: 'Link in Bio', arrow: '↓' },
      tokens: overrides['action-prompt-v1'],
      accent: '#e3151e',
    },
  },
  {
    name: 'source-citation-v1',
    args: {
      overlay_id: 'source-citation-v1',
      content: { label: 'Source', citation: 'Vernon Tech Report, 2026' },
      tokens: overrides['source-citation-v1'],
      accent: '#e3151e',
    },
  },
  {
    name: 'chapter-marker-v1 with strip',
    args: {
      overlay_id: 'chapter-marker-v1',
      content: { meta: 'Part 02 / 05', title: 'The Stack' },
      tokens: overrides['chapter-marker-v1'],
      accent: '#e3151e',
    },
  },
  {
    name: 'chapter-marker-v1 no strip',
    args: {
      overlay_id: 'chapter-marker-v1',
      content: { meta: 'Part 02 / 05', title: 'The Stack' },
      tokens: { ...overrides['chapter-marker-v1'], side_strip: { enabled: false } },
      accent: '#e3151e',
    },
  },
  {
    name: 'unknown overlay',
    args: { overlay_id: 'bogus-v9', content: {}, tokens: {} },
  },
]

const layerFixture = {
  name: 'full layer / landscape with 3 placements',
  args: {
    placements: [
      { overlay_id: 'stat-callout-v1', resolved_zone: 'r-mid', content: { label: 'Revenue', number: '$47K', sub: 'Solo Month' } },
      { overlay_id: 'chapter-marker-v1', resolved_zone: 'l-top', content: { meta: 'Part 02 / 05', title: 'The Stack' } },
      { overlay_id: 'watermark-v1', resolved_zone: 'corner-tr', content: { handle: 'raytheaiguy' } },
    ],
    orientation: 'landscape',
    overlay_overrides: overrides,
    accent: '#e3151e',
  },
}

let failed = 0

for (const fx of fixtures) {
  const a = serverRenderer.renderOverlay(fx.args)
  const b = browserRenderer.renderOverlay(fx.args)
  if (a === b) {
    console.log(`✓ ${fx.name}`)
  } else {
    failed++
    console.log(`✗ ${fx.name}`)
    console.log('  server:', JSON.stringify(a.slice(0, 200)))
    console.log('  browser:', JSON.stringify(b.slice(0, 200)))
    // Find first divergence
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    console.log(`  first diff at index ${i}: server="${a.slice(i, i + 60)}" browser="${b.slice(i, i + 60)}"`)
  }
}

const la = serverRenderer.renderOverlayLayer(layerFixture.args)
const lb = browserRenderer.renderOverlayLayer(layerFixture.args)
if (la === lb) {
  console.log(`✓ ${layerFixture.name}`)
} else {
  failed++
  console.log(`✗ ${layerFixture.name} — ${la.length} vs ${lb.length} chars`)
  let i = 0
  while (i < la.length && i < lb.length && la[i] === lb[i]) i++
  console.log(`  first diff at ${i}: server="${la.slice(i, i + 80)}" browser="${lb.slice(i, i + 80)}"`)
}

if (failed > 0) {
  console.error(`\n${failed} fixture(s) diverged. Server + browser renderers must produce identical output — edit BOTH files.`)
  process.exit(1)
} else {
  console.log(`\nAll ${fixtures.length + 1} fixtures match.`)
}
