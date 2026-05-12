import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Plus, Building2, Edit3, Trash2, X, Save, Sparkles, Check, Crown,
  Upload, ClipboardCopy, MessageSquare, Wand2, Loader2, ChevronRight,
  CircleDashed, CheckCircle2, Mic, Calendar, Share2, Palette, ChevronDown,
  Music, Play, Pause,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'
import { supabase } from '../lib/supabase.js'
import VoiceTrainingSection from '../components/VoiceTrainingSection.jsx'
import VoiceSummaryCard from '../components/VoiceSummaryCard.jsx'

const grid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
  gap: 14,
  marginTop: 14,
}
const cardStyle = (active) => ({
  background: 'var(--surface)',
  border: active ? '1px solid rgba(239,68,68,0.45)' : '1px solid var(--border)',
  borderRadius: 14,
  padding: 18,
  cursor: 'pointer',
  position: 'relative',
  transition: 'transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
  boxShadow: active ? '0 12px 28px rgba(239,68,68,0.18)' : 'none',
})
const tagPill = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  background: 'var(--red-soft)', color: 'var(--red)',
  fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 600,
  padding: '3px 8px', borderRadius: 999,
}
const initialsStyle = (color) => ({
  width: 44, height: 44, borderRadius: 12,
  display: 'grid', placeItems: 'center',
  background: color || 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 16,
  boxShadow: '0 6px 14px rgba(0,0,0,0.20)',
})

const FORM_DEFAULTS = {
  business_name: '',
  industry: '',
  business_type: '',
  website_url: '',
  brand_bible: '',
  brand_cta: '',
  do_not_say: [],
  always_include: [],
  brand_primary_color: '#ef4444',
  brand_secondary_color: '',
  preferred_tone: '',
  target_audience: '',
  core_hashtags: '',
  timezone: '',
  synced_platforms: [],
  posting_schedule: { days: [1, 2, 3, 4, 5], times: ['09:00', '14:00'] },
  instagram_handle: '',
  tiktok_handle: '',
  youtube_handle: '',
  linkedin_handle: '',
  threads_handle: '',
  x_handle: '',
}

function initialsOf(name) {
  return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('') || '?'
}

// ────────────────────────────────────────────────────────────────────────────
// Section schema. Each section reports completion via a fn that takes the
// current form. The sidebar uses these to show "X of Y" + a green check
// when fully filled. Order = display order in the rail.
// ────────────────────────────────────────────────────────────────────────────
const SECTIONS = [
  {
    id: 'identity',
    label: 'Identity',
    icon: Building2,
    description: "The basics. Name, what you do, where you live online.",
    isComplete: (f) => !!(f.business_name && f.industry && f.website_url),
    completionFields: ['business_name', 'industry', 'website_url'],
  },
  {
    id: 'brand',
    label: 'Brand',
    icon: Palette,
    description: 'Colors, logo. How posts look when ScaleSolo composes them.',
    isComplete: (f) => !!(f.brand_primary_color && f.logo_url),
    completionFields: ['brand_primary_color', 'logo_url'],
  },
  {
    id: 'voice',
    label: 'Voice',
    icon: Mic,
    description: 'How posts sound. The bible feeds every script and caption.',
    isComplete: (f) => !!(f.preferred_tone && f.target_audience && (f.brand_bible || '').length > 200),
    completionFields: ['preferred_tone', 'target_audience', 'brand_bible'],
  },
  {
    id: 'training',
    label: 'Voice training',
    icon: Sparkles,
    description: 'Reference scripts, hooks, and rules. The AI learns from this.',
    isComplete: () => true,                  // optional power-user section
    requiresSavedProfile: true,
  },
  {
    id: 'schedule',
    label: 'Schedule',
    icon: Calendar,
    description: "When auto-runs are allowed to publish. Skip if you don't auto-post.",
    isComplete: (f) => !!(f.timezone && Array.isArray(f.posting_schedule?.times) && f.posting_schedule.times.length > 0),
  },
  {
    id: 'handles',
    label: 'Social handles',
    icon: Share2,
    description: "Where you post. Used for @mentions, hashtags, and links.",
    isComplete: (f) => !!(f.instagram_handle || f.tiktok_handle || f.youtube_handle || f.linkedin_handle || f.threads_handle || f.x_handle),
  },
  {
    id: 'music',
    label: 'Music library',
    icon: Music,
    description: 'Background tracks for finished videos. Shared across every brand profile on your account.',
    isComplete: () => true, // user-level; no per-brand completion gate
  },
]

