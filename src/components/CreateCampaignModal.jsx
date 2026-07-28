// "Create Campaign" — the marketing-campaign onboarding wizard, launched
// per client from the Profiles page. Walks through:
//
//   1. setup     — length (days) + posts/day + start date + platforms
//   2. details   — goal + specials (recurring/dated) + standout selling points
//   3. content   — content-type mix + the real-asset library (upload/analyze)
//   4. holidays  — auto-computed observances in the window, toggle on/off
//   5. review    — create the campaign, preview cost, then generate the
//                  plan in chunks (each post lands in the swipe queue)
//
// Generation is chunked exactly like GenerateMonthModal so a 30-day plan
// fits inside Vercel's function budget. The plan (captions + per-post
// media briefs) is produced here; media generation is a later phase.

import { useEffect, useMemo, useState } from 'react'
import { X, ChevronLeft, ChevronRight, Megaphone, Check, AlertCircle, Loader2, Plus, Trash2 } from 'lucide-react'
import BrandAssetsPanel from './BrandAssetsPanel.jsx'

const ALL_PLATFORMS = [
  { id: 'instagram', label: 'Instagram' },
  { id: 'facebook',  label: 'Facebook' },
  { id: 'tiktok',    label: 'TikTok' },
  { id: 'threads',   label: 'Threads' },
  { id: 'x',         label: 'X (Twitter)' },
  { id: 'youtube',   label: 'YouTube' },
  { id: 'linkedin',  label: 'LinkedIn' },
  { id: 'pinterest', label: 'Pinterest' },
]
const WEEKDAYS = [['mon', 'M'], ['tue', 'T'], ['wed', 'W'], ['thu', 'T'], ['fri', 'F'], ['sat', 'S'], ['sun', 'S']]
const MIX_TYPES = [
  ['image', 'Single images'],
  ['carousel', 'Carousels'],
  ['video', 'Videos'],
  ['promo', 'Promos'],
  ['mood', 'Mood / lifestyle'],
  ['text', 'Text-only'],
]
const LENGTH_PRESETS = [7, 14, 30]

