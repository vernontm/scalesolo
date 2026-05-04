// GET /api/agent/messages?conversation_id=...
// Lists all messages in a conversation in chronological order.
import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const conversationId = req.query.conversation_id
    if (!conversationId) return res.status(400).json({ error: 'conversation_id required' })

    const conv = await supaFetch(`agent_conversations?id=eq.${conversationId}&select=profile_id,title`)
    const profileId = conv?.[0]?.profile_id
    if (!profileId) return res.status(404).json({ error: 'Not found' })
    await assertProfileAccess(auth.user.id, profileId)

    const rows = await supaFetch(
      `agent_messages?conversation_id=eq.${conversationId}&order=created_at.asc&select=id,role,content,pinned,input_tokens,output_tokens,created_at`
    )
    return res.status(200).json({
      conversation: { id: conversationId, title: conv[0].title, profile_id: profileId },
      messages: rows || [],
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