function ProfileEditor({ profile, onClose, onSaved }) {
  const { session } = useAuth()
  const isNew = !profile?.id
  const [form, setForm] = useState({ ...FORM_DEFAULTS, ...(profile || {}) })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [helper, setHelper] = useState(null)  // 'paste' | 'prompt' | 'interview' | null
  const [activeSection, setActiveSection] = useState('identity')

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  const mergeFields = (fields) => {
    if (!fields || typeof fields !== 'object') return
    setForm((f) => {
      const next = { ...f }
      for (const [k, v] of Object.entries(fields)) {
        if (v == null) continue
        if (typeof v === 'string' && !v.trim()) continue
        if (Array.isArray(v) && !v.length) continue
        next[k] = v
      }
      return next
    })
    setHelper(null)
  }

  // Overall completion across required-ish sections (excludes optional
  // training section). Used for the title-bar progress bar.
  const completion = useMemo(() => {
    const required = SECTIONS.filter((s) => s.id !== 'training')
    const done = required.filter((s) => s.isComplete(form)).length
    return { done, total: required.length, pct: Math.round((done / required.length) * 100) }
  }, [form])

  const save = async () => {
    if (!form.business_name?.trim()) {
      setError('Business name is required.')
      setActiveSection('identity')
      return
    }
    setBusy(true); setError(null)
    try {
      const STRIP = new Set([
        '_role', '_allowed_pages', 'role', 'allowed_pages',
        'created_at', 'updated_at',
      ])
      const clean = Object.fromEntries(Object.entries(form).filter(([k]) => !STRIP.has(k)))
      const r = await fetch('/api/profiles', {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify(isNew ? clean : { id: profile.id, ...clean }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Save failed')
      onSaved(body.profile)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const sectionsForRender = SECTIONS.filter((s) => !s.requiresSavedProfile || profile?.id)
  const activeMeta = sectionsForRender.find((s) => s.id === activeSection) || sectionsForRender[0]

  return createPortal((
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card modal-card-xl"
        onClick={(e) => e.stopPropagation()}
        style={{
          padding: 0,
          width: 'min(1080px, calc(100vw - 32px))',
          height: 'min(820px, calc(100vh - 32px))',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Title bar with brand preview + progress bar. */}
        <EditorTitleBar
          form={form}
          isNew={isNew}
          completion={completion}
          onClose={onClose}
        />

        {/* Two-column layout: rail + content. The rail collapses to a
            scrollable horizontal tab bar under 720px. */}
        <div className="profile-editor-body" style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <SectionRail
            sections={sectionsForRender}
            active={activeSection}
            form={form}
            onChange={setActiveSection}
          />

          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{
              flex: 1, overflowY: 'auto',
              padding: '24px 28px 8px',
            }}>
              <SectionHeader meta={activeMeta} setHelper={setHelper} />

              {activeSection === 'identity' && (
                <IdentitySection form={form} set={set} />
              )}
              {activeSection === 'brand' && (
                <BrandSection form={form} set={set} profile={profile} />
              )}
              {activeSection === 'voice' && (
                <VoiceSection form={form} set={set} setHelper={setHelper} />
              )}
              {activeSection === 'training' && profile?.id && (
                <TrainingSection
                  profile={profile}
                  session={session}
                  form={form}
                  set={set}
                />
              )}
              {activeSection === 'schedule' && (
                <PostingScheduleEditor
                  timezone={form.timezone}
                  onTimezoneChange={(tz) => set('timezone', tz)}
                  synced={Array.isArray(form.synced_platforms) ? form.synced_platforms : []}
                  onSyncedChange={(arr) => set('synced_platforms', arr)}
                  schedule={form.posting_schedule || { days: [1,2,3,4,5], times: ['09:00','14:00'] }}
                  onScheduleChange={(s) => set('posting_schedule', s)}
                />
              )}
              {activeSection === 'handles' && (
                <HandlesSection form={form} set={set} />
              )}
              {activeSection === 'music' && (
                <MusicLibrarySection
                  userId={session?.user?.id}
                  token={session.access_token}
                />
              )}
            </div>

            {/* Sticky footer keeps Save in view as the user scrolls. */}
            <div style={editorFooter}>
              {error && (
                <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, flex: 1, marginRight: 12 }}>
                  {error}
                </div>
              )}
              <div style={{ flex: error ? 0 : 1, fontSize: 11.5, color: 'var(--muted)' }}>
                {!error && (isNew
                  ? 'Required: business name. Everything else can be filled in over time.'
                  : <>Last saved {profile?.updated_at ? new Date(profile.updated_at).toLocaleDateString() : '—'}</>
                )}
              </div>
              <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn-primary" onClick={save} disabled={busy}>
                {busy ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
                {isNew ? 'Create profile' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {helper === 'paste' && (
        <BiblePasteModal
          token={session.access_token}
          profileId={profile?.id}
          onClose={() => setHelper(null)}
          onApply={mergeFields}
        />
      )}
      {helper === 'prompt' && (
        <PromptHelperModal
          onClose={() => setHelper(null)}
          onApply={mergeFields}
        />
      )}
      {helper === 'interview' && (
        <InterviewModal
          onClose={() => setHelper(null)}
          onApply={mergeFields}
        />
      )}
    </div>
  ), document.body)
}

// ────────────────────────────────────────────────────────────────────────────
// Title bar — brand chip preview + progress bar + close.
// ────────────────────────────────────────────────────────────────────────────
function EditorTitleBar({ form, isNew, completion, onClose }) {
  const gradient = form.brand_primary_color
    ? `linear-gradient(135deg, ${form.brand_primary_color}, ${form.brand_secondary_color || form.brand_primary_color})`
    : null
  return (
    <div style={{
      padding: '18px 24px 14px',
      borderBottom: '1px solid var(--border)',
      background: 'linear-gradient(180deg, var(--surface-2), var(--surface))',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={initialsStyle(gradient)}>
          {form.logo_url
            ? <img src={form.logo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 12 }} />
            : initialsOf(form.business_name || (isNew ? '+' : '?'))
          }
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18,
            color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {form.business_name || (isNew ? 'Create a brand profile' : 'Untitled brand')}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
            <div style={{ flex: 1, maxWidth: 280, height: 5, background: 'var(--surface-2)', borderRadius: 999, overflow: 'hidden' }}>
              <div style={{
                width: `${completion.pct}%`, height: '100%',
                background: completion.pct === 100 ? '#2ecc71' : 'linear-gradient(90deg, var(--red), var(--red-dark))',
                transition: 'width 0.25s var(--ease)',
              }} />
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', fontFamily: 'var(--font-display)', fontWeight: 700 }}>
              {completion.done} of {completion.total} sections complete
            </div>
          </div>
        </div>
        <button aria-label="Close" onClick={onClose}
          style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 8, borderRadius: 8 }}>
          <X size={18} />
        </button>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Section rail — vertical at ≥720px, horizontal scroll-tabs below.
// ────────────────────────────────────────────────────────────────────────────
function SectionRail({ sections, active, form, onChange }) {
  return (
    <nav className="profile-editor-rail" style={railStyle}>
      {sections.map((s) => {
        const Icon = s.icon
        const isActive = s.id === active
        const done = s.isComplete(form)
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onChange(s.id)}
            style={railItem(isActive)}
          >
            <div style={{ display: 'grid', placeItems: 'center', width: 28, height: 28, borderRadius: 8, background: isActive ? 'rgba(239,68,68,0.16)' : 'transparent', color: isActive ? 'var(--red)' : 'var(--muted)', flexShrink: 0 }}>
              <Icon size={15} strokeWidth={2.2} />
            </div>
            <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13.5, color: isActive ? 'var(--text)' : 'var(--text-soft)' }}>
                {s.label}
              </div>
            </div>
            {done
              ? <CheckCircle2 size={14} style={{ color: '#2ecc71', flexShrink: 0 }} />
              : <CircleDashed size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
          </button>
        )
      })}
    </nav>
  )
}

// Section header inside the right pane: name, description, optional
// import-shortcuts dropdown (only on the Voice section).
function SectionHeader({ meta, setHelper }) {
  if (!meta) return null
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 20, color: 'var(--text)', letterSpacing: '-0.01em' }}>
          {meta.label}
        </div>
        <div style={{ flex: 1 }} />
        {meta.id === 'voice' && <ImportShortcuts setHelper={setHelper} />}
      </div>
      {meta.description && (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
          {meta.description}
        </div>
      )}
    </div>
  )
}

