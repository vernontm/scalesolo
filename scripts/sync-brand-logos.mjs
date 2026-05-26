// Sync brand logos from Simple Icons (https://simpleicons.org).
//
// Run: npm run sync-logos
//
// What it does:
//   1. For each entry in BRAND_LIST with a simpleIcons slug, fetches
//      the SVG from cdn.simpleicons.org and writes it to
//      public/brand-logos/{slug}.svg — overwriting any existing file
//      so we always carry the latest official mark.
//   2. For entries with simpleIcons:null (Ray's own brands, niche AI
//      tools not in Simple Icons), leaves whatever file already exists
//      in public/brand-logos/ alone.
//   3. Regenerates api/studio/_lib/brand-logos-map.js — a generated
//      module that maps every alias to its file path. The overlay
//      renderer imports this map. Re-running this script keeps the
//      renderer in sync with the files on disk.
//
// Simple Icons CDN returns SVGs in the brand's official color by
// default (e.g. Claude orange, OpenAI black, Vercel black). To force
// a color, swap the URL for cdn.simpleicons.org/{slug}/{hex}.

import { mkdir, writeFile, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const LOGO_DIR = join(REPO_ROOT, 'public', 'brand-logos')
// Two copies of the map. Server-side (Node) imports the api/_lib one,
// browser-side (Puppeteer-rendered compositions) imports the public
// one. Both must stay in sync or the worker renders the wrong logos
// (the bug Ray hit: server map said scalesolo.png, browser map was
// still hitting Google favicons + returning the wrong icon).
const MAP_FILE        = join(REPO_ROOT, 'api', 'studio', '_lib', 'brand-logos-map.js')
const MAP_FILE_PUBLIC = join(REPO_ROOT, 'public', 'studio-compositions', '_brand-logos-map.js')

// ─── Brand catalog ───────────────────────────────────────────────────
// One entry per logical brand. Multiple aliases map to the same file
// so "Claude", "Anthropic", "claude.ai" all hit the same logo.
//
// Fields:
//   slug         — filename base (no extension). Snake-case-friendly.
//   aliases      — strings the renderer might see in spoken content.
//                  Normalized to lowercase + alphanumeric-only before
//                  matching, so spaces / dots / dashes are stripped.
//   simpleIcons  — slug at simpleicons.org/icons/{slug}, or null if
//                  this brand isn't covered (Ray's own brands, niche
//                  AI tools, etc.). null = keep existing manual file.
//   ext          — file extension. 'svg' for everything pulled from
//                  Simple Icons; 'png'/'jpeg' for manual files.
//
// To add a brand: append an entry below, re-run `npm run sync-logos`.

const BRAND_LIST = [
  // ─── AI: foundation models ─────────────────────────────────────
  { slug: 'claude',       aliases: ['claude', 'anthropic'],            simpleIcons: 'claude',         ext: 'svg' },
  { slug: 'chatgpt',      aliases: ['chatgpt', 'openai', 'gpt'],       simpleIcons: 'openai',         ext: 'svg' },
  { slug: 'gemini',       aliases: ['gemini', 'googlegemini'],         simpleIcons: 'googlegemini',   ext: 'svg' },
  { slug: 'perplexity',   aliases: ['perplexity', 'perplexityai'],     simpleIcons: 'perplexity',     ext: 'svg' },
  { slug: 'mistral',      aliases: ['mistral', 'mistralai'],           simpleIcons: 'mistralai',      ext: 'svg' },
  { slug: 'meta',         aliases: ['meta', 'metaai', 'llama'],        simpleIcons: 'meta',           ext: 'svg' },
  { slug: 'huggingface',  aliases: ['huggingface', 'hugging'],         simpleIcons: 'huggingface',    ext: 'svg' },

  // ─── AI: creator + content tools ───────────────────────────────
  { slug: 'midjourney',   aliases: ['midjourney'],                     simpleIcons: 'midjourney',     ext: 'svg' },
  { slug: 'runway',       aliases: ['runway', 'runwayml'],             simpleIcons: 'runway',         ext: 'svg' },
  { slug: 'elevenlabs',   aliases: ['elevenlabs', '11labs'],           simpleIcons: 'elevenlabs',     ext: 'svg' },
  { slug: 'heygen',       aliases: ['heygen'],                         simpleIcons: null,             ext: 'jpeg' },
  { slug: 'higgsfield',   aliases: ['higgsfield'],                     simpleIcons: null,             ext: 'jpeg' },
  { slug: 'openart',      aliases: ['openart'],                        simpleIcons: null,             ext: 'jpeg' },
  { slug: 'nano-banana',  aliases: ['nanobanana', 'nanobanana2'],      simpleIcons: null,             ext: 'jpeg' },

  // ─── Dev tools ────────────────────────────────────────────────
  { slug: 'github',       aliases: ['github'],                         simpleIcons: 'github',         ext: 'svg' },
  { slug: 'gitlab',       aliases: ['gitlab'],                         simpleIcons: 'gitlab',         ext: 'svg' },
  { slug: 'vercel',       aliases: ['vercel'],                         simpleIcons: 'vercel',         ext: 'svg' },
  { slug: 'netlify',      aliases: ['netlify'],                        simpleIcons: 'netlify',        ext: 'svg' },
  { slug: 'cloudflare',   aliases: ['cloudflare'],                     simpleIcons: 'cloudflare',     ext: 'svg' },
  { slug: 'supabase',     aliases: ['supabase'],                       simpleIcons: 'supabase',       ext: 'svg' },
  { slug: 'firebase',     aliases: ['firebase'],                       simpleIcons: 'firebase',       ext: 'svg' },
  { slug: 'docker',       aliases: ['docker'],                         simpleIcons: 'docker',         ext: 'svg' },
  { slug: 'mongodb',      aliases: ['mongodb', 'mongo'],               simpleIcons: 'mongodb',        ext: 'svg' },
  { slug: 'postgresql',   aliases: ['postgres', 'postgresql'],         simpleIcons: 'postgresql',     ext: 'svg' },
  { slug: 'mysql',        aliases: ['mysql'],                          simpleIcons: 'mysql',          ext: 'svg' },
  { slug: 'redis',        aliases: ['redis'],                          simpleIcons: 'redis',          ext: 'svg' },
  { slug: 'cursor',       aliases: ['cursor', 'cursorai'],             simpleIcons: 'cursor',         ext: 'svg' },
  { slug: 'replit',       aliases: ['replit'],                         simpleIcons: 'replit',         ext: 'svg' },

  // ─── Big tech ─────────────────────────────────────────────────
  { slug: 'google',       aliases: ['google'],                         simpleIcons: 'google',         ext: 'svg' },
  { slug: 'apple',        aliases: ['apple'],                          simpleIcons: 'apple',          ext: 'svg' },
  { slug: 'microsoft',    aliases: ['microsoft'],                      simpleIcons: 'microsoft',      ext: 'svg' },
  { slug: 'amazon',       aliases: ['amazon'],                         simpleIcons: 'amazon',         ext: 'svg' },
  { slug: 'aws',          aliases: ['aws', 'amazonwebservices'],       simpleIcons: 'amazonwebservices', ext: 'svg' },
  { slug: 'nvidia',       aliases: ['nvidia'],                         simpleIcons: 'nvidia',         ext: 'svg' },

  // ─── Social platforms ─────────────────────────────────────────
  { slug: 'x',            aliases: ['x', 'twitter'],                   simpleIcons: 'x',              ext: 'svg' },
  { slug: 'instagram',    aliases: ['instagram', 'ig'],                simpleIcons: 'instagram',      ext: 'svg' },
  { slug: 'tiktok',       aliases: ['tiktok'],                         simpleIcons: 'tiktok',         ext: 'svg' },
  { slug: 'youtube',      aliases: ['youtube', 'yt'],                  simpleIcons: 'youtube',        ext: 'svg' },
  { slug: 'facebook',     aliases: ['facebook', 'fb'],                 simpleIcons: 'facebook',       ext: 'svg' },
  { slug: 'linkedin',     aliases: ['linkedin'],                       simpleIcons: 'linkedin',       ext: 'svg' },
  { slug: 'threads',      aliases: ['threads'],                        simpleIcons: 'threads',        ext: 'svg' },
  { slug: 'pinterest',    aliases: ['pinterest'],                      simpleIcons: 'pinterest',      ext: 'svg' },
  { slug: 'reddit',       aliases: ['reddit'],                         simpleIcons: 'reddit',         ext: 'svg' },
  { slug: 'discord',      aliases: ['discord'],                        simpleIcons: 'discord',        ext: 'svg' },
  { slug: 'snapchat',     aliases: ['snapchat', 'snap'],               simpleIcons: 'snapchat',       ext: 'svg' },
  { slug: 'whatsapp',     aliases: ['whatsapp'],                       simpleIcons: 'whatsapp',       ext: 'svg' },
  { slug: 'telegram',     aliases: ['telegram'],                       simpleIcons: 'telegram',       ext: 'svg' },
  { slug: 'signal',       aliases: ['signal'],                         simpleIcons: 'signal',         ext: 'svg' },
  { slug: 'bluesky',      aliases: ['bluesky'],                        simpleIcons: 'bluesky',        ext: 'svg' },
  { slug: 'mastodon',     aliases: ['mastodon'],                       simpleIcons: 'mastodon',       ext: 'svg' },

  // ─── Productivity / SaaS ──────────────────────────────────────
  { slug: 'notion',       aliases: ['notion'],                         simpleIcons: 'notion',         ext: 'svg' },
  { slug: 'slack',        aliases: ['slack'],                          simpleIcons: 'slack',          ext: 'svg' },
  { slug: 'zoom',         aliases: ['zoom'],                           simpleIcons: 'zoom',           ext: 'svg' },
  { slug: 'gmail',        aliases: ['gmail'],                          simpleIcons: 'gmail',          ext: 'svg' },
  { slug: 'googledrive',  aliases: ['googledrive', 'drive'],           simpleIcons: 'googledrive',    ext: 'svg' },
  { slug: 'googledocs',   aliases: ['googledocs', 'docs'],             simpleIcons: 'googledocs',     ext: 'svg' },
  { slug: 'googlesheets', aliases: ['googlesheets', 'sheets'],         simpleIcons: 'googlesheets',   ext: 'svg' },
  { slug: 'googlecalendar', aliases: ['googlecalendar', 'gcal'],       simpleIcons: 'googlecalendar', ext: 'svg' },
  { slug: 'asana',        aliases: ['asana'],                          simpleIcons: 'asana',          ext: 'svg' },
  { slug: 'trello',       aliases: ['trello'],                         simpleIcons: 'trello',         ext: 'svg' },
  { slug: 'airtable',     aliases: ['airtable'],                       simpleIcons: 'airtable',       ext: 'svg' },
  { slug: 'monday',       aliases: ['monday', 'mondaycom'],            simpleIcons: 'mondaydotcom',   ext: 'svg' },
  { slug: 'linear',       aliases: ['linear'],                         simpleIcons: 'linear',         ext: 'svg' },
  { slug: 'zapier',       aliases: ['zapier'],                         simpleIcons: 'zapier',         ext: 'svg' },
  { slug: 'make',         aliases: ['make', 'integromat'],             simpleIcons: 'make',           ext: 'svg' },
  { slug: 'calendly',     aliases: ['calendly'],                       simpleIcons: 'calendly',       ext: 'svg' },

  // ─── Design tools ─────────────────────────────────────────────
  { slug: 'figma',        aliases: ['figma'],                          simpleIcons: 'figma',          ext: 'svg' },
  { slug: 'canva',        aliases: ['canva'],                          simpleIcons: 'canva',          ext: 'svg' },
  { slug: 'framer',       aliases: ['framer'],                         simpleIcons: 'framer',         ext: 'svg' },
  { slug: 'webflow',      aliases: ['webflow'],                        simpleIcons: 'webflow',        ext: 'svg' },
  { slug: 'adobe',        aliases: ['adobe'],                          simpleIcons: 'adobe',          ext: 'svg' },
  { slug: 'photoshop',    aliases: ['photoshop'],                      simpleIcons: 'adobephotoshop', ext: 'svg' },
  { slug: 'illustrator',  aliases: ['illustrator'],                    simpleIcons: 'adobeillustrator', ext: 'svg' },
  { slug: 'aftereffects', aliases: ['aftereffects'],                   simpleIcons: 'adobeaftereffects', ext: 'svg' },
  { slug: 'premiere',     aliases: ['premiere', 'premierepro'],        simpleIcons: 'adobepremierepro', ext: 'svg' },
  { slug: 'dribbble',     aliases: ['dribbble'],                       simpleIcons: 'dribbble',       ext: 'svg' },
  { slug: 'behance',      aliases: ['behance'],                        simpleIcons: 'behance',        ext: 'svg' },

  // ─── Payments / commerce ──────────────────────────────────────
  { slug: 'stripe',       aliases: ['stripe'],                         simpleIcons: 'stripe',         ext: 'svg' },
  { slug: 'paypal',       aliases: ['paypal'],                         simpleIcons: 'paypal',         ext: 'svg' },
  { slug: 'shopify',      aliases: ['shopify'],                        simpleIcons: 'shopify',        ext: 'svg' },
  { slug: 'square',       aliases: ['square'],                         simpleIcons: 'square',         ext: 'svg' },
  { slug: 'venmo',        aliases: ['venmo'],                          simpleIcons: 'venmo',          ext: 'svg' },
  { slug: 'cashapp',      aliases: ['cashapp'],                        simpleIcons: 'cashapp',        ext: 'svg' },
  { slug: 'wise',         aliases: ['wise'],                           simpleIcons: 'wise',           ext: 'svg' },

  // ─── Creator / publishing ─────────────────────────────────────
  { slug: 'substack',     aliases: ['substack'],                       simpleIcons: 'substack',       ext: 'svg' },
  { slug: 'medium',       aliases: ['medium'],                         simpleIcons: 'medium',         ext: 'svg' },
  { slug: 'ghost',        aliases: ['ghost'],                          simpleIcons: 'ghost',          ext: 'svg' },
  { slug: 'gumroad',      aliases: ['gumroad'],                        simpleIcons: 'gumroad',        ext: 'svg' },
  { slug: 'patreon',      aliases: ['patreon'],                        simpleIcons: 'patreon',        ext: 'svg' },
  { slug: 'twitch',       aliases: ['twitch'],                         simpleIcons: 'twitch',         ext: 'svg' },
  { slug: 'spotify',      aliases: ['spotify'],                        simpleIcons: 'spotify',        ext: 'svg' },
  { slug: 'applepodcasts', aliases: ['applepodcasts', 'podcasts'],     simpleIcons: 'applepodcasts',  ext: 'svg' },

  // ─── Browsers ─────────────────────────────────────────────────
  { slug: 'chrome',       aliases: ['chrome', 'googlechrome'],         simpleIcons: 'googlechrome',   ext: 'svg' },
  { slug: 'safari',       aliases: ['safari'],                         simpleIcons: 'safari',         ext: 'svg' },
  { slug: 'firefox',      aliases: ['firefox'],                        simpleIcons: 'firefox',        ext: 'svg' },
  { slug: 'edge',         aliases: ['edge', 'microsoftedge'],          simpleIcons: 'microsoftedge',  ext: 'svg' },
  { slug: 'brave',        aliases: ['brave'],                          simpleIcons: 'brave',          ext: 'svg' },

  // ─── Languages / frameworks ───────────────────────────────────
  { slug: 'javascript',   aliases: ['javascript', 'js'],               simpleIcons: 'javascript',     ext: 'svg' },
  { slug: 'typescript',   aliases: ['typescript', 'ts'],               simpleIcons: 'typescript',     ext: 'svg' },
  { slug: 'python',       aliases: ['python'],                         simpleIcons: 'python',         ext: 'svg' },
  { slug: 'react',        aliases: ['react', 'reactjs'],               simpleIcons: 'react',          ext: 'svg' },
  { slug: 'nextjs',       aliases: ['nextjs', 'next'],                 simpleIcons: 'nextdotjs',      ext: 'svg' },
  { slug: 'nodejs',       aliases: ['nodejs', 'node'],                 simpleIcons: 'nodedotjs',      ext: 'svg' },
  { slug: 'tailwindcss',  aliases: ['tailwind', 'tailwindcss'],        simpleIcons: 'tailwindcss',    ext: 'svg' },

  // ─── Email + comms ────────────────────────────────────────────
  { slug: 'mailchimp',    aliases: ['mailchimp'],                      simpleIcons: 'mailchimp',      ext: 'svg' },
  { slug: 'sendgrid',     aliases: ['sendgrid'],                       simpleIcons: 'sendgrid',       ext: 'svg' },
  { slug: 'twilio',       aliases: ['twilio'],                         simpleIcons: 'twilio',         ext: 'svg' },
  { slug: 'intercom',     aliases: ['intercom'],                       simpleIcons: 'intercom',       ext: 'svg' },

  // ─── Ray's own brands (manual files, never overwritten) ───────
  { slug: 'scalesolo',    aliases: ['scalesolo'],                                                     simpleIcons: null, ext: 'png' },
  { slug: 'vtm',          aliases: ['vtm', 'vernontech', 'vernontechandmedia'],                       simpleIcons: null, ext: 'png' },
]

// ─── Sync logic ──────────────────────────────────────────────────────

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

async function pathExists(p) {
  try { await access(p); return true } catch { return false }
}

async function fetchOne(brand) {
  if (!brand.simpleIcons) return { brand, status: 'skipped-manual' }
  const url = `https://cdn.simpleicons.org/${brand.simpleIcons}`
  let resp
  try {
    resp = await fetch(url, { headers: { 'User-Agent': 'scalesolo-logo-sync/1.0' } })
  } catch (e) {
    return { brand, status: 'error', error: e.message }
  }
  if (!resp.ok) return { brand, status: 'not-found', code: resp.status }
  const svg = await resp.text()
  if (!svg.includes('<svg')) return { brand, status: 'not-svg' }
  const outPath = join(LOGO_DIR, `${brand.slug}.svg`)
  await writeFile(outPath, svg, 'utf8')
  return { brand, status: 'ok', bytes: svg.length }
}

// Find the actual file on disk for a brand, trying common extensions
// in priority order (svg first — vector, then raster). Returns the
// extension string or null if nothing exists. Lets the map honor
// whatever Ray sourced manually (chatgpt.png, heygen.jpeg, etc.)
// when Simple Icons doesn't ship the brand.
async function resolveOnDiskExt(slug, preferredExt) {
  // Try the preferred ext first, then fall through known formats.
  const order = [preferredExt, 'svg', 'png', 'jpeg', 'jpg', 'webp']
    .filter((v, i, a) => v && a.indexOf(v) === i)
  for (const ext of order) {
    if (await pathExists(join(LOGO_DIR, `${slug}.${ext}`))) return ext
  }
  return null
}

async function buildMapSource(brands) {
  const lines = []
  lines.push('// AUTO-GENERATED by scripts/sync-brand-logos.mjs.')
  lines.push('// Do NOT edit by hand. Re-run `npm run sync-logos` to regenerate.')
  lines.push('//')
  lines.push('// Maps normalized brand-name keys → public path to the logo file.')
  lines.push('// The overlay renderer normalizes spoken names (lowercase +')
  lines.push('// strip non-alphanumerics) before looking up here.')
  lines.push('')
  lines.push('export const LOCAL_BRAND_LOGOS = {')
  const rows = []
  const missing = []
  for (const b of brands) {
    const ext = await resolveOnDiskExt(b.slug, b.ext)
    if (!ext) {
      missing.push(b.slug)
      continue
    }
    const filePath = `/brand-logos/${b.slug}.${ext}`
    for (const a of b.aliases) {
      rows.push([normalize(a), filePath])
    }
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]))
  // Always quote keys. Some aliases start with a digit ("11labs") which
  // would be a parse error as a bare object-literal key in JS.
  const keyWidth = Math.max(...rows.map((r) => JSON.stringify(r[0]).length), 1)
  for (const [k, v] of rows) {
    lines.push(`  ${JSON.stringify(k).padEnd(keyWidth)}: ${JSON.stringify(v)},`)
  }
  lines.push('}')
  lines.push('')
  return { src: lines.join('\n'), missing }
}

