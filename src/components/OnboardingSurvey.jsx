// 6-step onboarding survey, ported from the original scalesolo.ai repo
// and re-skinned in the brand red. Pops up the first time an
// authenticated user hits the dashboard with onboarding_completed=false.
//
// Flow:
//   1. Business type        (single-select grid + Other text)
//   2. Biggest challenge    (single-select list)
//   3. Features of interest (multi-select)
//   4. Current monthly spend (single-select)
//   5. Tools currently used (multi-select chips + Other text)
//   6. How they heard       (single-select chips + Other text)
//
// Blocking by design: full-screen overlay, no close button. The user
// has to finish to see the dashboard. Answers post to /api/me/onboarding
// and refresh that user_profiles row.

import { useEffect, useState } from 'react'
import {
  Briefcase, Sparkles, ShoppingBag, Megaphone, Cpu, Wrench, MoreHorizontal,
  Clock, VideoOff, DollarSign, MessageCircle, TrendingUp, Layers,
  Mail, UserCircle2, Mic, Image as ImageIcon, Bot, Check,
  ChevronLeft, ChevronRight, Loader2, Zap, X,
} from 'lucide-react'

const STEPS = [
  // 1. Business type — grid of icon cards.
  {
    id: 'businessType',
    type: 'single',
    title: 'What best describes your business?',
    options: [
      { value: 'coach',        label: 'Coach / Consultant',           Icon: Briefcase },
      { value: 'creator',      label: 'Content Creator / Influencer', Icon: Sparkles },
      { value: 'ecom',         label: 'E-commerce Brand',             Icon: ShoppingBag },
      { value: 'agency',       label: 'Agency / Freelancer',          Icon: Megaphone },
      { value: 'saas',         label: 'SaaS / Tech Startup',          Icon: Cpu },
      { value: 'service',      label: 'Service Provider',             Icon: Wrench },
      { value: 'other',        label: 'Other',                        Icon: MoreHorizontal },
    ],
    layout: 'grid',
    otherKey: 'businessTypeOther',
  },
  // 2. Biggest content challenge — single-select list.
  {
    id: 'contentChallenge',
    type: 'single',
    title: "What's your biggest content challenge right now?",
    options: [
      { value: 'no-time',      label: "No time to create consistently",                          Icon: Clock },
      { value: 'no-camera',    label: "Don't want to be on camera",                              Icon: VideoOff },
      { value: 'no-budget',    label: "Can't afford an agency ($3k–$5k/month)",                  Icon: DollarSign },
      { value: 'voice',        label: 'Struggle with consistent brand voice',                    Icon: MessageCircle },
      { value: 'scale',        label: 'Need to scale content 5–10×',                             Icon: TrendingUp },
      { value: 'all',          label: 'All of the above',                                        Icon: Layers },
    ],
    layout: 'list',
  },
  // 3. Features that interest them — multi-select.
  {
    id: 'features',
    type: 'multi',
    title: 'What features interest you most?',
    options: [
      { value: 'email',        label: 'Email Generation (sequences, newsletters, outreach)', Icon: Mail },
      { value: 'avatar',       label: 'AI Talking Videos (faceless, with cloned voice)',    Icon: UserCircle2 },
      { value: 'voice',        label: 'Voice Cloning + Custom AI Avatars',                  Icon: Mic },
      { value: 'images',       label: 'Branded Image Generation',                            Icon: ImageIcon },
      { value: 'agents',       label: 'AI Agent Team (Financial, Sales, Brand)',             Icon: Bot },
      { value: 'all',          label: 'All Features',                                        Icon: Sparkles },
    ],
    layout: 'list',
  },
  // 4. Monthly content/marketing spend — single-select.
  {
    id: 'monthlySpend',
    type: 'single',
    title: 'How much do you currently spend on content tools & marketing?',
    options: [
      { value: '0-50',         label: '$0–$50 / month (mostly free tools)' },
      { value: '50-150',       label: '$50–$150 / month' },
      { value: '150-300',      label: '$150–$300 / month' },
      { value: '300-500',      label: '$300–$500 / month' },
      { value: '500+',         label: '$500+ / month (ready to consolidate)' },
      { value: 'agencies',     label: 'Using agencies ($2k–$5k+ / month)' },
    ],
    layout: 'list',
  },
  // 5. Tools currently used — multi-select chips + Other.
  {
    id: 'currentTools',
    type: 'multi',
    title: 'Which tools are you currently using?',
    options: [
      { value: 'llm',          label: 'ChatGPT / Claude / Gemini' },
      { value: 'design',       label: 'Canva / Midjourney' },
      { value: 'video',        label: 'CapCut / Veed.io / Descript' },
      { value: 'voice',        label: 'ElevenLabs / HeyGen' },
      { value: 'none',         label: 'None yet' },
      { value: 'other',        label: 'Other' },
    ],
    layout: 'chips',
    otherKey: 'currentToolsOther',
  },
  // 6. How they heard — single-select chips + Other.
  {
    id: 'howHeard',
    type: 'single',
    title: 'How did you hear about ScaleSolo?',
    options: [
      { value: 'tiktok',       label: 'TikTok (@rayvaughn.ceo)' },
      { value: 'youtube',      label: 'YouTube' },
      { value: 'twitter',      label: 'Twitter / X' },
      { value: 'linkedin',     label: 'LinkedIn' },
      { value: 'instagram',    label: 'Instagram' },
      { value: 'google',       label: 'Google Search' },
      { value: 'friend',       label: 'Friend / Colleague' },
      { value: 'other',        label: 'Other' },
    ],
    layout: 'chips',
    otherKey: 'howHeardOther',
  },
]