export default function CreateCampaignModal({ profileId, token, onClose, onComplete }) {
  const [stepIdx, setStepIdx] = useState(0)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const [connected, setConnected] = useState(null)
  const [name, setName] = useState('')
  const [durationDays, setDurationDays] = useState(7)
  const [postsPerDay, setPostsPerDay] = useState(1)
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [platforms, setPlatforms] = useState(['instagram', 'facebook', 'tiktok'])
  const [goal, setGoal] = useState('')
  const [specials, setSpecials] = useState([])
  const [standouts, setStandouts] = useState([])
  const [standoutDraft, setStandoutDraft] = useState('')
  const [contentMix, setContentMix] = useState({ image: 2, carousel: 1, video: 1, promo: 1, mood: 1, text: 1 })
  const [holidays, setHolidays] = useState([]) // [{date,name,kind, on:true}]
  const [assetCount, setAssetCount] = useState(0)

  const [campaignId, setCampaignId] = useState(null)
  const [preview, setPreview] = useState(null)
  const [progress, setProgress] = useState(null)

  const steps = ['setup', 'details', 'content', 'holidays', 'review']
  const step = steps[stepIdx]

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // Connected platforms for the setup gate.
  useEffect(() => {
    if (!profileId || !token) return
    let cancelled = false
    fetch(`/api/account/uploadpost-connected?profile_id=${profileId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : { connected_platforms: [] }))
      .then((b) => { if (!cancelled) setConnected(b) })
      .catch(() => { if (!cancelled) setConnected({ connected_platforms: [] }) })
    return () => { cancelled = true }
  }, [profileId, token])

  // Auto-compute holidays whenever the window changes (before entering the step).
  const loadHolidays = async () => {
    try {
      const r = await fetch(
        `/api/campaigns?action=holidays&start=${startDate}&days=${durationDays}&region=US`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      const b = await r.json()
      if (r.ok) {
        setHolidays((prev) => {
          const prevOn = new Map(prev.map((h) => [`${h.date}|${h.name}`, h.on]))
          return (b.holidays || []).map((h) => ({ ...h, on: prevOn.get(`${h.date}|${h.name}`) ?? true }))
        })
      }
    } catch { /* non-fatal */ }
  }

  const connectedSet = useMemo(() => new Set(connected?.connected_platforms || []), [connected])

  const canNext = () => {
    if (step === 'setup') return durationDays >= 1 && postsPerDay >= 1 && platforms.length >= 1 && startDate
    if (step === 'details') return goal.trim().length >= 8
    return true
  }

  const next = async () => {
    if (!canNext()) return
    setError(null)
    if (step === 'content') { await loadHolidays() }
    if (step === 'holidays') { await enterReview(); return }
    setStepIdx((i) => Math.min(steps.length - 1, i + 1))
  }
  const back = () => { setError(null); setStepIdx((i) => Math.max(0, i - 1)) }

  // Persist the campaign (create or update) then pull the cost preview.
  const enterReview = async () => {
    setBusy(true)
    try {
      const payload = {
        profile_id: profileId,
        name: name.trim() || `${durationDays}-day campaign`,
        duration_days: durationDays,
        posts_per_day: postsPerDay,
        start_date: startDate,
        goal,
        specials: specials.map(cleanSpecial).filter((s) => s.title),
        standouts,
        content_mix: contentMix,
        holidays: holidays.filter((h) => h.on).map(({ date, name: n, kind }) => ({ date, name: n, kind })),
      }
      let id = campaignId
      if (id) {
        const r = await fetch(`/api/campaigns?id=${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        })
        if (!r.ok) throw new Error((await r.json())?.error || 'Could not update campaign')
      } else {
        const r = await fetch('/api/campaigns', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        })
        const b = await r.json()
        if (!r.ok) throw new Error(b?.error || 'Could not create campaign')
        id = b.campaign?.id
        setCampaignId(id)
      }
      const pr = await fetch('/api/campaigns/generate-plan?phase=preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ campaign_id: id, platforms, chunk_days: 1 }),
      })
      const pb = await pr.json()
      if (!pr.ok) throw new Error(pb?.error || 'Preview failed')
      setPreview(pb)
      setStepIdx(steps.indexOf('review'))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const runGeneration = async () => {
    if (!campaignId) return
    setError(null); setBusy(true)
    const totalDays = preview?.total_days || durationDays
    setProgress({ current_offset: 0, total_days: totalDays, inserted: 0, failed_days: 0 })
    let offset = 0, inserted = 0, failedDays = 0
    const maxIter = Math.min(96, totalDays + 4)
    for (let i = 0; i < maxIter; i++) {
      try {
        const r = await fetch('/api/campaigns/generate-plan?phase=run', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ campaign_id: campaignId, platforms, day_offset: offset, chunk_days: 1 }),
        })
        const b = await r.json()
        if (!r.ok) { failedDays += 1; offset += 1; setProgress({ current_offset: offset, total_days: totalDays, inserted, failed_days: failedDays }); if (offset >= totalDays) break; continue }
        inserted += (b.inserted?.length || 0)
        offset = b.next_offset
        setProgress({ current_offset: offset, total_days: totalDays, inserted, failed_days: failedDays })
        if (b.done) break
      } catch {
        failedDays += 1; offset += 1
        setProgress({ current_offset: offset, total_days: totalDays, inserted, failed_days: failedDays })
        if (offset >= totalDays) break
      }
    }
    setBusy(false)
    if (failedDays > 0 && inserted > 0) setError(`Done, but ${failedDays} day(s) failed. ${inserted} posts landed.`)
    else if (failedDays > 0) setError('Generation failed on every day. Check API logs.')
    onComplete?.({ campaignId, inserted, failed_days: failedDays })
  }

  const finished = progress && progress.current_offset >= (preview?.total_days || durationDays) && !busy

  return (
    <div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div style={cardStyle}>
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={brandIcon}><Megaphone size={16} /></div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Create campaign</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: 0.06 }}>STEP {stepIdx + 1} OF {steps.length}</div>
            </div>
          </div>
          <button onClick={onClose} style={closeBtn} aria-label="Close"><X size={18} /></button>
        </div>

        <div style={bodyStyle}>
          {error && <div style={errorPanel}><AlertCircle size={14} style={{ verticalAlign: -2, marginRight: 6 }} />{error}</div>}

          {step === 'setup' && (
            <StepSetup
              name={name} setName={setName}
              durationDays={durationDays} setDurationDays={setDurationDays}
              postsPerDay={postsPerDay} setPostsPerDay={setPostsPerDay}
              startDate={startDate} setStartDate={setStartDate}
              platforms={platforms} setPlatforms={setPlatforms} connectedSet={connectedSet} connected={connected}
            />
          )}
          {step === 'details' && (
            <StepDetails
              goal={goal} setGoal={setGoal}
              specials={specials} setSpecials={setSpecials}
              standouts={standouts} setStandouts={setStandouts}
              standoutDraft={standoutDraft} setStandoutDraft={setStandoutDraft}
            />
          )}
          {step === 'content' && (
            <StepContent
              contentMix={contentMix} setContentMix={setContentMix}
              profileId={profileId} token={token} onCountChange={setAssetCount}
            />
          )}
          {step === 'holidays' && (
            <StepHolidays holidays={holidays} setHolidays={setHolidays} />
          )}
          {step === 'review' && (
            <StepReview
              preview={preview} name={name} durationDays={durationDays} postsPerDay={postsPerDay}
              platforms={platforms} assetCount={assetCount} specials={specials}
              holidays={holidays} progress={progress}
            />
          )}
        </div>

        <div style={footerStyle}>
          <button onClick={back} disabled={stepIdx === 0 || busy} className="btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <ChevronLeft size={14} /> Back
          </button>
          {step !== 'review' ? (
            <button onClick={next} disabled={!canNext() || busy} className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {busy ? <Loader2 size={14} className="spin" /> : null}
              {step === 'holidays' ? 'Review' : 'Next'} <ChevronRight size={14} />
            </button>
          ) : finished ? (
            <button onClick={onClose} className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              Done <Check size={14} />
            </button>
          ) : (
            <button onClick={runGeneration} disabled={busy} className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {busy ? <><Loader2 size={14} className="spin" /> Generating…</> : <>Generate {preview?.total_posts || 0} posts <Check size={14} /></>}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function cleanSpecial(s) {
  return {
    title: String(s.title || '').slice(0, 120).trim(),
    cadence: s.date ? 'once' : 'weekly',
    days: Array.isArray(s.days) ? s.days : [],
    date: s.date || null,
    discount_pct: Number.isFinite(+s.discount_pct) && +s.discount_pct > 0 ? +s.discount_pct : null,
    note: String(s.note || '').slice(0, 200) || null,
  }
}

// ── Steps ──────────────────────────────────────────────────────────

function StepSetup({ name, setName, durationDays, setDurationDays, postsPerDay, setPostsPerDay, startDate, setStartDate, platforms, setPlatforms, connectedSet, connected }) {
  const loading = connected === null
  const toggle = (id) => setPlatforms((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  return (
    <Section title="Set up the campaign" hint="How long, how many posts per day, and where it goes.">
      <Field label="Campaign name (optional)">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. August Foot Traffic Push" style={inputStyle} />
      </Field>
      <div style={{ marginTop: 14 }}>
        <div style={fieldLabel}>Length</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {LENGTH_PRESETS.map((d) => (
            <button key={d} type="button" onClick={() => setDurationDays(d)}
              style={pill(durationDays === d)}>{d} days</button>
          ))}
          <input type="number" min={1} max={90} value={durationDays}
            onChange={(e) => setDurationDays(Math.max(1, Math.min(90, parseInt(e.target.value || '1', 10))))}
            style={{ ...inputStyle, width: 90 }} />
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>days</span>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginTop: 14 }}>
        <Field label="Posts per day">
          <input type="number" min={1} max={10} value={postsPerDay}
            onChange={(e) => setPostsPerDay(Math.max(1, Math.min(10, parseInt(e.target.value || '1', 10))))}
            style={inputStyle} />
        </Field>
        <Field label="Start date">
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />
        </Field>
      </div>
      <div style={{ marginTop: 16 }}>
        <div style={fieldLabel}>Platforms {!loading && <span style={{ textTransform: 'none', fontWeight: 400 }}>· {connectedSet.size} connected</span>}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
          {ALL_PLATFORMS.map((p) => {
            const isConn = connectedSet.has(p.id)
            const selected = platforms.includes(p.id)
            const disabled = !loading && !isConn
            return (
              <button key={p.id} type="button" onClick={() => !disabled && toggle(p.id)} disabled={disabled}
                style={{
                  padding: '10px 12px', textAlign: 'left',
                  background: selected ? 'rgba(239,68,68,0.10)' : 'var(--surface)',
                  border: `1.5px solid ${selected ? 'var(--red)' : 'var(--border)'}`,
                  borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
                }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{p.label}</div>
                <div style={{ fontSize: 10, color: 'var(--muted)' }}>{loading ? '…' : isConn ? 'Connected ✓' : 'Not connected'}</div>
              </button>
            )
          })}
        </div>
      </div>
    </Section>
  )
}

function StepDetails({ goal, setGoal, specials, setSpecials, standouts, setStandouts, standoutDraft, setStandoutDraft }) {
  const addSpecial = () => setSpecials((s) => [...s, { title: '', days: [], date: '', discount_pct: '', note: '' }])
  const updateSpecial = (i, patch) => setSpecials((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const removeSpecial = (i) => setSpecials((s) => s.filter((_, j) => j !== i))
  const toggleDay = (i, code) => setSpecials((s) => s.map((x, j) => {
    if (j !== i) return x
    const days = x.days.includes(code) ? x.days.filter((d) => d !== code) : [...x.days, code]
    return { ...x, days }
  }))
  const addStandout = () => {
    const v = standoutDraft.trim()
    if (v && !standouts.includes(v)) setStandouts((s) => [...s, v])
    setStandoutDraft('')
  }
  return (
    <Section title="What makes this brand worth a post?" hint="Goal, any specials, and the things that make this place stand out.">
      <Field label="Campaign goal">
        <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3}
          placeholder="e.g. Drive weekend foot traffic and online orders for Sanabreh's Bay Area location."
          style={{ ...inputStyle, resize: 'vertical' }} />
      </Field>

      <div style={{ marginTop: 16 }}>
        <div style={fieldLabel}>Specials & promos</div>
        {specials.map((s, i) => (
          <div key={i} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input value={s.title} onChange={(e) => updateSpecial(i, { title: e.target.value })} placeholder="e.g. $7 Wrap Wednesday" style={{ ...inputStyle, flex: 1 }} />
              <input type="number" min={0} max={90} value={s.discount_pct} onChange={(e) => updateSpecial(i, { discount_pct: e.target.value })} placeholder="% off" style={{ ...inputStyle, width: 80 }} />
              <button type="button" onClick={() => removeSpecial(i)} style={iconGhost} title="Remove"><Trash2 size={14} /></button>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--muted)', marginRight: 4 }}>Every:</span>
              {WEEKDAYS.map(([code, letter], di) => (
                <button key={di} type="button" onClick={() => toggleDay(i, code)}
                  style={{ ...dayDot, ...(s.days.includes(code) ? { background: 'var(--red)', color: '#fff', borderColor: 'var(--red)' } : {}) }}>{letter}</button>
              ))}
              <span style={{ fontSize: 11, color: 'var(--muted)', margin: '0 4px' }}>or date:</span>
              <input type="date" value={s.date || ''} onChange={(e) => updateSpecial(i, { date: e.target.value })} style={{ ...inputStyle, width: 150, padding: '6px 8px' }} />
            </div>
          </div>
        ))}
        <button type="button" onClick={addSpecial} className="btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <Plus size={14} /> Add special
        </button>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={fieldLabel}>Standout selling points</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={standoutDraft} onChange={(e) => setStandoutDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addStandout() } }}
            placeholder="e.g. $15 hookah, great wifi for coworking, quiet…" style={{ ...inputStyle, flex: 1 }} />
          <button type="button" onClick={addStandout} className="btn-ghost"><Plus size={14} /></button>
        </div>
        {standouts.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {standouts.map((s) => (
              <span key={s} style={chip}>
                {s}
                <button type="button" onClick={() => setStandouts((arr) => arr.filter((x) => x !== s))} style={chipX}>×</button>
              </span>
            ))}
          </div>
        )}
      </div>
    </Section>
  )
}

