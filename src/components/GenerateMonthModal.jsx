// "Generate Content for the Month" — multi-step modal triggered from
// the schedule page's CalendarView. Walks the user through:
//
//   1. goal      — free-text intent for the month (pre-filled from
//                  profile.monthly_content_goal so it's a one-tap
//                  flow on subsequent months)
//   2. platforms — checkboxes gated by /api/account/uploadpost-connected.
//                  Disabled platforms render dimmed with a note so the
//                  user knows why.
//   3. cadence   — posts/day/platform + start/end dates. Defaults to
//                  4/day, today → end of month.
//   4. confirm   — calls /api/content/generate-month?phase=preview to
//                  pull cost + count, then runs phase=run in chunks
//                  with a progress bar.
//
// All requests carry the Supabase access token; no auth wrapper here
// because every call hits an authenticated route.
//
// Important: the run phase is chunked. Each /api/content/generate-month
// call processes ~3 days, returns next_offset, and we loop until the
// API reports done=true. This sidesteps Vercel's function timeout for
// a 30-day, 4-platform, 4-posts/day job.

import { useEffect, useMemo, useState } from 'react'
import { X, ChevronLeft, ChevronRight, Sparkles, Check, AlertCircle, Loader2 } from 'lucide-react'

const ALL_PLATFORMS = [
  { id: 'threads',   label: 'Threads',   primary: true },
  { id: 'twitter',   label: 'Twitter',   primary: true },
  { id: 'instagram', label: 'Instagram', primary: true },
  { id: 'facebook',  label: 'Facebook',  primary: true },
  { id: 'linkedin',  label: 'LinkedIn',  primary: false },
  { id: 'tiktok',    label: 'TikTok',    primary: false },
  { id: 'youtube',   label: 'YouTube',   primary: false },
  { id: 'bluesky',   label: 'Bluesky',   primary: false },
]

