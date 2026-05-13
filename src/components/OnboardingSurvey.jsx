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

import { useEffect, useRef, useState } from 'react'
import confetti from 'canvas-confetti'
import {
  Briefcase, Sparkles, ShoppingBag, Megaphone, Cpu, Wrench, MoreHorizontal,
  Clock, VideoOff, DollarSign, MessageCircle, TrendingUp, Layers,
  Mail, UserCircle2, Mic, Image as ImageIcon, Bot, Check,
  ChevronLeft, ChevronRight, Loader2, Zap, X, Upload, FileText, Copy, Building2,
} from 'lucide-react'

// Prompt the user can paste into ChatGPT / Claude to generate a brand
// bible from their existing assets (website, social, decks). Returned
// to them via a "copy" button so they don't have to invent the wheel.
const EXTRACTION_PROMPT = `You are a brand strategist. I will share content from my business (website, social posts, sales pages, pitch decks, etc.). Your job is to distill it into a "brand bible" the AI writers on my marketing team can use to write content in my voice.

Output as a single document with these sections (use markdown headings):

# Voice
- Tone (formal/casual/punchy/warm/etc.) and the specific energy I bring
- Sentence rhythm (short and punchy / long and flowing / mix)
- Perspective (first-person, second-person, etc.)
- 5-10 phrases or rhetorical moves I use repeatedly

# Audience
- Who I'm writing for (demographics + psychographics)
- The specific pain or desire that lights them up
- What they already believe; what they need to unlearn

# Offer
- What I sell, in plain English
- The transformation it produces
- Common objections and how I handle them

# Always include
- 5-10 phrases, hooks, or signature lines I use often

# Never say
- Words, claims, or framings that are off-brand for me

# Sample hooks
- 10 first-line hooks I'd actually open a piece with

Be concrete and quote me where helpful. I'll paste my source material below.

---

[Paste your website copy / social posts / sales page / about-me content here]`


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
  // 6. First brand profile — name + optional brand bible. Optional in
  // the sense that brand_bible can be empty (we'll still create the
  // profile), but business_name is required to advance.
  {
    id: 'brandSetup',
    type: 'brand_setup',
    title: "Let's set up your first brand profile",
    layout: 'brand_setup',
  },
  // 7. How they heard — single-select chips + Other.
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
  // Ref-to-latest-next so the auto-advance setTimeout can fire with
  // the current closure's `next` (which captures the latest stepIdx
  // and answers) without us re-running every effect on every render.
  const nextRef = useRef(null)

  const setSingle = (id, value) => setAnswers((a) => ({ ...a, [id]: value }))

  // Auto-advance: when the user picks a single-select option that ISN'T
  // "Other" (which needs the follow-up text input), wait a beat so the
  // selected state visibly registers, then jump to the next step. Skip
  // for multi-select and brand_setup (which has free-text fields).
  const pickAndMaybeAdvance = (id, value, opts) => {
    setSingle(id, value)
    if (opts?.autoAdvance && value !== 'other') {
      window.setTimeout(() => {
        // Use the ref-style advance — we can't read state directly here
        // since setSingle is async, but next() rechecks canProceed via
        // the latest state on its own call.
        nextRef.current?.()
      }, 220)
    }
  }
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
    if (step.type === 'brand_setup') {
      // business name is the only hard requirement; brand bible is optional.
      return !!(answers.brandBusinessName && answers.brandBusinessName.trim())
    }
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
    // Last step → submit. Two POSTs:
    //   1. /api/me/onboarding — survey answers + completion flag.
    //   2. /api/profiles      — create the first brand profile from the
    //      brand_setup step. Best-effort; if the user already has a
    //      profile the API will still accept the create (they can
    //      delete the dup later) but we skip the call when the user
    //      didn't fill the name field.
    setBusy(true)
    try {
      const r = await fetch('/api/me/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(answers),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)

      const businessName = (answers.brandBusinessName || '').trim()
      if (businessName) {
        try {
          await fetch('/api/profiles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              business_name: businessName,
              brand_bible: (answers.brandBible || '').slice(0, 12000),
            }),
          })
        } catch (e) {
          // Survey is the priority — we don't block onboarding completion
          // on the profile create succeeding. The user can finish setup
          // from /profiles if it failed.
          console.warn('First profile create failed:', e)
        }
      }

      // Celebrate. The animation is non-blocking; onComplete fires
      // immediately so the dashboard renders behind the confetti.
      try { fireConfetti() } catch {}
      onComplete?.(body)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const back = () => { if (stepIdx > 0) setStepIdx(stepIdx - 1) }

  // Keep nextRef pointing at the latest `next` so pickAndMaybeAdvance's
  // setTimeout calls the right closure.
  useEffect(() => { nextRef.current = next })

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
                  <button key={o.value} type="button" onClick={() => pickAndMaybeAdvance(step.id, o.value, { autoAdvance: true })} style={optionGrid(active)}>
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
                    onClick={() => step.type === 'multi' ? toggleMulti(step.id, o.value) : pickAndMaybeAdvance(step.id, o.value, { autoAdvance: true })}
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
          {step.layout === 'brand_setup' && (
            <BrandSetupStep
              token={token}
              answers={answers}
              setAnswers={setAnswers}
            />
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
                    onClick={() => step.type === 'multi' ? toggleMulti(step.id, o.value) : pickAndMaybeAdvance(step.id, o.value, { autoAdvance: true })}
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

// Fire a brand-red confetti burst from both bottom corners. Runs for
// ~1.5s. We render via canvas-confetti's defaults so we don't have to
// own a canvas node — the lib injects + cleans up its own.
function fireConfetti() {
  const colors = ['#ef4444', '#f97316', '#facc15', '#a855f7', '#3b82f6']
  const end = Date.now() + 1500
  const burst = (origin) => confetti({
    particleCount: 60, angle: origin.x < 0.5 ? 60 : 120,
    spread: 70, startVelocity: 55, origin,
    colors, scalar: 0.9, ticks: 200,
  })
  ;(function frame() {
    burst({ x: 0.05, y: 0.85 })
    burst({ x: 0.95, y: 0.85 })
    if (Date.now() < end) requestAnimationFrame(frame)
  })()
}

// Step 6 body — first brand profile setup. The user picks the path
// that fits where they are: type the bible directly, upload a doc, or
// copy our extraction prompt to run through ChatGPT/Claude and paste
// the result back. The brand_bible field is optional — we only require
// the business name to advance.
function BrandSetupStep({ token, answers, setAnswers }) {
  const [tab, setTab] = useState('type')  // 'type' | 'upload' | 'prompt'
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState(null)
  const [copied, setCopied] = useState(false)
  const fileRef = useRef(null)

  const setField = (k, v) => setAnswers((a) => ({ ...a, [k]: v }))

  const handleFile = async (file) => {
    if (!file) return
    setUploadMsg(null)
    setUploading(true)
    try {
      const buf = await file.arrayBuffer()
      // Encode in chunks so the browser doesn't choke on a 4MB call stack.
      const bytes = new Uint8Array(buf)
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
      }
      const b64 = btoa(bin)
      const r = await fetch('/api/onboarding/parse-doc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ filename: file.name, content_base64: b64 }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Parse failed')
      setField('brandBible', body.text || '')
      setUploadMsg({ ok: true, text: `Parsed ${file.name} — ${(body.text || '').length.toLocaleString()} characters extracted.` })
      setTab('type')  // jump to the editor so they can review/edit
    } catch (e) {
      setUploadMsg({ ok: false, text: e.message })
    } finally {
      setUploading(false)
    }
  }

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(EXTRACTION_PROMPT)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Fallback: select the textarea contents so the user can copy
      // manually.
      const ta = document.getElementById('extraction-prompt-fallback')
      if (ta) { ta.select(); document.execCommand('copy') }
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.55 }}>
        Your brand profile is what makes ScaleSolo's AI sound like <em>you</em>. Give it a name, and optionally feed it a brand bible — voice, audience, offer, signature phrases. The richer the bible, the more on-brand the output.
      </div>

      <label style={{ fontSize: 12.5, color: 'var(--text-soft)', fontWeight: 600 }}>
        Business name <span style={{ color: '#ef4444' }}>*</span>
        <div style={{ position: 'relative', marginTop: 4 }}>
          <Building2 size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input
            className="input"
            placeholder="e.g. Acme Coaching"
            value={answers.brandBusinessName || ''}
            onChange={(e) => setField('brandBusinessName', e.target.value)}
            style={{ width: '100%', paddingLeft: 32 }}
          />
        </div>
      </label>

      {/* Tab strip — three paths to a brand bible. */}
      <div style={{ display: 'flex', gap: 6, padding: 4, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10 }}>
        <TabBtn active={tab === 'type'}   onClick={() => setTab('type')}   icon={FileText}>Type / paste</TabBtn>
        <TabBtn active={tab === 'upload'} onClick={() => setTab('upload')} icon={Upload}>Upload doc</TabBtn>
        <TabBtn active={tab === 'prompt'} onClick={() => setTab('prompt')} icon={Sparkles}>Use extraction prompt</TabBtn>
      </div>

      {tab === 'type' && (
        <label style={{ fontSize: 12.5, color: 'var(--text-soft)', fontWeight: 600 }}>
          Brand bible <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional — paste anything you have on voice, audience, offer)</span>
          <textarea
            className="input"
            placeholder={`Voice: punchy, second-person, sentences under 12 words.\nAudience: 30-something coaches stuck under $5k/month.\nOffer: 1:1 sales coaching for solopreneurs.\nAlways include: "the missing piece" / "stop performing, start producing"\nNever say: "synergy", "circle back", "leverage"…`}
            value={answers.brandBible || ''}
            onChange={(e) => setField('brandBible', e.target.value)}
            rows={10}
            style={{ width: '100%', marginTop: 4, fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12.5 }}
          />
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            {(answers.brandBible || '').length.toLocaleString()} / 12,000 characters
          </div>
        </label>
      )}

      {tab === 'upload' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{
            border: '1.5px dashed var(--border)', borderRadius: 12,
            padding: 22, textAlign: 'center',
            background: 'var(--surface-2)',
          }}>
            <Upload size={20} style={{ color: 'var(--muted)', marginBottom: 8 }} />
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14 }}>
              Drop a brand doc — or pick a file
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Supports <strong>.docx</strong>, <strong>.md</strong>, <strong>.txt</strong> (max 4&nbsp;MB).<br />
              For PDFs, use the “Use extraction prompt” tab — it works better than parsing PDFs blindly.
            </div>
            <input
              ref={fileRef} type="file" accept=".docx,.md,.markdown,.txt"
              style={{ display: 'none' }}
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              style={{
                marginTop: 12, padding: '8px 16px',
                background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
                color: '#fff', border: 'none', borderRadius: 8,
                fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13,
                cursor: uploading ? 'not-allowed' : 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              {uploading ? <><Loader2 size={13} className="spin" /> Parsing…</> : <><Upload size={13} /> Choose file</>}
            </button>
          </div>
          {uploadMsg && (
            <div style={{
              padding: '8px 12px', borderRadius: 8, fontSize: 12.5,
              background: uploadMsg.ok ? 'rgba(46,204,113,0.10)' : 'var(--red-soft)',
              color: uploadMsg.ok ? '#2ecc71' : 'var(--red)',
              border: `1px solid ${uploadMsg.ok ? 'rgba(46,204,113,0.30)' : 'rgba(239,68,68,0.30)'}`,
            }}>
              {uploadMsg.text}
            </div>
          )}
        </div>
      )}

      {tab === 'prompt' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.55 }}>
            <strong>How this works:</strong>
            <ol style={{ margin: '6px 0 0 18px', padding: 0, lineHeight: 1.7 }}>
              <li>Click <em>Copy prompt</em> below.</li>
              <li>Paste it into ChatGPT, Claude, or any LLM you have access to.</li>
              <li>Below the prompt, paste your existing material (website copy, social posts, sales page, decks).</li>
              <li>Run it. Copy the generated brand bible. Come back and paste it in <em>Type / paste</em>.</li>
            </ol>
          </div>
          <button
            type="button" onClick={copyPrompt}
            style={{
              alignSelf: 'flex-start',
              padding: '8px 14px', borderRadius: 8,
              background: copied
                ? 'linear-gradient(135deg, #2ecc71, #1ea860)'
                : 'linear-gradient(135deg, var(--red), var(--red-dark))',
              color: '#fff', border: 'none',
              fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13,
              cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            {copied ? <><Check size={13} /> Copied!</> : <><Copy size={13} /> Copy prompt</>}
          </button>
          <textarea
            id="extraction-prompt-fallback"
            readOnly
            value={EXTRACTION_PROMPT}
            rows={8}
            style={{
              width: '100%', padding: 10, borderRadius: 8,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              color: 'var(--text-soft)', fontSize: 11.5,
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              resize: 'vertical',
            }}
          />
        </div>
      )}
    </div>
  )
}

function TabBtn({ active, onClick, icon: Icon, children }) {
  return (
    <button
      type="button" onClick={onClick}
      style={{
        flex: 1, padding: '8px 10px', borderRadius: 7,
        background: active ? 'var(--surface)' : 'transparent',
        border: active ? '1px solid var(--border)' : '1px solid transparent',
        color: active ? 'var(--text)' : 'var(--text-soft)',
        fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
        cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        transition: 'all 0.12s',
      }}
    >
      <Icon size={13} /> {children}
    </button>
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
