// Brand-bible / arbitrary-text chunking + embedding pipeline.
import { embed } from './openai.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

async function supa(path, options = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await resp.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!resp.ok) {
    const err = new Error(`supa ${resp.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`)
    err.status = resp.status
    err.data = data
    throw err
  }
  return data
}

// Split text into ~500-token chunks at paragraph or sentence boundaries.
// Approx: 1 token ≈ 4 chars in English. So 500 tokens ≈ 2000 chars.
const TARGET_CHARS = 2000
const OVERLAP_CHARS = 200

export function chunk(text) {
  if (!text || typeof text !== 'string') return []
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (clean.length <= TARGET_CHARS) return [clean]

  const chunks = []
  // Prefer paragraph splits, then sentence boundaries.
  const paragraphs = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)

  let cursor = ''
  for (const para of paragraphs) {
    if ((cursor + '\n\n' + para).length <= TARGET_CHARS) {
      cursor = cursor ? `${cursor}\n\n${para}` : para
    } else {
      if (cursor) chunks.push(cursor)
      // If a single paragraph is bigger than target, split on sentence boundaries.
      if (para.length > TARGET_CHARS) {
        // char-by-char split avoiding lookbehind regex (Safari < 16.4 bug).
        const sentences = []
        let buf = ''
        for (let i = 0; i < para.length; i++) {
          buf += para[i]
          const ch = para[i]
          const next = para[i + 1] || ''
          if ((ch === '.' || ch === '!' || ch === '?') && (next === ' ' || next === '\n' || !next)) {
            sentences.push(buf.trim())
            buf = ''
          }
        }
        if (buf) sentences.push(buf.trim())

        let inner = ''
        for (const sent of sentences) {
          if ((inner + ' ' + sent).length <= TARGET_CHARS) {
            inner = inner ? `${inner} ${sent}` : sent
          } else {
            if (inner) chunks.push(inner)
            inner = sent
          }
        }
        if (inner) chunks.push(inner)
        cursor = ''
      } else {
        cursor = para
      }
    }
  }
  if (cursor) chunks.push(cursor)

  // Light overlap between adjacent chunks for retrieval continuity.
  if (OVERLAP_CHARS > 0 && chunks.length > 1) {
    const overlapped = [chunks[0]]
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]
      const tail = prev.slice(-OVERLAP_CHARS)
      overlapped.push(`${tail}\n${chunks[i]}`)
    }
    return overlapped
  }
  return chunks
}

// Replace all chunks for (profile, source, source_ref) atomically:
// delete existing → embed new chunks → insert.
// Returns { inserted, usage }.
export async function indexBrandBible(profileId, brandBibleText) {
  if (!brandBibleText || !brandBibleText.trim()) {
    // Brand bible cleared — wipe stale chunks too.
    await supa(`agent_knowledge_chunks?profile_id=eq.${profileId}&source=eq.brand_bible`, {
      method: 'DELETE',
      prefer: 'return=minimal',
    })
    return { inserted: 0, usage: null }
  }

  const chunks = chunk(brandBibleText)
  if (chunks.length === 0) return { inserted: 0, usage: null }

  // Embed in batch
  const { embeddings, usage } = await embed(chunks)

  // Wipe existing brand-bible chunks for this profile
  await supa(`agent_knowledge_chunks?profile_id=eq.${profileId}&source=eq.brand_bible`, {
    method: 'DELETE',
    prefer: 'return=minimal',
  })

  // Insert in one batch (PostgREST accepts an array body)
  const rows = chunks.map((text, i) => ({
    profile_id: profileId,
    source: 'brand_bible',
    chunk_index: i,
    chunk_text: text,
    // pgvector accepts string form like '[0.1, 0.2, ...]'
    embedding: `[${embeddings[i].join(',')}]`,
    metadata: {},
  }))
  await supa('agent_knowledge_chunks', { method: 'POST', body: rows, prefer: 'return=minimal' })

  return { inserted: rows.length, usage }
}

// Top-k chunks via pgvector cosine similarity, called from the chat endpoint.
export async function retrieveKnowledge(profileId, queryEmbedding, { matchCount = 5, minSimilarity = 0.3 } = {}) {
  const rows = await supa('rpc/match_knowledge', {
    method: 'POST',
    body: {
      p_profile_id: profileId,
      p_embedding: `[${queryEmbedding.join(',')}]`,
      p_match_count: matchCount,
      p_min_similarity: minSimilarity,
    },
  })
  return rows || []
}
