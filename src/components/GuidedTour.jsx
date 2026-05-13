import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { Sparkles, ArrowRight, Check, BookOpen, Boxes, UserCircle2, Calendar, Zap } from 'lucide-react'

// Five-stop guided tour for first-run users. Fires once after the
// onboarding survey completes. Renders as a fixed bottom-right card
// (no element highlighting — much simpler than the original target-
// rect plan and works regardless of layout changes). Stop 3 explicitly
// points users at the templates / pre-built workflows so they don't
// start from a blank canvas.
//
// Persistence: 'scalesolo.tour.done' in localStorage marks completion.
// The Dashboard auto-launches the tour only when this key is missing
// AND the user just finished onboarding. Manual re-trigger lives in
// the Settings page so users can replay it.

const STORAGE_KEY = 'scalesolo.tour.done'

const STOPS = [
  {
    id: 'dashboard',
    route: '/dashboard',
    Icon: Sparkles,
    title: 'Welcome to ScaleSolo',
    body: 'This is your brand home base. The dashboard summarizes pipeline, credits, and growth. Let me show you the four pages that turn your brand bible into a posting machine.',
    primary: 'Show me how →',
  },
  {
    id: 'avatars',
    route: '/avatars',
    Icon: UserCircle2,
    title: 'Step 1: Train your avatar',
    body: 'Upload one photo of yourself (or anyone — a stand-in influencer, a stock face, whoever). ScaleSolo builds a photorealistic AI avatar that can talk in your voice. You can train multiple looks per avatar so videos stay fresh.',
    primary: 'Next →',
  },
  {
    id: 'spaces',
    route: '/spaces',
    Icon: Boxes,
    title: 'Step 2: Build your workflow',
    body: 'Wire together Script → Avatar → Stitch → Finish → Schedule on the visual canvas. Each node is a step in the pipeline.',
    callout: 'Don\'t want to start from scratch? Click the templates icon at the top of the page — we ship pre-built workflows (Daily Podcast, Faceless Product Brand, Niche Education) you can fork and tweak in 30 seconds.',
    primary: 'Next →',
  },
  {
    id: 'schedule',
    route: '/schedule',
    Icon: Calendar,
    title: 'Step 3: Connect your platforms',
    body: 'Link TikTok, Instagram, YouTube, X, LinkedIn, Threads, Facebook. Once connected, your finished videos auto-post on the cadence you set. You can also bulk-upload existing videos and let ScaleSolo caption + schedule them.',
    primary: 'Next →',
  },
  {
    id: 'credits',
    route: '/billing',
    Icon: Zap,
    title: 'Step 4: Credits',
    body: 'You start with 5 trial video credits and 5,000 AI tokens. That\'s one watermarked 30-second video — enough to see the full pipeline end to end. Start your subscription anytime to unlock posting, longer videos, and more credits.',
    primary: 'Finish tour',
  },
]

