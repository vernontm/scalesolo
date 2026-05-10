// /api/onboarding/parse-doc — extract plain text from an uploaded
// DOCX / Markdown / TXT file so the onboarding survey can pre-fill
// the new profile's brand_bible. PDFs aren't parsed server-side
// (pdf-parse adds 4MB+ to the bundle); users with a PDF go through
// the "copy extraction prompt" path instead.
//
// POST body: { filename, content_base64 }
//   filename → used to detect format by extension
//   content_base64 → the file contents
// Response: { text }

import { setCors, requireUser } from '../_lib/supabase.js'

const MAX_BYTES = 4 * 1024 * 1024  // 4MB hard cap

export const config = { maxDuration: 30 }

function decodeBase64(b64) {
  const cleaned = String(b64 || '').replace(/^data:[^;]+;base64,/, '')
  return Buffer.from(cleaned, 'base64')
}

async function parseDocx(buf) {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer: buf })
  return String(result?.value || '')
}

function parsePlain(buf) {
  return buf.toString('utf8')
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { filename = '', content_base64 = '' } = req.body || {}
    if (!content_base64) return res.status(400).json({ error: 'content_base64 required' })

    const buf = decodeBase64(content_base64)
    if (buf.length === 0) return res.status(400).json({ error: 'empty file' })
    if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'file too large (4MB max)' })

    const lower = String(filename).toLowerCase()
    let text = ''
    if (lower.endsWith('.docx')) {
      text = await parseDocx(buf)
    } else if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.txt')) {
      text = parsePlain(buf)
    } else if (lower.endsWith('.pdf')) {
      return res.status(415).json({
        error: "PDFs aren't parsed server-side. Use the “Copy extraction prompt” option below to convert it with ChatGPT or Claude, then paste the result.",
      })
    } else {
      return res.status(415).json({ error: 'Unsupported file type. Upload .docx, .md, or .txt.' })
    }

    // Hard cap on returned text length so a 4MB file doesn't bloat
    // the new profile's brand_bible. 12k chars ≈ 3k tokens, more than
    // enough for the prompt budget.
    const trimmed = (text || '').replace(/\r\n/g, '\n').trim()
    return res.status(200).json({ text: trimmed.slice(0, 12000) })
  } catch (err) {
    console.error('parse-doc error:', err?.stack || err)
    return res.status(500).json({ error: err.message || 'Parse failed' })
  }
}