function StepContent({ contentMix, setContentMix, profileId, token, onCountChange }) {
  const setVal = (k, v) => setContentMix((m) => ({ ...m, [k]: Math.max(0, Math.min(10, v)) }))
  return (
    <Section title="Content mix & real assets" hint="Set the balance of content types, then upload real photos/videos so the AI keeps your product exact.">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginBottom: 20 }}>
        {MIX_TYPES.map(([k, label]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px' }}>
            <span style={{ fontSize: 13 }}>{label}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button type="button" onClick={() => setVal(k, (contentMix[k] || 0) - 1)} style={stepper}>−</button>
              <span style={{ minWidth: 16, textAlign: 'center', fontWeight: 700, fontSize: 14 }}>{contentMix[k] || 0}</span>
              <button type="button" onClick={() => setVal(k, (contentMix[k] || 0) + 1)} style={stepper}>+</button>
            </div>
          </div>
        ))}
      </div>
      <div style={fieldLabel}>Real asset library</div>
      <BrandAssetsPanel profileId={profileId} token={token} compact onCountChange={onCountChange} />
    </Section>
  )
}

function StepHolidays({ holidays, setHolidays }) {
  const toggle = (idx) => setHolidays((arr) => arr.map((h, i) => (i === idx ? { ...h, on: !h.on } : h)))
  return (
    <Section title="Holidays in this window" hint="We auto-found these. Toggle off any you don't want the campaign to build around.">
      {!holidays.length ? (
        <div style={emptyBox}>No notable holidays or food days fall in this window.</div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {holidays.map((h, i) => (
            <button key={`${h.date}-${h.name}`} type="button" onClick={() => toggle(i)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 14px', textAlign: 'left', borderRadius: 8, cursor: 'pointer',
                background: h.on ? 'rgba(239,68,68,0.08)' : 'var(--surface)',
                border: `1px solid ${h.on ? 'var(--red)' : 'var(--border)'}`, opacity: h.on ? 1 : 0.55,
              }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{h.name}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>{h.date} · {h.kind}</div>
              </div>
              {h.on && <Check size={16} style={{ color: 'var(--red)' }} />}
            </button>
          ))}
        </div>
      )}
    </Section>
  )
}