// Lightweight dropdown that lives in the Voice section header. Hides
// the bible-import shortcuts away from users who don't need them while
// keeping them one click away.
function ImportShortcuts({ setHelper }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  const pick = (kind) => { setOpen(false); setHelper(kind) }
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen((v) => !v)} style={importBtn}>
        <Wand2 size={13} /> Import bible <ChevronDown size={12} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
      </button>
      {open && (
        <div style={importMenu}>
          <button type="button" onClick={() => pick('paste')} style={importItem}>
            <Upload size={13} />
            <div>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13 }}>Paste your bible</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>Drop in a doc, AI extracts every field.</div>
            </div>
          </button>
          <button type="button" onClick={() => pick('prompt')} style={importItem}>
            <ClipboardCopy size={13} />
            <div>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13 }}>Get extraction prompt</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>Run it elsewhere, paste the JSON back.</div>
            </div>
          </button>
          <button type="button" onClick={() => pick('interview')} style={importItem}>
            <MessageSquare size={13} />
            <div>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13 }}>Brand interview</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>8 short questions. We build it for you.</div>
            </div>
          </button>
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Per-section bodies. Each takes form + setter and renders only its own
// fields. Keeps the parent ProfileEditor declarative.
// ────────────────────────────────────────────────────────────────────────────
function IdentitySection({ form, set }) {
  return (
    <div style={twoColGrid}>
      <Field label="Business name" required>
        <input className="input" value={form.business_name} onChange={(e) => set('business_name', e.target.value)} placeholder="ScaleSolo" autoFocus />
      </Field>
      <Field label="Website">
        <input className="input" value={form.website_url || ''} onChange={(e) => set('website_url', e.target.value)} placeholder="https://yourbrand.com" />
      </Field>
      <Field label="Industry">
        <input className="input" value={form.industry || ''} onChange={(e) => set('industry', e.target.value)} placeholder="Coaching, e-commerce, agency…" />
      </Field>
      <Field label="Business type">
        <select className="select" value={form.business_type || ''} onChange={(e) => set('business_type', e.target.value)}>
          <option value="">Choose…</option>
          <option value="creator">Creator</option>
          <option value="coach">Coach</option>
          <option value="consultant">Consultant</option>
          <option value="ecommerce">E-commerce</option>
          <option value="freelancer">Freelancer</option>
          <option value="other">Other</option>
        </select>
      </Field>
    </div>
  )
}

function BrandSection({ form, set, profile }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <Field label="Brand logo">
        <LogoUpload
          value={form.logo_url || ''}
          profileId={profile?.id}
          onChange={(url) => set('logo_url', url)}
        />
      </Field>
      <div style={twoColGrid}>
        <Field label="Primary color">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="color" value={form.brand_primary_color || '#ef4444'} onChange={(e) => set('brand_primary_color', e.target.value)} style={swatchStyle} />
            <input className="input" value={form.brand_primary_color || ''} onChange={(e) => set('brand_primary_color', e.target.value)} placeholder="#ef4444" />
          </div>
        </Field>
        <Field label="Secondary color">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="color" value={form.brand_secondary_color || '#b91c1c'} onChange={(e) => set('brand_secondary_color', e.target.value)} style={swatchStyle} />
            <input className="input" value={form.brand_secondary_color || ''} onChange={(e) => set('brand_secondary_color', e.target.value)} placeholder="#b91c1c" />
          </div>
        </Field>
      </div>
    </div>
  )
}

function VoiceSection({ form, set, setHelper }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={twoColGrid}>
        <Field label="Tone">
          <input className="input" value={form.preferred_tone || ''} onChange={(e) => set('preferred_tone', e.target.value)} placeholder="Direct, candid, action-oriented" />
        </Field>
        <Field label="Target audience">
          <input className="input" value={form.target_audience || ''} onChange={(e) => set('target_audience', e.target.value)} placeholder="Solopreneurs scaling past $10k/mo" />
        </Field>
      </div>

      <Field label={
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between', width: '100%' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Brand bible
            <span className="pill pill-muted" style={{ marginLeft: 6 }}><Sparkles size={10} /> Embedded into every script</span>
          </span>
          <label style={{ fontSize: 11.5, padding: '4px 10px', cursor: 'pointer', borderRadius: 6, border: '1px solid var(--border)', color: 'var(--text-soft)' }} title="Upload a .txt or .md file">
            <Upload size={11} style={{ marginRight: 4, verticalAlign: '-1px' }} /> Upload .txt/.md
            <input
              type="file"
              accept=".txt,.md,text/plain,text/markdown"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (!file) return
                if (file.size > 1_000_000) {
                  alert('File too large. Max 1MB. For PDFs/DOCX, use the Import bible button above.')
                  e.target.value = ''
                  return
                }
                try {
                  const text = await file.text()
                  const existing = form.brand_bible || ''
                  const next = existing.trim() ? `${existing}\n\n${text}` : text
                  set('brand_bible', next)
                } catch (err) {
                  alert('Could not read file: ' + (err?.message || err))
                } finally {
                  e.target.value = ''
                }
              }}
            />
          </label>
        </span>
      }>
        <textarea
          className="textarea"
          style={{ minHeight: 220, width: '100%' }}
          value={form.brand_bible || ''}
          onChange={(e) => set('brand_bible', e.target.value)}
          placeholder={`Voice: direct, candid, never preachy.\nAudience: solopreneurs scaling past $10k/mo.\nOffer: AI-native operating system.\nDo-not-say: "synergy", "leverage" as a verb.\nSignature phrases: "ship it", "10x the brand".`}
        />
        <div style={{ marginTop: 4, fontSize: 11.5, color: 'var(--muted)' }}>
          {(form.brand_bible || '').length.toLocaleString()} chars · 200+ recommended
        </div>
      </Field>

      <Field label={
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Default call-to-action
          <span className="pill pill-muted" style={{ marginLeft: 6 }}>Auto-fills first comment</span>
        </span>
      }>
        <textarea
          className="textarea"
          style={{ minHeight: 60, width: '100%' }}
          value={form.brand_cta || ''}
          onChange={(e) => set('brand_cta', e.target.value)}
          placeholder="e.g. Free workflow library → scalesolo.ai/free"
        />
      </Field>
    </div>
  )
}

function TrainingSection({ profile, session, form, set }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <VoiceTrainingSection
        profileId={profile.id}
        session={session}
        doNotSay={Array.isArray(form.do_not_say) ? form.do_not_say : []}
        alwaysInclude={Array.isArray(form.always_include) ? form.always_include : []}
        onRulesChange={(key, arr) => set(key, arr)}
      />
      <VoiceSummaryCard profileId={profile.id} session={session} />
    </div>
  )
}

