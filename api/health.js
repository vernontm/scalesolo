const { setCors } = require('./_lib/supabase')

module.exports = async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  return res.status(200).json({
    ok: true,
    service: 'scalesolo',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  })
}
