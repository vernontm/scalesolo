// PUBLIC, unauthenticated Brand Intake questionnaire at /intake/:token
//
// Ported from the standalone prototype (docs/prototypes/brand-intake.html)
// into the app's React conventions. A client opens the private link, answers
// 13 questions by voice (Web Speech API) or typing, and submits. Answers land
// in brand_intake_submissions (status pending) for the operator to review.
//
// Nothing here touches the brand profile. The only profile data shown is the
// business name + logo, fetched by token from the public /api/intake endpoint.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Zap, Mic, Volume2, CheckCircle2, ArrowUp, ArrowDown } from 'lucide-react'
import ThemeToggle from '../components/ThemeToggle.jsx'
import {
  INTAKE_QUESTIONS,
  emptyIntakeState,
  normalizeIntakeState,
  isAnswered,
  answeredCount,
  compileIntakeSummary,
  MAX_ANSWER_CHARS,
} from '../lib/brandIntake.js'

// Feature detection. Kept at module scope so it runs once. Accessed via
// window.* so eslint's no-undef rule stays happy (these globals are not in
// the shared browser globals list).
const SR = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null
const VOICE_SUPPORTED = !!SR
const synth = typeof window !== 'undefined' ? window.speechSynthesis : null
const TTS_SUPPORTED = !!synth

const page = { minHeight: '100vh', padding: '0 0 120px' }
const wrap = { width: '100%', maxWidth: 760, margin: '0 auto', padding: '0 18px' }