// ─── Music library — USER-scoped catalog of background tracks ────────────
// Shared across every brand profile on the account. Upload mp3 / m4a /
// wav files; each gets a name + a public URL. The Finish video node
// pulls this list (via /api/account/music-tracks) and lets the user
// pick a specific track or randomize across the library.
function MusicLibrarySection({ userId, token }) {
  const [tracks, setTracks] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [playingId, setPlayingId] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [draftName, setDraftName] = useState('')
  const fileRef = useRef(null)
  const audioRef = useRef(null)

  // Refresh from server on mount so we get any tracks added from
  // another tab / device / brand profile since the editor opened.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    fetch(`/api/account/music-tracks`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((b) => {
        if (cancelled) return
        if (Array.isArray(b?.tracks)) setTracks(b.tracks)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token])

  const onUpload = async (files) => {
    const list = Array.from(files || [])
    if (!list.length) return
    setBusy(true); setError(null)
    const added = []
    for (const f of list) {
      try {
        // Upload to landing-media/account/<user_id>/music/<filename> so
        // the file stays accessible across every brand the user owns.
        // Falls back to a "shared" path when userId isn't known yet
        // (rare — only on the first render after sign-in).
        const ext = (f.name.split('.').pop() || 'mp3').toLowerCase()
        const folder = userId ? `account/${userId}` : 'account/shared'
        const path = `${folder}/music/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`
        const { error: upErr } = await supabase.storage.from('landing-media').upload(path, f, {
          contentType: f.type || 'audio/mpeg', upsert: false,
        })
        if (upErr) throw new Error(upErr.message)
        const { data: pub } = supabase.storage.from('landing-media').getPublicUrl(path)
        const r = await fetch(`/api/account/music-tracks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            url: pub.publicUrl,
            name: f.name.replace(/\.[^.]+$/, '').slice(0, 80),
          }),
        })
        const body = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(body?.error || `Add track failed (${r.status})`)
        if (body?.track) added.push(body.track)
      } catch (e) {
        setError(e.message)
      }
    }
    setTracks((cur) => [...cur, ...added])
    setBusy(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  const removeTrack = async (id) => {
    if (!window.confirm('Remove this track from your account-wide music library? Polished videos already using it keep their URL.')) return
    const r = await fetch(`/api/account/music-tracks?id=${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok) {
      const b = await r.json().catch(() => ({}))
      setError(b?.error || 'Remove failed')
      return
    }
    setTracks((cur) => cur.filter((t) => t.id !== id))
  }

  const renameTrack = async (id) => {
    const name = (draftName || '').trim()
    setEditingId(null)
    setDraftName('')
    if (!name) return
    const r = await fetch(`/api/account/music-tracks`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id, name }),
    })
    if (!r.ok) { setError('Rename failed'); return }
    setTracks((cur) => cur.map((t) => t.id === id ? { ...t, name } : t))
  }

  const togglePlay = (track) => {
    const el = audioRef.current
    if (!el) return
    if (playingId === track.id && !el.paused) {
      el.pause()
      setPlayingId(null)
    } else {
      el.src = track.url
      el.play().catch(() => {})
      setPlayingId(track.id)
    }
  }
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    const onEnded = () => setPlayingId(null)
    el.addEventListener('ended', onEnded)
    return () => el.removeEventListener('ended', onEnded)
  }, [])

  return (
    <div>
      <div style={{
        marginBottom: 14, padding: '10px 14px',
        background: 'rgba(14,165,233,0.10)',
        border: '1px solid rgba(14,165,233,0.30)',
        borderRadius: 10, fontSize: 12.5, color: 'var(--text-soft)',
        display: 'flex', alignItems: 'flex-start', gap: 8,
      }}>
        <Music size={14} style={{ color: '#0ea5e9', marginTop: 2, flexShrink: 0 }} />
        <div>
          <strong style={{ color: '#0ea5e9', fontFamily: 'var(--font-display)' }}>Account-wide library.</strong>{' '}
          Every brand profile on your account picks from the same set of tracks. Add one here once and it'll show up in the Finish video node for all your brands.
        </div>
      </div>
      <div style={{ marginBottom: 14 }}>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="btn-primary"
          style={{ padding: '8px 14px', fontSize: 13 }}
        >
          {busy ? <Loader2 size={13} className="spin" /> : <Upload size={13} />} Upload tracks
        </button>
        <input
          ref={fileRef} type="file" multiple
          accept="audio/mpeg,audio/mp3,audio/wav,audio/x-m4a,audio/mp4,.mp3,.wav,.m4a"
          hidden onChange={(e) => onUpload(e.target.files)}
        />
        <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--muted)' }}>
          MP3, WAV, M4A. Max 100 tracks per account.
        </span>
      </div>
      {error && (
        <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>
          {error}
        </div>
      )}
      {tracks.length === 0 ? (
        <div style={{ padding: 28, textAlign: 'center', color: 'var(--muted)', fontSize: 13, background: 'var(--surface-2)', borderRadius: 10, border: '1px dashed var(--border)' }}>
          <Music size={22} style={{ marginBottom: 8, opacity: 0.5 }} />
          <div>No music yet. Upload tracks here and they appear in the Finish video node's music dropdown across every brand profile on your account.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {tracks.map((t) => (
            <div key={t.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 12px', borderRadius: 8,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
            }}>
              <button
                type="button"
                onClick={() => togglePlay(t)}
                title={playingId === t.id ? 'Pause' : 'Preview'}
                style={{
                  width: 30, height: 30, borderRadius: 999,
                  background: playingId === t.id ? 'var(--red)' : 'var(--surface)',
                  color: playingId === t.id ? '#fff' : 'var(--text)',
                  border: '1px solid var(--border)', cursor: 'pointer',
                  display: 'grid', placeItems: 'center', flexShrink: 0,
                }}
              >
                {playingId === t.id ? <Pause size={13} /> : <Play size={13} />}
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                {editingId === t.id ? (
                  <input
                    autoFocus
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onBlur={() => renameTrack(t.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') renameTrack(t.id); if (e.key === 'Escape') { setEditingId(null); setDraftName('') } }}
                    className="input"
                    style={{ padding: '4px 8px', fontSize: 13 }}
                  />
                ) : (
                  <div
                    onDoubleClick={() => { setEditingId(t.id); setDraftName(t.name) }}
                    title="Double-click to rename"
                    style={{ fontSize: 13, fontWeight: 600 }}
                  >{t.name}</div>
                )}
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                  Added {t.added_at ? new Date(t.added_at).toLocaleDateString() : '—'}
                </div>
              </div>
              <button
                onClick={() => removeTrack(t.id)}
                title="Remove from library"
                style={{
                  width: 26, height: 26, borderRadius: 6,
                  background: 'transparent', border: '1px solid transparent',
                  color: 'var(--muted)', cursor: 'pointer',
                  display: 'grid', placeItems: 'center',
                }}
              ><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}
      <audio ref={audioRef} style={{ display: 'none' }} />
    </div>
  )
}

