// Cost-of-goods-sold (COGS) lookup. Given a credit_transactions row,
// returns our actual upstream cost in USD so the admin usage dashboard
// reflects margin, not just a flat per-pool rate.
//
// Each rule walks one (action, pool_type) combination and reads the
// metadata jsonb the consume site recorded. Most actions store the
// fields we need (model, duration_secs, count, quality); a few don't
// and fall back to a per-pool estimate so the dashboard never shows $0.
//
// Sources:
//   HeyGen — https://developers.heygen.com/docs/pricing
//   KIE.ai — https://kie.ai/pricing
//   Anthropic — Claude Sonnet 4.5 input $0.003 / 1K, output $0.015 / 1K
//
// All numbers in USD per unit (image, second, token, etc).

import { MODELS as HEYGEN_MODELS } from './heygen.js'

// KIE per-image rates by model + quality. Pulled from the public KIE
// pricing page for nano-banana-2, nano-banana-pro, nano-banana-edit,
// and gpt-image-2. Quality keys mirror what the SPA sends.
const KIE_USD_PER_IMAGE = {
  // Nano Banana 2 — text-to-image
  'nano-banana-2': {                  '1K': 0.04, '2K': 0.06, '4K': 0.09 },
  // Nano Banana Pro — premium tier
  'nano-banana-pro': {                '1K': 0.09, '2K': 0.09, '4K': 0.12 },
  // Nano Banana edit — image-to-image (flat across qualities)
  'nano-banana-edit': {               default: 0.02 },
  // GPT image 2 — both text-to-image and image-to-image cost the same per quality
  'gpt-image-2-text-to-image':  {     '1K': 0.03, '2K': 0.05, '4K': 0.08 },
  'gpt-image-2-image-to-image': {     '1K': 0.03, '2K': 0.05, '4K': 0.08 },
}

function kieImageCost(metadata = {}) {
  const model = metadata.model || 'nano-banana-2'
  const quality = (metadata.quality || '1K').toUpperCase()
  const count = Math.max(1, Number(metadata.count) || 1)
  const tier = KIE_USD_PER_IMAGE[model] || KIE_USD_PER_IMAGE['nano-banana-2']
  const perImage = tier[quality] ?? tier.default ?? 0.04
  return perImage * count
}

function heygenRenderCost(metadata = {}) {
  const modelKey = metadata.model_version || 'v4'
  const m = HEYGEN_MODELS[modelKey] || HEYGEN_MODELS.v4
  const seconds = Math.max(1, Number(metadata.duration_secs) || 1)
  // Default to 1080p tier; bump to 4K when the metadata flags it.
  const cents = metadata.quality === '4K' ? (m.cents_per_sec_4k ?? m.cents_per_sec) : m.cents_per_sec
  return seconds * (cents / 100)
}

// Per-action calculators, keyed by `consume:<action>` string. Each
// receives the credit_transactions row's metadata + the absolute units
// consumed; returns USD COGS or null if the action isn't catalogued
// (caller then falls back to a flat per-pool estimate).
const ACTION_COGS = {
  // Image gen: KIE wholesale by model + quality + count.
  'consume:image-gen': (meta) => kieImageCost(meta),
  // Avatar render: HeyGen per-second by model.
  'consume:photo-avatar-render': (meta) => heygenRenderCost(meta),
  // Caption / copy generation via Claude — rough Sonnet pass-through.
  // 1 ai_token consumed ~= 1 model token; Sonnet is ~$0.005 / token
  // averaged in/out, but we cap our consume to a fraction so this
  // mostly tracks token usage.
  'consume:content-generate': (meta, units) => Number(units) * (4 / 1_000_000),
  'consume:caption-gen':      (meta, units) => Number(units) * (4 / 1_000_000),
  'consume:script-gen':       (meta, units) => Number(units) * (4 / 1_000_000),
  'consume:auto-title':       (meta, units) => Number(units) * (4 / 1_000_000),
  'consume:script-split':     (meta, units) => Number(units) * (4 / 1_000_000),
  'consume:agent-chat':       (meta, units) => Number(units) * (4 / 1_000_000),
  'consume:bulk-agent':       (meta, units) => Number(units) * (4 / 1_000_000),
  'consume:landing-generate': (meta, units) => Number(units) * (4 / 1_000_000),
  'consume:landing-edit':     (meta, units) => Number(units) * (4 / 1_000_000),
  'consume:space-build':      (meta, units) => Number(units) * (4 / 1_000_000),
  'consume:parse-bible':      (meta, units) => Number(units) * (4 / 1_000_000),
  // Video polish — Vercel ffmpeg compute is the cost. Negligible per run.
  'consume:video-polish': () => 0.001,
  // Combine — also Vercel compute.
  'consume:combine-videos': () => 0.001,
  // ZapCap captions — flat per-call pricing on their side.
  'consume:zapcap-captions': () => 0.10,
  // Upload-Post — included in subscription, so per-call COGS is ~$0.
  'consume:upload-post': () => 0,
}

// Fallback: if an action isn't catalogued, fall back to "what we'd
// charge a customer for that many units in topup terms." This keeps
// the admin dashboard from showing $0 on novel actions.
const FALLBACK_PER_POOL_USD = {
  ai_tokens:     10 / 100_000,   // $10 / 100K tokens
  video_units:   20 / 10,        // $20 / 10 video units
  voice_minutes: 0,              // not yet sold
}

// Estimate USD cost for a single credit_transactions row.
//   row = { action, pool_type, delta, metadata, ... }
// `delta` is negative on consumption; we feed the absolute value into
// per-action calculators.
export function estimateCogsUsd(row) {
  if (!row) return 0
  const units = Math.abs(Number(row.delta) || 0)
  const calc = ACTION_COGS[row.action]
  if (calc) {
    try {
      const v = calc(row.metadata || {}, units)
      if (Number.isFinite(v) && v >= 0) return v
    } catch {}
  }
  const rate = FALLBACK_PER_POOL_USD[row.pool_type] || 0
  return units * rate
}