export default function GenerateMonthModal({ profileId, token, onClose, onComplete }) {
  const [stepIdx, setStepIdx] = useState(0)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  // Connected platforms gate the platform-step checkboxes. While
  // loading we treat everything as "unknown" — user can still select,
  // but the dropdown warns that publishes will fail for unconnected ones.
  const [connected, setConnected] = useState(null) // null = loading
  const [savedGoal, setSavedGoal] = useState('')

  const [goal, setGoal] = useState('')
  const [platforms, setPlatforms] = useState(['threads', 'twitter', 'instagram', 'facebook'])
  const [postsPerDay, setPostsPerDay] = useState(4)
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [endDate, setEndDate] = useState(() => {
    const d = new Date()
    d.setMonth(d.getMonth() + 1, 0)  // last day of current month
    return d.toISOString().slice(0, 10)
  })
  const [preview, setPreview] = useState(null) // {total_posts, estimated_cost_usd, ...}
  const [progress, setProgress] = useState(null) // {current_offset, total_days, inserted}

  const steps = ['goal', 'platforms', 'cadence', 'confirm']
  const step = steps[stepIdx]

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // Load the saved monthly goal + connected platforms in parallel.
  useEffect(() => {
    if (!profileId || !token) return
    let cancelled = false
    ;(async () => {
      try {
        const [pRes, cRes] = await Promise.all([
          fetch(`/api/profiles?id=${profileId}`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`/api/account/uploadpost-connected?profile_id=${profileId}`, { headers: { Authorization: `Bearer ${token}` } }),
        ])
        const pBody = pRes.ok ? await pRes.json() : null
        const cBody = cRes.ok ? await cRes.json() : { connected_platforms: [], all_platforms: [] }
        if (cancelled) return
        // Profile endpoint may return either { profile: {...} } or the row directly.
        const prof = pBody?.profile || pBody
        const g = prof?.monthly_content_goal || ''
        setSavedGoal(g)
        if (g && !goal) setGoal(g)
        setConnected(cBody)
      } catch (e) {
        if (!cancelled) setConnected({ connected_platforms: [], all_platforms: [], warning: e.message })
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, token])

  const canNext = () => {
    if (step === 'goal') return goal.trim().length >= 8
    if (step === 'platforms') return platforms.length >= 1
    if (step === 'cadence') return postsPerDay >= 1 && postsPerDay <= 10 && startDate && endDate
    return true
  }

  const next = async () => {
    if (!canNext()) return
    setError(null)
    if (step === 'cadence') {
      // Pull preview before showing the confirm step so the user sees cost.
      setBusy(true)
      try {
        const r = await fetch('/api/content/generate-month?phase=preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            profile_id: profileId, goal, platforms, posts_per_day_per_platform: postsPerDay,
            start_date_iso: new Date(`${startDate}T00:00:00`).toISOString(),
            end_date_iso:   new Date(`${endDate}T23:59:59`).toISOString(),
          }),
        })
        const body = await r.json()
        if (!r.ok) throw new Error(body?.error || `Preview failed (${r.status})`)
        setPreview(body)
      } catch (e) {
        setError(e.message)
        setBusy(false)
        return
      }
      setBusy(false)
    }
    setStepIdx((i) => Math.min(steps.length - 1, i + 1))
  }
  const back = () => { setError(null); setStepIdx((i) => Math.max(0, i - 1)) }

  const runGeneration = async () => {
    setError(null)
    setBusy(true)
    setProgress({ current_offset: 0, total_days: preview?.total_days || 0, inserted: 0 })
    try {
      let offset = 0
      let inserted = 0
      const totalDays = preview?.total_days || 0
      // Chunk loop — each call returns next_offset. Stop when done=true.
      // Safety cap of 60 iterations so a runaway server doesn't pin us.
      for (let i = 0; i < 60; i++) {
        const r = await fetch('/api/content/generate-month?phase=run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            profile_id: profileId, goal, platforms,
            posts_per_day_per_platform: postsPerDay,
            start_date_iso: new Date(`${startDate}T00:00:00`).toISOString(),
            end_date_iso:   new Date(`${endDate}T23:59:59`).toISOString(),
            day_offset: offset,
            chunk_days: 3,
          }),
        })
        const body = await r.json()
        if (!r.ok) throw new Error(body?.error || `Generation failed at day ${offset} (${r.status})`)
        inserted += (body.inserted?.length || 0)
        offset = body.next_offset
        setProgress({ current_offset: offset, total_days: totalDays, inserted })
        if (body.done) break
      }
      onComplete?.({ inserted })
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div style={cardStyle}>
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={brandIcon}><Sparkles size={16} /></div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Generate content for the month</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: 0.06 }}>
                STEP {stepIdx + 1} OF {steps.length}
              </div>
            </div>
          </div>
          <button onClick={onClose} style={closeBtn} aria-label="Close"><X size={18} /></button>
        </div>

        <div style={bodyStyle}>
          {error && <div style={errorPanel}><AlertCircle size={14} style={{ verticalAlign: -2, marginRight: 6 }} />{error}</div>}

          {step === 'goal' && (
            <StepGoal value={goal} onChange={setGoal} saved={savedGoal} />
          )}
          {step === 'platforms' && (
            <StepPlatforms value={platforms} onChange={setPlatforms} connected={connected} />
          )}
          {step === 'cadence' && (
            <StepCadence
              postsPerDay={postsPerDay} setPostsPerDay={setPostsPerDay}
              startDate={startDate} setStartDate={setStartDate}
              endDate={endDate} setEndDate={setEndDate}
            />
          )}
          {step === 'confirm' && (
            <StepConfirm
              preview={preview}
              goal={goal} platforms={platforms} postsPerDay={postsPerDay}
              progress={progress} busy={busy}
            />
          )}
        </div>

        <div style={footerStyle}>
          <button onClick={back} disabled={stepIdx === 0 || busy} className="btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <ChevronLeft size={14} /> Back
          </button>
          {step !== 'confirm' ? (
            <button onClick={next} disabled={!canNext() || busy} className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {busy ? <Loader2 size={14} className="spin" /> : null}
              Next <ChevronRight size={14} />
            </button>
          ) : (
            <button onClick={runGeneration} disabled={busy || progress?.current_offset >= (preview?.total_days || 0) && progress?.inserted > 0} className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {busy ? <><Loader2 size={14} className="spin" /> Generating…</> : <>Generate {preview?.total_posts || 0} posts <Check size={14} /></>}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Step components ──────────────────────────────────────────────

function StepGoal({ value, onChange, saved }) {
  return (
    <Section title="What's the goal for this month?" hint="One sentence is enough. Pre-filled from last month so you can usually just tweak.">
      <textarea
        value={value} onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. Drive Threads followers to the VTM Community via short, opinionated AI takes."
        rows={4}
        style={{
          width: '100%', padding: 14, fontSize: 14, lineHeight: 1.5,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 10, color: 'var(--text)', resize: 'vertical',
          fontFamily: 'inherit',
        }}
      />
      {saved && value === saved && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
          ↑ pre-filled from last month's goal
        </div>
      )}
    </Section>
  )
}

function StepPlatforms({ value, onChange, connected }) {
  const connectedSet = useMemo(() => new Set(connected?.connected_platforms || []), [connected])
  const toggle = (id) => {
    if (value.includes(id)) onChange(value.filter((p) => p !== id))
    else onChange([...value, id])
  }
  const loading = connected === null
  return (
    <Section
      title="Which platforms?"
      hint={loading ? 'Loading your connected accounts…' : `${connectedSet.size} platforms connected to Upload-Post.`}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        {ALL_PLATFORMS.map((p) => {
          const isConnected = connectedSet.has(p.id)
          const selected = value.includes(p.id)
          const disabled = !loading && !isConnected
          return (
            <button
              key={p.id} type="button"
              onClick={() => !disabled && toggle(p.id)}
              disabled={disabled}
              style={{
                padding: '14px 16px', textAlign: 'left',
                background: selected ? 'rgba(239,68,68,0.10)' : 'var(--surface)',
                border: `1.5px solid ${selected ? 'var(--red)' : 'var(--border)'}`,
                borderRadius: 10, cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.4 : 1,
                transition: 'all 0.15s',
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{p.label}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                {loading ? 'checking…' : isConnected ? 'Connected ✓' : 'Not connected'}
              </div>
            </button>
          )
        })}
      </div>
      {!loading && connectedSet.size === 0 && (
        <div style={{ marginTop: 16, padding: 12, background: 'var(--surface-2)', border: '1px dashed var(--border)', borderRadius: 8, fontSize: 12, color: 'var(--muted)' }}>
          No platforms detected as connected. You can still generate posts — they'll save as drafts you can connect + publish later.
        </div>
      )}
    </Section>
  )
}

function StepCadence({ postsPerDay, setPostsPerDay, startDate, setStartDate, endDate, setEndDate }) {
  return (
    <Section title="How much, how often?" hint="Defaults to 4 posts per platform per day, today through end of month.">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
        <Field label="Posts per day per platform">
          <input
            type="number" min={1} max={10}
            value={postsPerDay}
            onChange={(e) => setPostsPerDay(Math.max(1, Math.min(10, parseInt(e.target.value || '1', 10))))}
            style={inputStyle}
          />
        </Field>
        <Field label="Start date">
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="End date">
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={inputStyle} />
        </Field>
      </div>
    </Section>
  )
}

function StepConfirm({ preview, goal, platforms, postsPerDay, progress, busy }) {
  if (!preview) {
    return <Section title="Ready" hint="Loading preview…"><div className="spinner" /></Section>
  }
  const pct = progress && progress.total_days
    ? Math.min(100, Math.round((progress.current_offset / progress.total_days) * 100))
    : 0
  return (
    <Section title="Review and generate" hint="Final check before Claude starts writing. You'll review every post in the swipe queue before anything publishes.">
      <div style={recapGrid}>
        <Recap label="Goal" value={goal} />
        <Recap label="Platforms" value={platforms.join(', ')} />
        <Recap label="Cadence" value={`${postsPerDay} × ${platforms.length} platforms × ${preview.total_days} days = ${preview.total_posts} posts`} />
        <Recap label="Estimated cost" value={`~$${preview.estimated_cost_usd?.toFixed(2)} in AI`} />
        <Recap label="Estimated time" value={`~${Math.ceil((preview.estimated_seconds || 60) / 60)} min`} />
      </div>
      {progress && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
            Day {progress.current_offset} / {progress.total_days} — {progress.inserted} posts generated
          </div>
          <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg, var(--red), var(--red-dark))', transition: 'width 0.3s' }} />
          </div>
        </div>
      )}
    </Section>
  )
}

// ── small helpers ────────────────────────────────────────────────

function Section({ title, hint, children }) {
  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.4, marginBottom: 4 }}>{title}</h2>
      {hint && <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.5 }}>{hint}</div>}
      {children}
    </div>
  )
}
function Field({ label, children }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.06, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>{label}</div>
      {children}
    </label>
  )
}
function Recap({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.06, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, color: 'var(--text)' }}>{value}</div>
    </div>
  )
}