function HandlesSection({ form, set }) {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        {[
          ['instagram_handle', 'Instagram'],
          ['tiktok_handle',    'TikTok'],
          ['youtube_handle',   'YouTube'],
          ['linkedin_handle',  'LinkedIn'],
          ['threads_handle',   'Threads'],
          ['x_handle',         'X / Twitter'],
        ].map(([key, label]) => (
          <Field key={key} label={label}>
            <div style={{ position: 'relative' }}>
              <span style={atPrefix}>@</span>
              <input
                className="input"
                value={form[key] || ''}
                onChange={(e) => set(key, e.target.value.replace(/^@/, ''))}
                placeholder="handle"
                style={{ paddingLeft: 26 }}
              />
            </div>
          </Field>
        ))}
      </div>
      <Field label="Core hashtags" style={{ marginTop: 18 }}>
        <input
          className="input"
          value={form.core_hashtags || ''}
          onChange={(e) => set('core_hashtags', e.target.value)}
          placeholder="#scalesolo #aitools"
        />
      </Field>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Editor styles. Kept inline so the file stays self-contained.
// ────────────────────────────────────────────────────────────────────────────
const railStyle = {
  width: 220, flexShrink: 0,
  borderRight: '1px solid var(--border)',
  background: 'var(--surface-2)',
  padding: '16px 10px',
  display: 'flex', flexDirection: 'column', gap: 2,
  overflowY: 'auto',
}
const railItem = (active) => ({
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '9px 10px', borderRadius: 9,
  cursor: 'pointer', textAlign: 'left',
  background: active ? 'var(--surface)' : 'transparent',
  border: active ? '1px solid var(--border)' : '1px solid transparent',
  fontFamily: 'inherit',
  transition: 'background 0.12s',
})
const editorFooter = {
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '14px 24px',
  borderTop: '1px solid var(--border)',
  background: 'var(--surface)',
}
const twoColGrid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 14,
}
const swatchStyle = {
  width: 44, height: 40, padding: 0,
  border: '1px solid var(--border)', borderRadius: 8,
  background: 'transparent', cursor: 'pointer', flexShrink: 0,
}
const importBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 12px', borderRadius: 8,
  background: 'var(--surface-2)', border: '1px solid var(--border)',
  color: 'var(--text)', fontSize: 12.5, fontWeight: 600,
  fontFamily: 'inherit', cursor: 'pointer',
}
const importMenu = {
  position: 'absolute', right: 0, top: 'calc(100% + 6px)',
  width: 280, padding: 6,
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 10, boxShadow: '0 16px 40px rgba(0,0,0,0.35)',
  zIndex: 5,
}
const importItem = {
  display: 'flex', alignItems: 'flex-start', gap: 10,
  padding: 10, borderRadius: 8,
  background: 'transparent', border: 'none', width: '100%',
  textAlign: 'left', cursor: 'pointer', color: 'var(--text)',
  fontFamily: 'inherit',
}
const atPrefix = {
  position: 'absolute', left: 12, top: '50%',
  transform: 'translateY(-50%)',
  color: 'var(--muted)', fontSize: 13,
  fontFamily: 'var(--font-display)', fontWeight: 700,
  pointerEvents: 'none',
}