export default function Intake() {
  const { token } = useParams()
  const [loading, setLoading] = useState(true)
  const [brand, setBrand] = useState(null)
  const [loadError, setLoadError] = useState(null)

  const storageKey = `scalesolo_brand_intake_${token}`
  const [state, setState] = useState(emptyIntakeState)
  const [ttsOn, setTtsOn] = useState(false)
  const [activeMic, setActiveMic] = useState(null)   // question id currently recording
  const [micStatus, setMicStatus] = useState({})     // { [qid]: string }

  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [hp, setHp] = useState('')   // honeypot; humans never see or fill it

  const recRef = useRef(null)       // active SpeechRecognition instance
  const activeQidRef = useRef(null)

  // Load the brand display info by token.
  useEffect(() => {
    if (!token) { setLoading(false); setLoadError('Missing link.'); return }
    let cancelled = false
    fetch(`/api/intake?token=${encodeURIComponent(token)}`)
      .then((r) => r.json().then((body) => ({ status: r.status, ok: r.ok, body })))
      .then(({ status, ok, body }) => {
        if (cancelled) return
        if (!ok) {
          // Only a 404 carries a deliberate, human-written message. Any
          // other failure (e.g. a transient server error) must show a
          // generic line: this is a public page, so raw backend error text
          // never gets rendered to anonymous visitors.
          throw new Error(status === 404
            ? (body?.error || 'This intake link is not valid.')
            : 'Could not load this questionnaire right now. Please try again in a few minutes.')
        }
        setBrand(body.brand)
      })
      .catch((e) => { if (!cancelled) setLoadError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token])

  // Restore a saved draft for this token.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) setState(normalizeIntakeState(JSON.parse(raw)))
    } catch { /* ignore malformed draft */ }
  }, [storageKey])

  // Persist the draft as it changes.
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(state)) } catch { /* quota / private mode */ }
  }, [storageKey, state])

  // Stop any recognition + speech when leaving the page.
  useEffect(() => () => {
    try { recRef.current?.stop() } catch { /* noop */ }
    try { synth?.cancel() } catch { /* noop */ }
  }, [])

  const done = answeredCount(state)
  const total = INTAKE_QUESTIONS.length
  const pct = Math.round((done / total) * 100)

  const setAnswer = (qid, text) => setState((s) => ({ ...s, answers: { ...s.answers, [qid]: text } }))
  const toggleChip = (qid, value) => setState((s) => {
    const cur = s.chips[qid] || []
    const next = cur.includes(value) ? cur.filter((c) => c !== value) : [...cur, value]
    return { ...s, chips: { ...s.chips, [qid]: next } }
  })
  const moveRank = (qid, pos, dir, initial) => setState((s) => {
    const order = Array.isArray(s.rank[qid]) ? [...s.rank[qid]] : [...initial]
    const np = pos + dir
    if (np < 0 || np >= order.length) return s
    ;[order[pos], order[np]] = [order[np], order[pos]]
    return { ...s, rank: { ...s.rank, [qid]: order } }
  })

  // ── Text to speech ────────────────────────────────────────────────────
  const speak = (text) => {
    if (!TTS_SUPPORTED) return
    try {
      synth.cancel()
      const u = new window.SpeechSynthesisUtterance(text)
      u.rate = 1.0
      u.pitch = 1.0
      synth.speak(u)
    } catch { /* some browsers throw if not user-gesture-initiated */ }
  }
  const toggleTts = () => {
    setTtsOn((v) => {
      const next = !v
      if (!next) { try { synth?.cancel() } catch { /* noop */ } }
      return next
    })
  }

  // ── Voice input (Web Speech API) ──────────────────────────────────────
  const stopMic = () => {
    try { recRef.current?.stop() } catch { /* noop */ }
  }

  const startMic = (qid) => {
    if (!SR) return
    // If another question is recording, stop it first and clear its status
    // synchronously. The old recognition's async onend skips shared-state
    // cleanup (its recRef identity guard fails once we reassign below), so
    // without this the old question would show "Listening..." forever.
    if (recRef.current) {
      const oldQid = activeQidRef.current
      stopMic()
      if (oldQid && oldQid !== qid) {
        setMicStatus((m) => ({ ...m, [oldQid]: '' }))
      }
    }

    let rec
    try { rec = new SR() } catch {
      setMicStatus((m) => ({ ...m, [qid]: 'Could not start the microphone.' }))
      return
    }
    rec.lang = 'en-US'
    rec.continuous = true
    rec.interimResults = true

    // Append to existing text rather than overwrite it.
    const existing = (state.answers[qid] || '').replace(/\s+$/, '')
    const baseText = existing ? existing + ' ' : ''
    let committed = ''
    // Set by onerror so onend keeps the error message on screen instead of
    // wiping it a frame later (the browser fires 'error' then 'end').
    let errored = false

    rec.onresult = (ev) => {
      // The user took over by typing; stop rewriting from this closure.
      if (rec.__typed) return
      let interim = ''
      committed = ''
      for (let k = 0; k < ev.results.length; k++) {
        const r = ev.results[k]
        if (r.isFinal) committed += r[0].transcript + ' '
        else interim += r[0].transcript
      }
      setAnswer(qid, baseText + committed + interim)
      setMicStatus((m) => ({ ...m, [qid]: interim ? `Hearing: ${interim}` : 'Listening...' }))
    }
    rec.onerror = (ev) => {
      if (rec.__typed) return
      errored = true
      let msg
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        msg = 'Microphone permission was blocked. Allow mic access and try again.'
      } else if (ev.error === 'no-speech') {
        msg = 'Did not catch that. Tap the mic and try again.'
      } else {
        msg = `Voice stopped (${ev.error}). You can keep typing.`
      }
      setMicStatus((m) => ({ ...m, [qid]: msg }))
    }
    rec.onend = () => {
      // Commit whatever we captured, trim the interim tail. Skipped when
      // the user started typing mid-recording: their typed text owns the
      // answer and must not be clobbered by this closure's stale copy.
      if (!rec.__typed) setAnswer(qid, (baseText + committed).replace(/\s+$/, ''))
      // Only the recognition that is STILL current cleans up the shared
      // refs. Guarding on instance identity (not qid equality) means a
      // stale onend from a rapid mic-tap sequence (Q1, Q2, Q1 before the
      // first onend fires) can never null out a newer live recording's
      // refs and leave it orphaned.
      if (recRef.current === rec) {
        recRef.current = null
        activeQidRef.current = null
        setActiveMic(null)
        // Keep an error message visible so the user gets the recovery hint;
        // only clear the transient listening status.
        if (!errored) setMicStatus((m) => ({ ...m, [qid]: '' }))
      }
    }

    recRef.current = rec
    activeQidRef.current = qid
    setActiveMic(qid)
    setMicStatus((m) => ({ ...m, [qid]: 'Listening... tap the mic again to stop.' }))
    try { rec.start() } catch { /* start called too fast */ }
  }

  const toggleMic = (qid) => {
    if (activeMic === qid) { stopMic(); return }
    startMic(qid)
  }

  // Manual edits while that question is recording take over the answer:
  // flag the recognition so its onresult/onend callbacks stop rewriting the
  // textarea from their stale closure, abort it, and apply the typed value.
  const handleTyped = (qid, v) => {
    const rec = recRef.current
    if (rec && activeQidRef.current === qid) {
      rec.__typed = true
      try { rec.abort() } catch { /* noop */ }
    }
    setAnswer(qid, v)
  }

  // ── Submit ────────────────────────────────────────────────────────────
  const summaryPreview = useMemo(() => compileIntakeSummary(state), [state])

  // Turn a server rejection into one friendly line. 400s come from the
  // strict payload validator, whose raw messages (e.g. "answers.answers.
  // anything_else is too long") are developer-facing; 404/429 already carry
  // human-written copy that passes through unchanged.
  const friendlySubmitError = (status, raw) => {
    if (status === 400) {
      if (/too long|too large|oversized|too many/i.test(raw || '')) {
        return `One of your answers is too long to send. Each answer can be up to ${MAX_ANSWER_CHARS.toLocaleString()} characters; please shorten the longest one and try again. Your answers are saved on this device.`
      }
      return 'Something in your answers could not be accepted. Please refresh this page and try again; your answers are saved on this device.'
    }
    if (status === 404 || status === 429) return raw || 'Could not submit. Please try again.'
    // 5xx and anything unexpected: generic copy only; raw backend error
    // text never renders on this public page.
    return 'Could not submit right now. Please try again in a few minutes; your answers are saved on this device.'
  }

  const submit = async () => {
    if (submitting || submitted) return   // post-once: no double submit, no retry loop
    stopMic()
    setSubmitting(true)
    setSubmitError(null)
    try {
      // The summary shown above is a local preview only. The server compiles
      // and stores its own summary from the validated answers, so a client
      // cannot send a digest that differs from what it actually submitted.
      const r = await fetch('/api/intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, answers: state, hp }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(friendlySubmitError(r.status, body?.error))
      setSubmitted(true)
      try { localStorage.removeItem(storageKey) } catch { /* noop */ }
    } catch (e) {
      setSubmitError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  // ── Render states ─────────────────────────────────────────────────────
  if (loading) {
    return <div style={{ ...page, display: 'grid', placeItems: 'center' }}><span className="spinner" /></div>
  }

  if (loadError || !brand) {
    return (
      <div style={{ ...page, display: 'grid', placeItems: 'center', padding: 32 }}>
        <div style={{ maxWidth: 460, textAlign: 'center', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 32 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18, color: 'var(--text)', marginBottom: 8 }}>
            This intake link is not valid
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            {loadError || 'Double-check the link, or ask whoever sent it for a fresh one.'}
          </div>
        </div>
      </div>
    )
  }

  if (submitted) {
    return (
      <div style={{ ...page, display: 'grid', placeItems: 'center', padding: 32 }}>
        <div style={{ maxWidth: 480, textAlign: 'center', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 36 }} className="fade-up">
          <div style={{ width: 56, height: 56, borderRadius: 14, background: 'rgba(46,204,113,0.16)', color: '#2ecc71', display: 'grid', placeItems: 'center', margin: '0 auto 18px' }}>
            <CheckCircle2 size={28} />
          </div>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 20, marginBottom: 8 }}>
            Thank you
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.55 }}>
            Your brand intake for {brand.business_name || 'your brand'} is in. The ScaleSolo team will review it and build your content strategy from here. You can close this page.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={page} className="fade-up">
      {/* Sticky header: brand + progress + read-aloud toggle. */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 40,
        background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        padding: '12px 18px',
      }}>
        <div style={{ ...wrap, padding: 0, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {brand.logo_url
              ? <img src={brand.logo_url} alt="" style={{ width: 28, height: 28, borderRadius: 8, objectFit: 'cover' }} />
              : <div style={{ width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'linear-gradient(135deg, var(--red), var(--red-dark))', color: '#fff' }}><Zap size={15} strokeWidth={2.5} /></div>}
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>
              {brand.business_name || 'Brand'} intake
            </div>
          </div>
          <div style={{ flex: 1 }} />
          {TTS_SUPPORTED && (
            <button
              type="button"
              onClick={toggleTts}
              title="Read each question aloud when you tap the speaker"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                fontSize: 12.5, fontFamily: 'inherit', cursor: 'pointer',
                padding: '6px 10px', borderRadius: 999,
                border: `1px solid ${ttsOn ? 'var(--red)' : 'var(--border)'}`,
                background: ttsOn ? 'rgba(239,68,68,0.14)' : 'var(--surface-2)',
                color: ttsOn ? 'var(--red)' : 'var(--text-soft)',
              }}
            >
              <Volume2 size={13} /> Read questions aloud {ttsOn ? 'on' : 'off'}
            </button>
          )}
          <ThemeToggle />
        </div>
        <div style={{ ...wrap, padding: 0, marginTop: 10 }}>
          <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: pct === 100 ? '#2ecc71' : 'linear-gradient(90deg, var(--red), var(--red-dark))', transition: 'width 0.35s ease' }} />
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>{done} of {total} answered</div>
        </div>
      </header>

      <div style={wrap}>
        <div style={{ padding: '26px 4px 8px' }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 26, margin: '0 0 6px', letterSpacing: '-0.4px' }}>
            Tell us about your brand
          </h1>
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: 14.5, lineHeight: 1.55 }}>
            Answer by voice (tap the mic) or by typing. There are no wrong answers. This takes about 10 minutes and helps the ScaleSolo team build your content strategy. Your progress saves automatically on this device.
          </p>
          {!VOICE_SUPPORTED && (
            <div style={{
              marginTop: 14, padding: '10px 12px', borderRadius: 12, fontSize: 12.5, lineHeight: 1.5,
              background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.35)', color: 'var(--text-soft)',
            }}>
              Heads up: voice input needs Chrome or Edge (desktop or Android). It is not available in this browser (Firefox and iOS Safari do not support it yet), so please type your answers. Everything else works normally.
            </div>
          )}
        </div>

        {INTAKE_QUESTIONS.map((q, i) => (
          <QuestionCard
            key={q.id}
            index={i}
            q={q}
            state={state}
            answered={isAnswered(state, q)}
            recording={activeMic === q.id}
            status={micStatus[q.id]}
            onText={(v) => handleTyped(q.id, v)}
            onToggleChip={(c) => toggleChip(q.id, c)}
            onMoveRank={(pos, dir) => moveRank(q.id, pos, dir, q.rank || [])}
            onMic={() => toggleMic(q.id)}
            onSpeak={() => speak(`${q.title}. ${q.why}`)}
          />
        ))}

        {/* Review + submit. */}
        <section style={{ marginTop: 28, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: '20px 18px' }}>
          <h2 style={{ margin: '0 0 4px', fontFamily: 'var(--font-display)', fontSize: 20 }}>Review and send</h2>
          <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: '0 0 14px', lineHeight: 1.5 }}>
            Here is your intake compiled into a clean summary. When it looks right, send it to the ScaleSolo team.
          </p>
          <pre style={{
            background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 12,
            padding: '14px 16px', fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-soft)',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto', margin: 0,
          }}>{summaryPreview}</pre>

          {submitError && (
            <div style={{ marginTop: 14, padding: '10px 14px', background: 'var(--red-soft)', color: 'var(--red)', borderRadius: 10, fontSize: 13 }}>
              {submitError}
            </div>
          )}

          {/* Honeypot (mirrors the forms endpoint). Hidden from humans;
              a bot that auto-fills inputs trips it and the server drops
              the submission silently. */}
          <input
            type="text"
            name="hp"
            value={hp}
            onChange={(e) => setHp(e.target.value)}
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            style={{ position: 'absolute', left: -9999, top: 0, width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
          />

          <button
            type="button"
            className="btn-primary"
            onClick={submit}
            disabled={submitting || submitted || done === 0}
            style={{ marginTop: 16, width: '100%', justifyContent: 'center' }}
          >
            {submitting ? <span className="spinner" /> : null} Send my brand intake
          </button>
          <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--muted)', textAlign: 'center' }}>
            Powered by ScaleSolo. Your answers stay private until you send them.
          </div>
        </section>
      </div>
    </div>
  )
}

