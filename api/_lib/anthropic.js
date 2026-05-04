// Minimal Anthropic client. Two entry points:
//   message()      — non-streaming, returns full response.
//   streamMessage() — server-sent events generator yielding text deltas + final usage.
// Caller is responsible for credit metering using the returned usage.

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1'
const VERSION = '2023-06-01'
const DEFAULT_MODEL = 'claude-sonnet-4-5'

function key() {
  const k = process.env.ANTHROPIC_API_KEY
  if (!k) throw new Error('ANTHROPIC_API_KEY not set')
  return k
}

export async function message({ system, messages, max_tokens = 1024, model = DEFAULT_MODEL, ...rest }) {
  const resp = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': key(),
      'anthropic-version': VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens, system, messages, ...rest }),
  })
  const text = await resp.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text }
  if (!resp.ok) {
    const err = new Error(`anthropic ${resp.status}: ${body?.error?.message || text}`)
    err.status = resp.status
    err.data = body
    throw err
  }
  return body
}

// Async-iterable wrapper around the Anthropic SSE stream.
// Yields events of shape:
//   { type: 'text', text: '<delta>' }
//   { type: 'usage', usage: { input_tokens, output_tokens } }
//   { type: 'done' }
//   { type: 'error', error: '...' }
export async function* streamMessage({ system, messages, max_tokens = 1024, model = DEFAULT_MODEL, ...rest }) {
  const resp = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': key(),
      'anthropic-version': VERSION,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify({ model, max_tokens, system, messages, stream: true, ...rest }),
  })
  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => '')
    yield { type: 'error', error: `anthropic ${resp.status}: ${errText}` }
    return
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let inputTokens = 0
  let outputTokens = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE: events separated by "\n\n", lines start with "data: " or "event: "
      let idx
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const lines = rawEvent.split('\n')
        let dataPayload = ''
        for (const line of lines) {
          if (line.startsWith('data: ')) dataPayload += line.slice(6)
        }
        if (!dataPayload) continue
        let evt
        try { evt = JSON.parse(dataPayload) } catch { continue }

        switch (evt.type) {
          case 'message_start':
            if (evt.message?.usage?.input_tokens) inputTokens = evt.message.usage.input_tokens
            break
          case 'content_block_delta':
            if (evt.delta?.type === 'text_delta' && evt.delta.text) {
              yield { type: 'text', text: evt.delta.text }
            }
            break
          case 'message_delta':
            if (evt.usage?.output_tokens) outputTokens = evt.usage.output_tokens
            break
          case 'message_stop':
            yield { type: 'usage', usage: { input_tokens: inputTokens, output_tokens: outputTokens } }
            yield { type: 'done' }
            break
          case 'error':
            yield { type: 'error', error: evt.error?.message || 'stream error' }
            return
          default:
            // ignore other event types (ping, content_block_start, etc.)
            break
        }
      }
    }
  } catch (err) {
    yield { type: 'error', error: err.message || String(err) }
  } finally {
    try { reader.releaseLock() } catch {}
  }
}