// ─── Bible paste modal — paste raw text, Claude parses, preview & apply ────
function BiblePasteModal({ token, profileId, onClose, onApply }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [parsed, setParsed] = useState(null)
  const [error, setError] = useState(null)
  const parse = async () => {
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/profiles/parse-bible', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile_id: profileId, raw_text: text }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || 'Parse failed')
      setParsed(body.fields)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  const fieldRows = parsed ? Object.entries(parsed).filter(([, v]) => v != null && (typeof v === 'string' ? v.trim() : true)) : []
  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 110 }}>
      <div className="modal-card modal-card-lg" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <Upload size={18} style={{ color: 'var(--red)' }} />
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, flex: 1 }}>Import a brand bible</h3>
          <button aria-label="Close" onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6, borderRadius: 6 }}><X size={18} /></button>
        </div>
        {!parsed ? (
          <>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.5 }}>
              Paste your brand bible, voice doc, or any prose that describes your brand. Our AI will extract structured fields (voice, audience, colors, fonts, handles, etc.) you can review before applying.
            </div>
            <textarea
              className="textarea"
              style={{ minHeight: 240, width: '100%' }}
              placeholder="Paste raw text here…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            {error && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn-primary" onClick={parse} disabled={busy || !text.trim()}>
                {busy ? <Loader2 size={13} className="spin" /> : <Wand2 size={13} />} Parse with AI
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10 }}>
              Review the extracted fields. Apply to fill the form, then save when you're happy.
            </div>
            <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
              {fieldRows.map(([k, v]) => (
                <div key={k} style={{ marginBottom: 8 }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{k}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>
                    {typeof v === 'string' ? v : JSON.stringify(v, null, 2)}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 14 }}>
              <button className="btn-secondary" onClick={() => setParsed(null)}>Back</button>
              <button className="btn-primary" onClick={() => onApply(parsed)}>
                <Check size={13} /> Apply {fieldRows.length} fields
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Prompt-helper modal — copyable prompt + paste-back JSON ───────────────
const EXTRACTION_PROMPT = `You are extracting a brand identity. Output ONLY a JSON object with these keys (omit any you can't infer):

{
  "business_name": "string",
  "industry": "string",
  "preferred_tone": "comma-separated voice descriptors",
  "target_audience": "string",
  "brand_primary_color": "#rrggbb",
  "brand_secondary_color": "#rrggbb",
  "brand_colors": [{ "name": "string", "hex": "#rrggbb" }],
  "brand_fonts":  [{ "name": "string", "usage": "display|body|mono" }],
  "logo_url": "https://...",
  "website_url": "https://...",
  "core_hashtags": "#tag1 #tag2",
  "instagram_handle": "no @",
  "tiktok_handle": "no @",
  "youtube_handle": "no @",
  "linkedin_handle": "no @",
  "threads_handle": "no @",
  "x_handle": "no @",
  "brand_bible": "<long-form: voice, audience, offer, do-not-say, signature phrases>",
  "brand_bible_summary": "<≤120 words, plain prose>"
}

Rules:
- Only use info I provide or that's strongly implied by it.
- Hex colors must be #rrggbb. Skip any color you don't have a hex for.
- Never use em dashes anywhere.

My brand: <DESCRIBE YOUR BRAND IN A FEW SENTENCES OR PASTE EXISTING DOCS HERE>`

function PromptHelperModal({ onClose, onApply }) {
  const [pasted, setPasted] = useState('')
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)
  const apply = () => {
    setError(null)
    try {
      const m = pasted.match(/\{[\s\S]*\}/)?.[0]
      if (!m) { setError('No JSON found in paste'); return }
      const fields = JSON.parse(m)
      onApply(fields)
    } catch (e) { setError(`Invalid JSON: ${e.message}`) }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(EXTRACTION_PROMPT); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {}
  }
  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 110 }}>
      <div className="modal-card modal-card-lg" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <ClipboardCopy size={18} style={{ color: 'var(--red)' }} />
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, flex: 1 }}>Get an extraction prompt</h3>
          <button aria-label="Close" onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6, borderRadius: 6 }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.5 }}>
          Step 1. Copy this prompt and paste it into any AI tool you use. Replace the bracketed placeholder with your brand info or paste docs there.
        </div>
        <div style={{ position: 'relative', marginBottom: 14 }}>
          <pre style={{
            background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8,
            padding: 12, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-soft)',
            whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto', margin: 0,
          }}>{EXTRACTION_PROMPT}</pre>
          <button
            type="button"
            onClick={copy}
            style={{
              position: 'absolute', top: 6, right: 6, fontSize: 11,
              padding: '4px 9px', borderRadius: 999, cursor: 'pointer',
              background: copied ? 'rgba(46,204,113,0.18)' : 'var(--surface)',
              border: `1px solid ${copied ? '#2ecc71' : 'var(--border)'}`,
              color: copied ? '#2ecc71' : 'var(--text)',
            }}
          >{copied ? 'Copied' : 'Copy prompt'}</button>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.5 }}>
          Step 2. Paste the JSON the AI gives you back, then apply.
        </div>
        <textarea
          className="textarea"
          style={{ minHeight: 160, width: '100%', fontFamily: 'monospace', fontSize: 11.5 }}
          placeholder='{"business_name": "...", "preferred_tone": "..."}'
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
        />
        {error && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={apply} disabled={!pasted.trim()}>
            <Check size={13} /> Apply
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Interview wizard — 8 questions, builds the form step by step ──────────
const INTERVIEW_STEPS = [
  { key: 'business_name',   label: "What's your business name?",   placeholder: 'ScaleSolo' },
  { key: 'industry',        label: 'Industry / niche?',            placeholder: 'AI for solopreneurs' },
  { key: 'target_audience', label: 'Who do you sell to? Describe them in one sentence.', placeholder: 'Solopreneurs scaling past $10k/mo using AI' },
  { key: 'preferred_tone',  label: 'Brand voice — 3 to 5 adjectives.', placeholder: 'Direct, candid, action-oriented' },
  { key: 'offer',           label: 'What do you offer? Free-form.', placeholder: 'AI-native operating system for solo founders', textarea: true },
  { key: 'do_not_say',      label: 'Words or phrases you would NEVER use? (Optional)', placeholder: '"synergy", "leverage" as a verb', textarea: true },
  { key: 'brand_primary_color', label: 'Primary brand color (hex)', placeholder: '#ef4444', color: true },
  { key: 'core_hashtags',   label: 'Signature hashtags? (Optional)', placeholder: '#scalesolo #aitools' },
]

function InterviewModal({ onClose, onApply }) {
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState({})
  const cur = INTERVIEW_STEPS[step]
  const last = step === INTERVIEW_STEPS.length - 1

  const next = () => last ? finish() : setStep(step + 1)
  const back = () => setStep(Math.max(0, step - 1))
  const finish = () => {
    const fields = { ...answers }
    // Bake the offer + do_not_say into a starter brand_bible if user filled them.
    const bible = []
    if (answers.preferred_tone)  bible.push(`Voice: ${answers.preferred_tone}`)
    if (answers.target_audience) bible.push(`Audience: ${answers.target_audience}`)
    if (answers.offer)           bible.push(`Offer: ${answers.offer}`)
    if (answers.do_not_say)      bible.push(`Do-not-say: ${answers.do_not_say}`)
    if (bible.length) fields.brand_bible = bible.join('\n')
    delete fields.offer
    delete fields.do_not_say
    onApply(fields)
  }

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 110 }}>
      <div className="modal-card modal-card-md" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <MessageSquare size={18} style={{ color: 'var(--red)' }} />
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, flex: 1 }}>Brand interview</h3>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{step + 1} / {INTERVIEW_STEPS.length}</span>
          <button aria-label="Close" onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6, borderRadius: 6 }}><X size={18} /></button>
        </div>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14, color: 'var(--text)', marginBottom: 10 }}>
          {cur.label}
        </div>
        {cur.color ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="color"
              value={answers[cur.key] || '#ef4444'}
              onChange={(e) => setAnswers({ ...answers, [cur.key]: e.target.value })}
              style={{ width: 50, height: 44, border: '1px solid var(--border)', borderRadius: 8, background: 'transparent', padding: 0, cursor: 'pointer' }}
            />
            <input className="input" value={answers[cur.key] || ''} onChange={(e) => setAnswers({ ...answers, [cur.key]: e.target.value })} placeholder={cur.placeholder} />
          </div>
        ) : cur.textarea ? (
          <textarea className="textarea" style={{ minHeight: 120, width: '100%' }} value={answers[cur.key] || ''} onChange={(e) => setAnswers({ ...answers, [cur.key]: e.target.value })} placeholder={cur.placeholder} />
        ) : (
          <input className="input" value={answers[cur.key] || ''} onChange={(e) => setAnswers({ ...answers, [cur.key]: e.target.value })} placeholder={cur.placeholder} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') next() }} />
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 16 }}>
          <button className="btn-secondary" onClick={back} disabled={step === 0}>Back</button>
          <button className="btn-primary" onClick={next}>
            {last ? <><Check size={13} /> Finish</> : <>Next <ChevronRight size={13} /></>}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Logo upload ────────────────────────────────────────────────────────────
// Direct browser → Supabase Storage upload (landing-media bucket, public).
// Saves the resulting public URL into the form. Brand-aware spaces nodes
// (brand_profile, image_gen) read this URL automatically.
// Rasterize SVGs (and anything that's not a standard raster image) into a
// 1024×1024 PNG blob via canvas. KIE's image models reject SVG, so we
// flatten on upload and only ever store a PNG. Returns { blob, ext, mime }.
async function rasterizeIfSvg(file) {
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name || '')
  if (!isSvg) return { blob: file, ext: (file.name.split('.').pop() || 'png').toLowerCase(), mime: file.type || 'image/png' }

  const dataUrl = await new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(fr.result)
    fr.onerror = () => rej(new Error('Could not read SVG'))
    fr.readAsDataURL(file)
  })
  const img = await new Promise((res, rej) => {
    const i = new Image()
    i.onload = () => res(i)
    i.onerror = () => rej(new Error('Could not parse SVG'))
    i.src = dataUrl
  })
  const w = Math.max(256, img.naturalWidth || 1024)
  const h = Math.max(256, img.naturalHeight || w)
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, w, h)
  const blob = await new Promise((res, rej) => canvas.toBlob((b) => b ? res(b) : rej(new Error('Canvas to blob failed')), 'image/png'))
  return { blob, ext: 'png', mime: 'image/png' }
}