function StepReview({ preview, name, durationDays, postsPerDay, platforms, assetCount, specials, holidays, progress }) {
  if (!preview) return <Section title="Ready" hint="Loading preview…"><div className="spinner" /></Section>
  const pct = progress && progress.total_days ? Math.min(100, Math.round((progress.current_offset / progress.total_days) * 100)) : 0
  const onHolidays = holidays.filter((h) => h.on).length
  return (
    <Section title="Review and generate" hint="You'll review every post in the swipe queue before anything publishes.">
      <div style={recapGrid}>
        <Recap label="Campaign" value={name.trim() || `${durationDays}-day campaign`} />
        <Recap label="Scope" value={`${postsPerDay} post/day × ${preview.total_days} days = ${preview.total_posts} posts`} />
        <Recap label="Platforms" value={platforms.join(', ')} />
        <Recap label="Real assets" value={`${assetCount} uploaded`} />
        <Recap label="Specials" value={specials.filter((s) => s.title).length ? specials.filter((s) => s.title).map((s) => s.title).join(', ') : 'none'} />
        <Recap label="Holidays" value={`${onHolidays} in window`} />
        <Recap label="Estimated cost" value={`~$${preview.estimated_cost_usd?.toFixed(2)} in AI (plan only)`} />
      </div>
      {progress && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
            Day {progress.current_offset} / {progress.total_days} — {progress.inserted} posts generated
            {progress.failed_days > 0 && <span style={{ color: 'var(--red)', marginLeft: 8 }}>· {progress.failed_days} skipped</span>}
          </div>
          <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg, var(--red), var(--red-dark))', transition: 'width 0.3s' }} />
          </div>
        </div>
      )}
    </Section>
  )
}