async function main() {
  await mkdir(LOGO_DIR, { recursive: true })

  console.log(`Syncing ${BRAND_LIST.length} brands from Simple Icons…\n`)

  // Fetch in batches of 8 to be polite to the CDN.
  const results = []
  const BATCH = 8
  for (let i = 0; i < BRAND_LIST.length; i += BATCH) {
    const slice = BRAND_LIST.slice(i, i + BATCH)
    const batch = await Promise.all(slice.map(fetchOne))
    results.push(...batch)
  }

  let ok = 0, notFound = 0, skippedManual = 0, errors = 0
  const missingFiles = []
  for (const r of results) {
    if (r.status === 'ok') {
      ok++
      console.log(`  ✓ ${r.brand.slug.padEnd(20)} ${r.bytes} bytes`)
    } else if (r.status === 'not-found') {
      notFound++
      console.log(`  ✗ ${r.brand.slug.padEnd(20)} not on Simple Icons (HTTP ${r.code}) — tried slug "${r.brand.simpleIcons}"`)
    } else if (r.status === 'skipped-manual') {
      skippedManual++
      // Verify the manual file actually exists; warn if not.
      const expected = join(LOGO_DIR, `${r.brand.slug}.${r.brand.ext}`)
      if (!(await pathExists(expected))) {
        missingFiles.push(`${r.brand.slug}.${r.brand.ext}`)
      }
    } else {
      errors++
      console.log(`  ! ${r.brand.slug.padEnd(20)} ${r.status} ${r.error || ''}`)
    }
  }

  // Build + write the generated map. Only brands with an actual file
  // on disk get entries, so the renderer never points at a 404.
  const { src, missing } = await buildMapSource(BRAND_LIST)
  await mkdir(dirname(MAP_FILE), { recursive: true })
  await mkdir(dirname(MAP_FILE_PUBLIC), { recursive: true })
  await writeFile(MAP_FILE, src, 'utf8')
  await writeFile(MAP_FILE_PUBLIC, src, 'utf8')

  console.log(`\nSummary:`)
  console.log(`  Downloaded from Simple Icons: ${ok}`)
  console.log(`  Not in Simple Icons (logged): ${notFound}`)
  console.log(`  Manual brands (skipped):      ${skippedManual}`)
  console.log(`  Errors:                       ${errors}`)
  console.log(`  Brands in BRAND_LIST without any file (omitted from map): ${missing.length}`)
  for (const s of missing) console.log(`    - ${s}`)
  console.log(`  Map file:                     ${MAP_FILE.replace(REPO_ROOT + '/', '')}`)
  if (missingFiles.length) {
    console.log(`\nWARNING — manual brands marked simpleIcons:null but file missing:`)
    for (const f of missingFiles) console.log(`  - ${f}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