function LogoUpload({ value, profileId, onChange }) {
  const inpRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  async function onPick(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true); setErr(null)
    try {
      const { blob, ext, mime } = await rasterizeIfSvg(file)
      const path = `${profileId || 'shared'}/logo/${Date.now()}.${ext}`
      const { error } = await supabase.storage.from('landing-media').upload(path, blob, {
        contentType: mime, upsert: false,
      })
      if (error) throw new Error(error.message)
      const { data } = supabase.storage.from('landing-media').getPublicUrl(path)
      onChange(data.publicUrl)
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
      if (inpRef.current) inpRef.current.value = ''
    }
  }

  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <div style={{
        width: 64, height: 64, borderRadius: 10,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        overflow: 'hidden', display: 'grid', placeItems: 'center',
      }}>
        {value ? <img src={value} alt="logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <span style={{ fontSize: 10, color: 'var(--muted)' }}>none</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => inpRef.current?.click()}
          disabled={busy}
          style={{ fontSize: 12 }}
        >
          {busy ? <span className="spinner" /> : <Upload size={12} />} {value ? 'Replace logo' : 'Upload logo'}
        </button>
        {value && (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => onChange('')}
            style={{ fontSize: 11.5, color: 'var(--muted)' }}
          >Remove</button>
        )}
        {err && <div style={{ fontSize: 11, color: 'var(--red)' }}>{err}</div>}
      </div>
      <input ref={inpRef} type="file" accept="image/*" onChange={onPick} style={{ display: 'none' }} />
    </div>
  )
}

// ─── Posting schedule editor ────────────────────────────────────────────────
const TIMEZONES = [
  'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'America/Anchorage', 'Pacific/Honolulu', 'America/Phoenix', 'America/Toronto',
  'America/Mexico_City', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome',
  'Africa/Lagos', 'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Kolkata',
  'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Shanghai',
  'Australia/Sydney', 'Pacific/Auckland', 'UTC',
]
const DAYS = [
  { id: 1, label: 'Mon' }, { id: 2, label: 'Tue' }, { id: 3, label: 'Wed' },
  { id: 4, label: 'Thu' }, { id: 5, label: 'Fri' }, { id: 6, label: 'Sat' }, { id: 0, label: 'Sun' },
]
const PLATFORM_OPTIONS = ['instagram', 'tiktok', 'youtube', 'x', 'threads', 'linkedin', 'facebook']