// Show the remaining-characters hint once an answer is within this many
// characters of the server-side per-answer cap.
const CHARS_LEFT_HINT_AT = 500

function QuestionCard({ index, q, state, answered, recording, status, onText, onToggleChip, onMoveRank, onMic, onSpeak }) {
  const chips = state.chips[q.id] || []
  const rankOrder = Array.isArray(state.rank[q.id]) ? state.rank[q.id] : (q.rank || [])
  const answerLen = (state.answers[q.id] || '').length
  const charsLeft = MAX_ANSWER_CHARS - answerLen

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: '18px 18px 16px', marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{
          flex: '0 0 auto', width: 28, height: 28, borderRadius: 9,
          background: answered ? 'rgba(46,204,113,0.16)' : 'var(--red-soft)',
          color: answered ? '#2ecc71' : 'var(--red)',
          fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>{index + 1}</div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 650, color: 'var(--text)' }}>{q.title}</div>
            {TTS_SUPPORTED && (
              <button type="button" onClick={onSpeak} title="Read this question aloud"
                style={{ flex: '0 0 auto', background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4 }}>
                <Volume2 size={15} />
              </button>
            )}
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '4px 0 10px', lineHeight: 1.5 }}>
            <strong style={{ color: 'var(--text-soft)' }}>Why we ask:</strong> {q.why}
          </p>

          {q.chips && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              {q.chips.map((c) => {
                const on = chips.includes(c)
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => onToggleChip(c)}
                    style={{
                      padding: '6px 12px', borderRadius: 999, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit',
                      border: `1px solid ${on ? 'var(--red)' : 'var(--border)'}`,
                      background: on ? 'rgba(239,68,68,0.14)' : 'var(--surface-2)',
                      color: on ? 'var(--red)' : 'var(--text-soft)',
                      fontWeight: on ? 600 : 400,
                    }}
                  >{c}</button>
                )
              })}
            </div>
          )}

          {q.rank && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
              {rankOrder.map((label, pos) => (
                <div key={label} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  border: `1px solid ${pos < 3 ? 'var(--red)' : 'var(--border)'}`,
                  background: pos < 3 ? 'rgba(239,68,68,0.10)' : 'var(--surface-2)',
                  borderRadius: 10, padding: '8px 10px',
                }}>
                  <span style={{
                    width: 22, height: 22, borderRadius: 6, flex: '0 0 auto',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-display)',
                    background: pos < 3 ? 'var(--red)' : 'var(--surface)',
                    color: pos < 3 ? '#fff' : 'var(--muted)',
                    border: '1px solid var(--border)',
                  }}>{pos + 1}</span>
                  <span style={{ flex: 1, fontSize: 13.5, color: 'var(--text)' }}>{label}</span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button type="button" onClick={() => onMoveRank(pos, -1)} title="Move up"
                      style={rankArrow}><ArrowUp size={13} /></button>
                    <button type="button" onClick={() => onMoveRank(pos, 1)} title="Move down"
                      style={rankArrow}><ArrowDown size={13} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{ position: 'relative' }}>
            <textarea
              className="textarea"
              value={state.answers[q.id] || ''}
              onChange={(e) => onText(e.target.value)}
              placeholder={q.placeholder}
              maxLength={MAX_ANSWER_CHARS}
              style={{
                width: '100%', minHeight: 84, resize: 'vertical',
                paddingRight: VOICE_SUPPORTED ? 46 : 12,
                borderColor: recording ? 'var(--red)' : undefined,
              }}
            />
            {VOICE_SUPPORTED && (
              <button
                type="button"
                onClick={onMic}
                title="Tap to speak. Tap again to stop."
                style={{
                  position: 'absolute', right: 8, top: 8,
                  width: 34, height: 34, borderRadius: 10, cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  border: `1px solid ${recording ? 'var(--red)' : 'var(--border)'}`,
                  background: recording ? 'var(--red)' : 'var(--surface)',
                  color: recording ? '#fff' : 'var(--muted)',
                }}
              ><Mic size={16} /></button>
            )}
          </div>

          {status && <div style={{ fontSize: 12, color: recording ? 'var(--red)' : 'var(--muted)', marginTop: 6, minHeight: 15 }}>{status}</div>}
          {charsLeft <= CHARS_LEFT_HINT_AT && (
            <div style={{ fontSize: 11.5, color: charsLeft <= 0 ? 'var(--red)' : 'var(--muted)', marginTop: 4 }}>
              {charsLeft < 0
                // Typing is capped by maxLength, but voice dictation appends
                // programmatically and can overshoot; ask for a trim so the
                // server does not bounce the whole submission.
                ? `This answer is ${Math.abs(charsLeft).toLocaleString()} characters over the ${MAX_ANSWER_CHARS.toLocaleString()}-character limit. Please trim it before sending.`
                : charsLeft === 0
                  ? 'This answer is at the maximum length. Please trim it before sending.'
                  : `${charsLeft.toLocaleString()} characters left for this answer.`}
            </div>
          )}
          {q.followup && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>Follow-up: {q.followup}</div>}
        </div>
      </div>
    </div>
  )
}

const rankArrow = {
  width: 26, height: 26, borderRadius: 6, cursor: 'pointer',
  border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--muted)',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
}
