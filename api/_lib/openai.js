// Minimal OpenAI client — only embeddings for M3.
const OPENAI_BASE = 'https://api.openai.com/v1'

function key() {
  const k = process.env.OPENAI_API_KEY
  if (!k) throw new Error('OPENAI_API_KEY not set')
  return k
}

// Embed an array of strings → array of 1536-dim vectors.
// text-embedding-3-small: $0.02 per 1M tokens (cheapest production-grade model).
export async function embed(texts, model = 'text-embedding-3-small') {
  if (!Array.isArray(texts)) texts = [texts]
  const resp = await fetch(`${OPENAI_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input: texts }),
  })
  const text = await resp.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text }
  if (!resp.ok) {
    const err = new Error(`openai ${resp.status}: ${body?.error?.message || text}`)
    err.status = resp.status
    err.data = body
    throw err
  }
  // OpenAI returns {data: [{embedding: [...]}, ...]} in same order as input.
  return {
    embeddings: body.data.map((d) => d.embedding),
    usage: body.usage, // { prompt_tokens, total_tokens }
  }
}

export async function embedOne(text, model) {
  const { embeddings, usage } = await embed([text], model)
  return { embedding: embeddings[0], usage }
}