export default function GuidedTour({ open, onClose }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [stepIdx, setStepIdx] = useState(0)
  const stop = STOPS[stepIdx]

  // Navigate to the right page each time the step changes. Skip if
  // we're already there (avoids resetting the user's scroll on a re-
  // navigate to the same path).
  useEffect(() => {
    if (!open || !stop) return
    if (location.pathname !== stop.route) {
      navigate(stop.route)
    }
  }, [open, stepIdx]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open || !stop || typeof document === 'undefined') return null

  const isLast = stepIdx === STOPS.length - 1
  const next = () => {
    if (isLast) {
      finish()
    } else {
      setStepIdx((i) => i + 1)
    }
  }
  const back = () => setStepIdx((i) => Math.max(0, i - 1))
  const finish = () => {
    try { localStorage.setItem(STORAGE_KEY, '1') } catch {}
    onClose?.()
    // Reset step so a re-trigger from Settings restarts from the top.
    setTimeout(() => setStepIdx(0), 300)
  }

  const Icon = stop.Icon
  return createPortal((
    <>
      {/* Soft backdrop. NOT clickable — the tour is required so the
          user has to actually advance via the button. Without this,
          clicking the backdrop 5 times would rush through every stop
          and defeat the point. Pointer events on the backdrop are
          captured so underlying page clicks also can't accidentally
          fire (e.g. clicking a sidebar link mid-tour). */}
      <div
        aria-hidden
        style={{
          position: 'fixed', inset: 0, zIndex: 220,
          background: 'rgba(0,0,0,0.18)',
          backdropFilter: 'blur(1.5px)', WebkitBackdropFilter: 'blur(1.5px)',
          pointerEvents: 'auto',
        }}
      />
      <div
        role="dialog" aria-modal="true" aria-labelledby="tour-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed', right: 24, bottom: 24, zIndex: 221,
          width: 'min(420px, calc(100vw - 32px))',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 16,
          padding: 22,
          boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
          color: 'var(--text)',
          animation: 'fadeUp 0.25s var(--ease) forwards',
        }}
      >
        {/* Step indicator + close */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 9,
            background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
            color: '#fff', display: 'grid', placeItems: 'center',
          }}><Icon size={16} strokeWidth={2.3} /></div>
          <div style={{ flex: 1 }}>
            <div style={{
              fontFamily: 'var(--font-display)', fontWeight: 700,
              fontSize: 10.5, letterSpacing: '0.10em', textTransform: 'uppercase',
              color: 'var(--muted)',
            }}>
              Quick tour · Step {stepIdx + 1} of {STOPS.length}
            </div>
          </div>
          {/* No skip / close button — the tour is required for
              first-run users so they understand the pipeline before
              they start clicking around. They can still replay it
              later from Settings. */}
        </div>

        <h2 id="tour-title" style={{
          fontFamily: 'var(--font-display)', fontWeight: 800,
          fontSize: 18, lineHeight: 1.25, margin: '0 0 8px',
          color: 'var(--text)',
        }}>{stop.title}</h2>

        <p style={{
          fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-soft)',
          margin: '0 0 12px',
        }}>{stop.body}</p>

        {/* Optional secondary callout — used by the Spaces step to
            point at the templates library. Visually distinct so the
            user notices it's a "by the way." */}
        {stop.callout && (
          <div style={{
            padding: '10px 12px', borderRadius: 8,
            background: 'rgba(14,165,233,0.10)',
            border: '1px solid rgba(14,165,233,0.30)',
            fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.5,
            marginBottom: 12,
            display: 'flex', gap: 8, alignItems: 'flex-start',
          }}>
            <BookOpen size={14} style={{ color: '#0ea5e9', flexShrink: 0, marginTop: 2 }} />
            <span>{stop.callout}</span>
          </div>
        )}

        {/* Progress dots */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          {STOPS.map((s, i) => (
            <div
              key={s.id}
              style={{
                flex: 1, height: 3, borderRadius: 999,
                background: i <= stepIdx ? 'var(--red)' : 'var(--surface-2)',
                transition: 'background 200ms ease',
              }}
            />
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {stepIdx > 0 && (
            <button
              type="button" onClick={back}
              style={{
                padding: '8px 14px', borderRadius: 8,
                background: 'transparent', border: '1px solid var(--border)',
                color: 'var(--text-soft)', cursor: 'pointer',
                fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12.5,
              }}
            >Back</button>
          )}
          <div style={{ flex: 1 }} />
          <button
            type="button" onClick={next}
            style={{
              padding: '9px 16px', borderRadius: 8, border: 'none',
              background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
              color: '#fff', cursor: 'pointer',
              fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13,
              display: 'inline-flex', alignItems: 'center', gap: 6,
              boxShadow: '0 4px 14px rgba(239,68,68,0.28)',
            }}
          >
            {isLast ? <Check size={13} /> : null}
            {stop.primary}
            {!isLast && <ArrowRight size={13} />}
          </button>
        </div>
      </div>
    </>
  ), document.body)
}

// Helper: has the user already finished or dismissed the tour?
export function isTourDone() {
  try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
}
// Helper: re-arm so the next Dashboard mount can fire the tour. Used
// by the Settings page's "Replay tour" action.
export function resetTour() {
  try { localStorage.removeItem(STORAGE_KEY) } catch {}
}