// ── styles ───────────────────────────────────────────────────────

const overlayStyle = {
  position: 'fixed', inset: 0, zIndex: 250,
  background: 'rgba(10,10,12,0.86)', backdropFilter: 'blur(6px)',
  display: 'grid', placeItems: 'center', padding: 20, overflowY: 'auto',
}
const cardStyle = {
  width: '100%', maxWidth: 720,
  background: 'var(--bg-base, #0a0a0c)',
  border: '1px solid var(--border)', borderRadius: 14,
  display: 'flex', flexDirection: 'column',
  maxHeight: 'calc(100vh - 40px)',
}
const headerStyle = {
  padding: '18px 24px',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  borderBottom: '1px solid var(--border)',
}
const brandIcon = {
  width: 30, height: 30, borderRadius: 8,
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff', display: 'grid', placeItems: 'center',
}
const closeBtn = {
  background: 'transparent', border: 'none', cursor: 'pointer',
  color: 'var(--muted)', padding: 6, display: 'inline-flex', alignItems: 'center',
}
const bodyStyle = {
  padding: '24px 24px 20px',
  flex: 1, overflowY: 'auto', minHeight: 0,
}
const footerStyle = {
  padding: '16px 24px',
  borderTop: '1px solid var(--border)',
  display: 'flex', justifyContent: 'space-between',
}
const errorPanel = {
  marginBottom: 14, padding: '10px 14px',
  background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.35)',
  borderRadius: 8, color: 'var(--red)', fontSize: 13,
}
const inputStyle = {
  width: '100%', padding: '10px 12px', fontSize: 14,
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 8, color: 'var(--text)', fontFamily: 'inherit',
  boxSizing: 'border-box',
}
const recapGrid = {
  display: 'grid', gap: 12,
  background: 'var(--surface-2)', border: '1px solid var(--border)',
  borderRadius: 10, padding: 16,
}
