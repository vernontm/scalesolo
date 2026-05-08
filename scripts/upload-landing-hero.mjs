#!/usr/bin/env node
// One-off uploader for the re-encoded hero video. Uses the SDK so we get
// chunked upload + retry behaviour instead of a single 11MB curl POST,
// which the local network was breaking with TLS 'bad record mac'.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

// run with: node --env-file=.env scripts/upload-landing-hero.mjs
const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1) }

const supabase = createClient(URL, KEY, { auth: { persistSession: false } })

const localPath = process.argv[2] || `${process.env.HOME}/Downloads/scalesolo-transcode/scalesolo_dash.mp4`
const remotePath = process.argv[3] || 'scalesolo_dash.mp4'

const buf = readFileSync(localPath)
console.log(`uploading ${localPath} (${(buf.length/1e6).toFixed(2)} MB) → landing-media/${remotePath}`)

const { data, error } = await supabase.storage.from('landing-media').upload(remotePath, buf, {
  contentType: 'video/mp4', upsert: true,
})
if (error) { console.error('upload failed:', error); process.exit(1) }
console.log('ok:', data)