function PostingScheduleEditor({ timezone, onTimezoneChange, synced, onSyncedChange, schedule, onScheduleChange }) {
  const days = Array.isArray(schedule?.days) ? schedule.days : []
  const times = Array.isArray(schedule?.times) ? schedule.times : []

  // Auto-detect TZ on mount if blank
  useEffect(() => {
    if (!timezone) {
      try {
        const detected = Intl.DateTimeFormat().resolvedOptions().timeZone
        if (detected) onTimezoneChange(detected)
      } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleDay = (id) => {
    const next = days.includes(id) ? days.filter((d) => d !== id) : [...days, id].sort()
    onScheduleChange({ ...schedule, days: next })
  }
  const togglePlatform = (id) => {
    const next = synced.includes(id) ? synced.filter((p) => p !== id) : [...synced, id]
    onSyncedChange(next)
  }
  const setTime = (i, val) => {
    const next = [...times]; next[i] = val
    onScheduleChange({ ...schedule, times: next })
  }
  const removeTime = (i) => {
    onScheduleChange({ ...schedule, times: times.filter((_, j) => j !== i) })
  }
  const addTime = () => {
    onScheduleChange({ ...schedule, times: [...times, '12:00'] })
  }

  // Quick presets
  const applyPreset = (kind) => {
    if (kind === 'weekdays') onScheduleChange({ days: [1,2,3,4,5], times: times.length ? times : ['09:00'] })
    else if (kind === 'daily') onScheduleChange({ days: [0,1,2,3,4,5,6], times: times.length ? times : ['09:00'] })
    else if (kind === 'weekly') onScheduleChange({ days: [3], times: times.length ? times : ['10:00'] })
    else if (kind === '3x') onScheduleChange({ days: [1,3,5], times: times.length ? times : ['09:00'] })
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Field label="Time zone (used for all scheduling)">
        <select className="select" value={timezone || ''} onChange={(e) => onTimezoneChange(e.target.value)}>
          <option value="">Pick…</option>
          {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
        </select>
      </Field>

      {/* "Synced platforms" picker removed — platforms now derive from
          which social accounts the user has actually connected via
          Upload-Post, so a separate picker is redundant. */}

      <Field label="Quick frequency presets">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {[
            ['weekdays', 'Weekdays only'],
            ['weekly',   'Once a week'],
            ['3x',       '3× per week'],
            ['daily',    'Every day'],
          ].map(([k, label]) => (
            <button key={k} type="button" className="btn-ghost" style={{ fontSize: 11.5 }} onClick={() => applyPreset(k)}>{label}</button>
          ))}
        </div>
      </Field>

      <Field label="Days of week">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {DAYS.map((d) => {
            const on = days.includes(d.id)
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => toggleDay(d.id)}
                style={{
                  width: 50, padding: '7px 0', borderRadius: 8, cursor: 'pointer',
                  border: `1px solid ${on ? 'var(--red)' : 'var(--border)'}`,
                  background: on ? 'rgba(239,68,68,0.16)' : 'var(--surface-2)',
                  color: on ? 'var(--red)' : 'var(--text-soft)',
                  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12,
                }}
              >{d.label}</button>
            )
          })}
        </div>
      </Field>

      <Field label="Posting times (in selected time zone)">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {times.map((t, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="time"
                value={t}
                onChange={(e) => setTime(i, e.target.value)}
                className="input"
                style={{ maxWidth: 150 }}
              />
              <button type="button" className="btn-ghost" onClick={() => removeTime(i)} style={{ color: 'var(--muted)' }}>
                <X size={12} />
              </button>
            </div>
          ))}
          <button type="button" className="btn-ghost" onClick={addTime} style={{ alignSelf: 'flex-start', fontSize: 11.5 }}>
            <Plus size={12} /> Add time
          </button>
        </div>
        {times.length === 0 && <div style={{ marginTop: 4, fontSize: 11, color: 'var(--amber)' }}>Add at least one time. Without slots nothing will auto-schedule.</div>}
      </Field>
    </div>
  )
}

function Field({ label, required, children, style }) {
  return (
    <div style={style}>
      <label className="label">{label}{required && <span style={{ color: 'var(--red)' }}> *</span>}</label>
      {children}
    </div>
  )
}

// Quickstart modal — paste handle + 1-line description, Claude drafts a
// full brand profile. Bypasses the 20-empty-fields cold-start.
function QuickstartModal({ token, onClose, onCreated }) {
  const [platform, setPlatform] = useState('instagram')
  const [handle, setHandle]         = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = async () => {
    setError(null)
    if (description.trim().length < 10) {
      setError('Add a sentence or two on what you post about so the draft is on-brand.')
      return
    }
    setBusy(true)
    try {
      const r = await fetch('/api/profiles/quickstart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ handle: handle.trim(), platform, description: description.trim() }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      onCreated(body.profile)
    } catch (e) { setError(e.message); setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal-card modal-card-md" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <Sparkles size={18} style={{ color: 'var(--red)' }} />
          <h3 style={{ flex: 1, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 17 }}>Quickstart your brand</h3>
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.5, margin: '4px 0 16px' }}>
          Paste your social handle and a sentence about what you post. We'll draft a brand bible, voice, audience, and core hashtags — you review and edit before saving.
        </p>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>
            Platform
          </label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[
              ['instagram', 'Instagram'],
              ['tiktok',    'TikTok'],
              ['youtube',   'YouTube'],
              ['threads',   'Threads'],
              ['x',         'X'],
              ['linkedin',  'LinkedIn'],
            ].map(([k, label]) => {
              const on = platform === k
              return (
                <button
                  key={k} type="button"
                  onClick={() => setPlatform(k)}
                  style={{
                    padding: '6px 12px', borderRadius: 999, fontSize: 12,
                    border: `1px solid ${on ? 'var(--red)' : 'var(--border)'}`,
                    background: on ? 'rgba(239,68,68,0.16)' : 'var(--surface-2)',
                    color: on ? 'var(--red)' : 'var(--text-soft)',
                    cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700,
                  }}
                >{label}</button>
              )
            })}
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>
            Handle
          </label>
          <input
            className="input"
            placeholder="rayvaughnceo"
            value={handle}
            onChange={(e) => setHandle(e.target.value.replace(/^@/, ''))}
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>
            What do you post about?
          </label>
          <textarea
            className="input"
            placeholder="Real-talk dating advice for women in their 20s. Bold, unapologetic, friend-giving-tough-love energy. Houston-based."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            style={{ width: '100%', resize: 'vertical', minHeight: 90, fontFamily: 'inherit' }}
          />
        </div>

        {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            {busy ? <span className="spinner" /> : <Sparkles size={13} />} {busy ? 'Drafting…' : 'Draft brand'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function Profiles() {
  const { profiles, selectedProfileId, setSelectedProfileId, refresh } = useProfile()
  const { session } = useAuth()
  const [editing, setEditing] = useState(null)
  const [quickstart, setQuickstart] = useState(false)

  const startNew = () => setEditing({})
  const startQuickstart = () => setQuickstart(true)

  const onSaved = async (profile) => {
    await refresh()
    setEditing(null)
    if (profile?.id) setSelectedProfileId(profile.id)
  }
  const onQuickstartCreated = async (profile) => {
    setQuickstart(false)
    await refresh()
    if (profile?.id) {
      setSelectedProfileId(profile.id)
      // Drop them straight into the editor so they can review the AI draft.
      setEditing(profile)
    }
  }

  const onDelete = async (p) => {
    if (!confirm(`Delete "${p.business_name}" and all of its data? This cannot be undone.`)) return
    await fetch(`/api/profiles?id=${p.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    await refresh()
  }

  return (
    <div className="fade-up">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, gap: 8 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, flex: 1 }}>Brand profiles</h2>
        <button className="btn-secondary" onClick={startQuickstart} title="Let AI draft a brand profile from your handle + description">
          <Sparkles size={14} /> Quickstart
        </button>
        <button className="btn-primary" onClick={startNew}><Plus size={14} /> New profile</button>
      </div>

      {profiles.length === 0 ? (
        <div className="card-flat" style={{ padding: 50, textAlign: 'center', color: 'var(--muted)', marginTop: 14 }}>
          <Building2 size={28} style={{ marginBottom: 12 }} />
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text)', marginBottom: 6 }}>
            Set up your first brand
          </div>
          <div style={{ fontSize: 13, marginBottom: 22, lineHeight: 1.5, maxWidth: 420, margin: '0 auto 22px' }}>
            One brand profile = one identity. Quickstart lets you paste a social handle + a sentence, and AI drafts the bible, voice, audience, and hashtags for you. Or build from scratch.
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button className="btn-primary" onClick={startQuickstart}><Sparkles size={15} /> Quickstart with AI</button>
            <button className="btn-secondary" onClick={startNew}><Plus size={15} /> Build from scratch</button>
          </div>
        </div>
      ) : (
        <div style={grid}>
          {profiles.map((p) => {
            const isActive = p.id === selectedProfileId
            const role = p._role || p.role
            return (
              <div
                key={p.id}
                style={cardStyle(isActive)}
                onClick={() => setSelectedProfileId(p.id)}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.transform = 'translateY(-2px)' }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.transform = 'translateY(0)' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={initialsStyle(p.brand_primary_color ? `linear-gradient(135deg, ${p.brand_primary_color}, ${p.brand_secondary_color || p.brand_primary_color})` : null)}>
                    {initialsOf(p.business_name)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.business_name}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                      {p.industry || (p.business_type ? p.business_type : '—')}
                    </div>
                  </div>
                  {isActive && <span style={tagPill}><Check size={11} /> Active</span>}
                  {role === 'owner' && <span style={{ ...tagPill, background: 'rgba(245,158,11,0.16)', color: '#f59e0b' }}><Crown size={11} /> Owner</span>}
                </div>
                {p.brand_bible && (
                  <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-soft)', lineHeight: 1.5, maxHeight: 60, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.brand_bible.slice(0, 140)}{p.brand_bible.length > 140 ? '…' : ''}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
                  <button className="btn-ghost" style={{ padding: '6px 10px', fontSize: 12 }} onClick={(e) => { e.stopPropagation(); setEditing(p) }}>
                    <Edit3 size={12} /> Edit
                  </button>
                  {role === 'owner' && (
                    <button className="btn-ghost" style={{ padding: '6px 10px', fontSize: 12 }} onClick={(e) => { e.stopPropagation(); onDelete(p) }}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editing && <ProfileEditor profile={editing} onClose={() => setEditing(null)} onSaved={onSaved} />}
      {quickstart && (
        <QuickstartModal
          token={session.access_token}
          onClose={() => setQuickstart(false)}
          onCreated={onQuickstartCreated}
        />
      )}
    </div>
  )
}