// onSkip: when provided, renders a close (×) button in the top corner.
// We pass it from Dashboard when the user opened the survey via
// /dashboard?survey=true (i.e. they're not blocked by first-run logic
// and might just want to peek). When null, the survey is blocking.
export default function OnboardingSurvey({ token, onComplete, onSkip = null }) {
  const [stepIdx, setStepIdx] = useState(0)
  const [answers, setAnswers] = useState({ features: [], currentTools: [] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const step = STEPS[stepIdx]

  const setSingle = (id, value) => setAnswers((a) => ({ ...a, [id]: value }))
  const toggleMulti = (id, value) => setAnswers((a) => {
    const cur = Array.isArray(a[id]) ? a[id] : []
    return {
      ...a,
      [id]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value],
    }
  })
  const setOther = (key, value) => setAnswers((a) => ({ ...a, [key]: value }))

  const isOtherPicked = (() => {
    if (!step.otherKey) return false
    const val = answers[step.id]
    if (step.type === 'single') return val === 'other'
    return Array.isArray(val) && val.includes('other')
  })()

  const canProceed = (() => {
    const v = answers[step.id]
    const hasAnswer = step.type === 'multi' ? (Array.isArray(v) && v.length > 0) : !!v
    if (!hasAnswer) return false
    if (isOtherPicked) {
      const txt = (answers[step.otherKey] || '').trim()
      if (!txt) return false
    }
    return true
  })()

  const next = async () => {
    setError(null)
    if (stepIdx < STEPS.length - 1) {
      setStepIdx(stepIdx + 1)
      return
    }
    // Last step → submit.
    setBusy(true)
    try {
      const r = await fetch('/api/me/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(answers),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      onComplete?.(body)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const back = () => { if (stepIdx > 0) setStepIdx(stepIdx - 1) }

  // Lock body scroll while the survey is up.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const progressPct = ((stepIdx + 1) / STEPS.length) * 100

  return (
    <div style={overlay}>
      <div style={card}>
        {/* Progress bar */}
        <div style={progressTrack}>
          <div style={{ ...progressFill, width: `${progressPct}%` }} />
        </div>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 22px 12px' }}>
          <div style={brandIcon}><Zap size={16} strokeWidth={2.5} /></div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 14, color: 'var(--text)' }}>ScaleSolo</div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>
              Step {stepIdx + 1} of {STEPS.length}
            </div>
          </div>
          {onSkip && (
            <button
              type="button" onClick={onSkip}
              aria-label="Close survey"
              title="Close (you can re-open from /dashboard?survey=true anytime)"
              style={{
                background: 'transparent', border: 'none', color: 'var(--muted)',
                cursor: 'pointer', padding: 6, borderRadius: 6,
              }}
            ><X size={16} /></button>
          )}
        </div>

        {/* Title */}
        <div style={{ padding: '4px 22px 16px' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22, color: 'var(--text)', lineHeight: 1.25 }}>
            {step.title}
          </div>
        </div>

        {/* Body */}
        <div style={bodyScroll}>
          {step.layout === 'grid' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
              {step.options.map((o) => {
                const Icon = o.Icon
                const active = answers[step.id] === o.value
                return (
                  <button key={o.value} type="button" onClick={() => setSingle(step.id, o.value)} style={optionGrid(active)}>
                    {Icon && <Icon size={16} style={{ color: active ? 'var(--red)' : 'var(--muted)', marginBottom: 8 }} />}
                    <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>{o.label}</div>
                    {active && <Check size={13} style={{ position: 'absolute', top: 8, right: 8, color: 'var(--red)' }} />}
                  </button>
                )
              })}
            </div>
          )}
          {step.layout === 'list' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {step.options.map((o) => {
                const Icon = o.Icon
                const active = step.type === 'multi'
                  ? Array.isArray(answers[step.id]) && answers[step.id].includes(o.value)
                  : answers[step.id] === o.value
                return (
                  <button
                    key={o.value} type="button"
                    onClick={() => step.type === 'multi' ? toggleMulti(step.id, o.value) : setSingle(step.id, o.value)}
                    style={optionList(active)}
                  >
                    {Icon && <Icon size={15} style={{ color: active ? 'var(--red)' : 'var(--muted)', flexShrink: 0 }} />}
                    <div style={{ fontSize: 13.5, color: 'var(--text)', flex: 1, textAlign: 'left' }}>{o.label}</div>
                    {active && <Check size={14} style={{ color: 'var(--red)' }} />}
                  </button>
                )
              })}
            </div>
          )}
          {step.layout === 'chips' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {step.options.map((o) => {
                const active = step.type === 'multi'
                  ? Array.isArray(answers[step.id]) && answers[step.id].includes(o.value)
                  : answers[step.id] === o.value
                return (
                  <button
                    key={o.value} type="button"
                    onClick={() => step.type === 'multi' ? toggleMulti(step.id, o.value) : setSingle(step.id, o.value)}
                    style={chip(active)}
                  >
                    {active && <Check size={11} style={{ marginRight: 4 }} />}
                    {o.label}
                  </button>
                )
              })}
            </div>
          )}

          {/* Other text input — appears only when "Other" is the selected
              option (or one of the multi-select picks). */}
          {isOtherPicked && step.otherKey && (
            <input
              autoFocus
              className="input"
              placeholder="Please specify..."
              value={answers[step.otherKey] || ''}
              onChange={(e) => setOther(step.otherKey, e.target.value)}
              style={{ width: '100%', marginTop: 12 }}
            />
          )}
        </div>

        {/* Footer */}
        <div style={footer}>
          {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginBottom: 10 }}>{error}</div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {stepIdx > 0 ? (
              <button type="button" onClick={back} style={backBtn}>
                <ChevronLeft size={13} /> Back
              </button>
            ) : <div style={{ flex: '0 0 auto' }} />}
            <div style={{ flex: 1 }} />
            <button type="button" onClick={next} disabled={!canProceed || busy} style={nextBtn(canProceed && !busy)}>
              {busy ? <Loader2 size={14} className="spin" /> :
                stepIdx === STEPS.length - 1 ? <><Sparkles size={14} /> Get started</> :
                <>Next <ChevronRight size={13} /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const overlay = {
  position: 'fixed', inset: 0, zIndex: 250,
  background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
  display: 'grid', placeItems: 'center', padding: 20,
}
const card = {
  width: '100%', maxWidth: 620,
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 16, overflow: 'hidden',
  display: 'flex', flexDirection: 'column',
  maxHeight: 'calc(100vh - 40px)',
  boxShadow: '0 30px 80px rgba(0,0,0,0.5)',
}
const progressTrack = { height: 3, background: 'var(--surface-2)' }
const progressFill = {
  height: 3, background: 'linear-gradient(90deg, var(--red), var(--red-dark))',
  transition: 'width 0.25s ease',
}
const brandIcon = {
  width: 30, height: 30, borderRadius: 8,
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff', display: 'grid', placeItems: 'center',
}
const bodyScroll = {
  flex: 1, overflowY: 'auto',
  padding: '4px 22px 16px',
}
const footer = { padding: '16px 22px 20px', borderTop: '1px solid var(--border)', background: 'var(--surface)' }

const optionGrid = (active) => ({
  position: 'relative',
  padding: '14px 14px 12px',
  background: active ? 'rgba(239,68,68,0.10)' : 'var(--surface-2)',
  border: active ? '1px solid rgba(239,68,68,0.45)' : '1px solid var(--border)',
  borderRadius: 10, cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
  display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
  transition: 'all 0.12s ease',
})
const optionList = (active) => ({
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '12px 14px',
  background: active ? 'rgba(239,68,68,0.10)' : 'var(--surface-2)',
  border: active ? '1px solid rgba(239,68,68,0.45)' : '1px solid var(--border)',
  borderRadius: 10, cursor: 'pointer', width: '100%',
  fontFamily: 'inherit',
  transition: 'all 0.12s ease',
})
const chip = (active) => ({
  display: 'inline-flex', alignItems: 'center',
  padding: '7px 13px', borderRadius: 999,
  fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
  background: active ? 'rgba(239,68,68,0.16)' : 'var(--surface-2)',
  border: `1px solid ${active ? 'rgba(239,68,68,0.50)' : 'var(--border)'}`,
  color: active ? 'var(--text)' : 'var(--text-soft)',
  cursor: 'pointer',
})
const backBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '8px 12px', borderRadius: 8,
  background: 'transparent', border: '1px solid var(--border)',
  color: 'var(--text-soft)', fontSize: 12.5, fontWeight: 600,
  cursor: 'pointer', fontFamily: 'inherit',
}
const nextBtn = (enabled) => ({
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '9px 18px', borderRadius: 8, border: 'none',
  background: enabled
    ? 'linear-gradient(135deg, var(--red), var(--red-dark))'
    : 'var(--surface-2)',
  color: enabled ? '#fff' : 'var(--muted)',
  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13,
  cursor: enabled ? 'pointer' : 'not-allowed',
  boxShadow: enabled ? '0 4px 14px rgba(239,68,68,0.30)' : 'none',
  transition: 'all 0.15s ease',
})
