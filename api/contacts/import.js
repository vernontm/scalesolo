// CSV import.
//   POST   { profile_id, filename, total_rows, mapping, rows: [...] } → creates job + processes synchronously
//   GET    ?id=...                                                    → job status
// Rows are parsed client-side via PapaParse and posted in one batch (<=10K rows safe under 60s).

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const id = req.query.id
      if (!id) {
        const profileId = req.query.profile_id
        if (!profileId) return res.status(400).json({ error: 'id or profile_id required' })
        await assertProfileAccess(auth.user.id, profileId)
        const rows = await supaFetch(
          `import_jobs?profile_id=eq.${profileId}&order=created_at.desc&limit=10&select=*`
        )
        return res.status(200).json({ jobs: rows || [] })
      }
      const rows = await supaFetch(`import_jobs?id=eq.${id}&select=*`)
      const job = rows?.[0]
      if (!job) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, job.profile_id)
      return res.status(200).json({ job })
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const body = req.body || {}
    const { profile_id, filename, mapping, rows } = body
    if (!profile_id || !mapping || !Array.isArray(rows)) {
      return res.status(400).json({ error: 'profile_id + mapping + rows required' })
    }
    await assertProfileAccess(auth.user.id, profile_id)

    // Create job row
    const created = await supaFetch('import_jobs', {
      method: 'POST',
      body: {
        profile_id,
        user_id: auth.user.id,
        source_filename: filename || 'upload.csv',
        total_rows: rows.length,
        field_mapping: mapping,
        status: 'running',
      },
    })
    const job = Array.isArray(created) ? created[0] : created

    // Process rows
    let imported = 0, skipped = 0, failed = 0
    const errors = []

    // Build a map: csv_col -> contact_field
    // mapping shape: { "csv_col_1": "email", "csv_col_2": "name", ... }
    // Recognized contact_fields:
    const ALLOWED = ['email','name','phone','tags','city','state','country','source','birthday_month','birthday_day','discount_code','signed_up_at']

    // Pull existing emails to detect duplicates in one batch (max 5K returned per call)
    const candidateEmails = new Set()
    for (const r of rows) {
      for (const [k, v] of Object.entries(r)) {
        if (mapping[k] === 'email' && typeof v === 'string' && EMAIL_RE.test(v)) candidateEmails.add(v.toLowerCase())
      }
    }

    let existingSet = new Set()
    if (candidateEmails.size > 0) {
      const list = Array.from(candidateEmails).map(encodeURIComponent).join(',')
      // Postgrest "in" can handle long lists but URL might 414 for >2K. Skip dedup pre-check if huge.
      if (candidateEmails.size <= 1500) {
        try {
          const exist = await supaFetch(
            `email_contacts?profile_id=eq.${profile_id}&email=in.(${list})&select=email`
          )
          existingSet = new Set((exist || []).map((r) => r.email.toLowerCase()))
        } catch {}
      }
    }

    // Build inserts
    const toInsert = []
    for (const r of rows) {
      const contact = { profile_id, source: `import:${job.id}`, signed_up_at: new Date().toISOString() }
      for (const [csvCol, csvVal] of Object.entries(r)) {
        const target = mapping[csvCol]
        if (!target || !ALLOWED.includes(target)) continue
        if (target === 'tags') {
          // Accept comma-separated tags
          if (typeof csvVal === 'string' && csvVal.trim()) {
            contact.tags = csvVal.split(/[,;]/).map((t) => t.trim()).filter(Boolean)
          }
          continue
        }
        if (target === 'birthday_month' || target === 'birthday_day') {
          const n = parseInt(csvVal, 10)
          if (Number.isFinite(n) && n > 0) contact[target] = n
          continue
        }
        contact[target] = (csvVal == null ? null : String(csvVal).trim())
      }
      // Validate email
      if (!contact.email || !EMAIL_RE.test(contact.email)) {
        skipped++
        continue
      }
      const lower = contact.email.toLowerCase()
      contact.email = lower
      if (existingSet.has(lower)) {
        skipped++
        continue
      }
      existingSet.add(lower)
      toInsert.push(contact)
    }

    // Bulk insert in chunks of 500
    const CHUNK = 500
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const slice = toInsert.slice(i, i + CHUNK)
      try {
        await supaFetch('email_contacts', { method: 'POST', body: slice, prefer: 'return=minimal' })
        imported += slice.length
      } catch (err) {
        failed += slice.length
        errors.push({ chunk_start: i, error: err.message })
        if (errors.length > 10) break
      }
    }

    // Append a 'imported' activity event for each new contact (best-effort, capped)
    // (Skipped to avoid N round-trips for huge imports — surfaced in the UI as a banner instead.)

    // Mark job complete
    await supaFetch(`import_jobs?id=eq.${job.id}`, {
      method: 'PATCH',
      body: {
        imported_count: imported,
        skipped_count: skipped,
        failed_count: failed,
        status: failed > 0 && imported === 0 ? 'failed' : 'complete',
        error_log: errors,
        completed_at: new Date().toISOString(),
      },
      prefer: 'return=minimal',
    })

    return res.status(200).json({
      job_id: job.id,
      imported, skipped, failed,
      errors: errors.slice(0, 5),
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
