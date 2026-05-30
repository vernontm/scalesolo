#!/usr/bin/env node
// One-off brand-reference ingest. Uploads images from one or more
// local directories into the Supabase `brand-references` bucket and
// inserts a brand_visual_references row per file for the given
// profile.
//
// Usage:
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_SERVICE_KEY=<service-role-jwt> \
//   node scripts/ingest-brand-refs.mjs \
//       --profile <profile-uuid> \
//       --threads "/path/to/Threads examples" \
//       --carousel "/path/to/Carousel examples" \
//       --graphic "/path/to/Graphics"
//
// Notes:
//   - Each --<kind> flag points at a directory; every image inside it
//     is uploaded with kind=<kind>. JPEG/PNG/WEBP/GIF only; everything
//     else is skipped with a warning.
//   - Files are uploaded to brand-references/<profile_id>/<kind>/<ts>-<rand>.<ext>.
//   - DB rows are inserted via PostgREST using the same service key.
//   - Re-runs are NOT deduped on content. Re-running uploads new
//     copies; delete extras from the UI afterward if you double-ran.

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { argv, env, exit } from 'node:process'

const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])
const MIME_FOR_EXT = {
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
}
const KIND_FLAGS = ['threads', 'carousel', 'graphic', 'thumbnail', 'other']

function parseArgs() {
  const out = { profile: null, dirs: {} }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--profile') out.profile = argv[++i]
    else if (a.startsWith('--') && KIND_FLAGS.includes(a.slice(2))) {
      out.dirs[a.slice(2)] = argv[++i]
    }
  }
  return out
}

async function ingestDir(supabaseUrl, serviceKey, profileId, kind, dir) {
  let entries = []
  try {
    entries = await readdir(dir)
  } catch (e) {
    console.warn(`[ingest] skipping ${kind} — ${dir}: ${e.message}`)
    return { uploaded: 0, skipped: 0, failed: 0 }
  }
  let uploaded = 0, skipped = 0, failed = 0
  for (const name of entries) {
    if (name.startsWith('.')) { skipped++; continue }
    const ext = extname(name).toLowerCase()
    if (!ALLOWED_EXTS.has(ext)) { skipped++; continue }
    const localPath = join(dir, name)
    let st
    try { st = await stat(localPath) } catch { failed++; continue }
    if (!st.isFile()) { skipped++; continue }

    const mime = MIME_FOR_EXT[ext]
    const ts = Date.now()
    const rand = Math.random().toString(36).slice(2, 8)
    const storagePath = `${profileId}/${kind}/${ts}-${rand}${ext === '.jpeg' ? '.jpg' : ext}`

    try {
      const bytes = await readFile(localPath)
      const putRes = await fetch(
        `${supabaseUrl}/storage/v1/object/brand-references/${encodeURI(storagePath)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': mime,
            'x-upsert': 'false',
          },
          body: bytes,
        },
      )
      if (!putRes.ok) {
        const body = await putRes.text().catch(() => '')
        throw new Error(`storage upload ${putRes.status}: ${body.slice(0, 200)}`)
      }
      const publicUrl = `${supabaseUrl}/storage/v1/object/public/brand-references/${storagePath}`

      const insertRes = await fetch(
        `${supabaseUrl}/rest/v1/brand_visual_references`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${serviceKey}`,
            apikey: serviceKey,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
          },
          body: JSON.stringify({
            profile_id: profileId,
            kind,
            storage_path: storagePath,
            public_url: publicUrl,
            notes: `Ingested from ${basename(dir)}/${name}`,
          }),
        },
      )
      if (!insertRes.ok) {
        const body = await insertRes.text().catch(() => '')
        throw new Error(`db insert ${insertRes.status}: ${body.slice(0, 200)}`)
      }
      uploaded++
      console.log(`  ✓ ${kind}/${name}`)
    } catch (e) {
      failed++
      console.warn(`  ✗ ${kind}/${name}: ${e.message}`)
    }
  }
  return { uploaded, skipped, failed }
}

async function main() {
  const supabaseUrl = env.SUPABASE_URL
  const serviceKey  = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) must be set in env.')
    exit(1)
  }
  const { profile, dirs } = parseArgs()
  if (!profile) {
    console.error('Pass --profile <uuid>')
    exit(1)
  }
  if (!Object.keys(dirs).length) {
    console.error('Pass at least one --<kind> <dir> flag (kinds: threads, carousel, graphic, thumbnail, other)')
    exit(1)
  }

  console.log(`[ingest] profile=${profile}`)
  const totals = { uploaded: 0, skipped: 0, failed: 0 }
  for (const [kind, dir] of Object.entries(dirs)) {
    console.log(`[ingest] ${kind}: ${dir}`)
    const r = await ingestDir(supabaseUrl, serviceKey, profile, kind, dir)
    totals.uploaded += r.uploaded
    totals.skipped  += r.skipped
    totals.failed   += r.failed
  }
  console.log(`[ingest] done — uploaded=${totals.uploaded} skipped=${totals.skipped} failed=${totals.failed}`)
}

main().catch((e) => { console.error(e); exit(1) })