// ── helpers + styles ────────────────────────────────────────────────
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
      <div style={fieldLabel}>{label}</div>
      {children}
    </label>
  )
}
function Recap({ label, value }) {
  return (
    <div>
      <div style={fieldLabel}>{label}</div>
      <div style={{ fontSize: 14, color: 'var(--text)' }}>{value}</div>
    </div>
  )
}
const pill = (active) => ({
  padding: '8px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  background: active ? 'rgba(239,68,68,0.12)' : 'var(--surface)',
  border: `1.5px solid ${active ? 'var(--red)' : 'var(--border)'}`, color: 'var(--text)',
})
const fieldLabel = { fontSize: 11, fontWeight: 700, letterSpacing: 0.06, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }
const overlayStyle = { position: 'fixed', inset: 0, zIndex: 250, background: 'rgba(10,10,12,0.86)', backdropFilter: 'blur(6px)', display: 'grid', placeItems: 'center', padding: 20, overflowY: 'auto' }
const cardStyle = { width: '100%', maxWidth: 760, background: 'var(--bg-base, #0a0a0c)', border: '1px solid var(--border)', borderRadius: 14, display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 40px)' }
const headerStyle = { padding: '18px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border)' }
const brandIcon = { width: 30, height: 30, borderRadius: 8, background: 'linear-gradient(135deg, var(--red), var(--red-dark))', color: '#fff', display: 'grid', placeItems: 'center' }
const closeBtn = { background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 6, display: 'inline-flex', alignItems: 'center' }
const bodyStyle = { padding: '24px 24px 20px', flex: 1, overflowY: 'auto', minHeight: 0 }
const footerStyle = { padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between' }
const errorPanel = { marginBottom: 14, padding: '10px 14px', background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 8, color: 'var(--red)', fontSize: 13 }
const inputStyle = { width: '100%', padding: '10px 12px', fontSize: 14, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', fontFamily: 'inherit', boxSizing: 'border-box' }
const recapGrid = { display: 'grid', gap: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: 16 }
const emptyBox = { padding: 20, background: 'var(--surface-2)', border: '1px dashed var(--border)', borderRadius: 10, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }
const iconGhost = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: 8, cursor: 'pointer', color: 'var(--muted)', display: 'grid', placeItems: 'center' }
const dayDot = { width: 28, height: 28, borderRadius: '50%', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12, cursor: 'pointer' }
const chip = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, fontSize: 12 }
const chipX = { background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: 0 }
const stepper = { width: 26, height: 26, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }
