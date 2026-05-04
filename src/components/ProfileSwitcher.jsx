// Compact profile switcher dropdown for the Header.
// Click → list of profiles + "Manage profiles" link to /profiles.
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Building2, ChevronDown, Plus, Settings, Check } from 'lucide-react'
import { useProfile } from '../context/ProfileContext.jsx'

const initialsOf = (name) =>
  (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('') || '?'

const trigger = {
  display: 'inline-flex', alignItems: 'center', gap: 8,
  height: 38, padding: '0 10px',
  background: 'var(--surface-2)', border: '1px solid var(--border)',
  borderRadius: 10, cursor: 'pointer',
  fontSize: 12.5, fontFamily: 'var(--font-display)',
  color: 'var(--text)',
  maxWidth: 220,
}
const initials = (color) => ({
  width: 24, height: 24, borderRadius: 6,
  display: 'grid', placeItems: 'center',
  background: color || 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff', fontWeight: 700, fontSize: 11, fontFamily: 'var(--font-display)',
  flexShrink: 0,
})
const dropdown = {
  position: 'absolute',
  top: 'calc(100% + 6px)', right: 0,
  width: 280, maxHeight: 380, overflow: 'auto',
  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
  padding: 6, zIndex: 50,
  boxShadow: 'var(--shadow-pop)',
}
const item = (active) => ({
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '8px 10px', borderRadius: 8,
  background: active ? 'var(--surface-2)' : 'transparent',
  cursor: 'pointer',
  marginBottom: 2,
  transition: 'background 0.1s ease',
})
const empty = {
  padding: '14px 12px', fontSize: 12.5, color: 'var(--muted)', textAlign: 'center',
}
const action = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '8px 10px', borderRadius: 8,
  background: 'transparent', border: 'none', cursor: 'pointer',
  fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 12.5,
  color: 'var(--text-soft)',
  width: '100%', textAlign: 'left',
}

export default function ProfileSwitcher() {
  const { profiles, selectedProfile, selectedProfileId, setSelectedProfileId } = useProfile()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const navigate = useNavigate()

  useEffect(() => {
    const onClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        style={trigger}
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(239,68,68,0.3)' }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)' }}
      >
        {selectedProfile ? (
          <>
            <div style={initials(
              selectedProfile.brand_primary_color
                ? `linear-gradient(135deg, ${selectedProfile.brand_primary_color}, ${selectedProfile.brand_secondary_color || selectedProfile.brand_primary_color})`
                : null
            )}>
              {initialsOf(selectedProfile.business_name)}
            </div>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
              {selectedProfile.business_name}
            </span>
          </>
        ) : (
          <>
            <Building2 size={14} style={{ color: 'var(--muted)' }} />
            <span style={{ color: 'var(--muted)' }}>No brand selected</span>
          </>
        )}
        <ChevronDown size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
      </button>

      {open && (
        <div style={dropdown}>
          {profiles.length === 0 ? (
            <div style={empty}>No brand profiles yet.</div>
          ) : (
            profiles.map((p) => (
              <div
                key={p.id}
                style={item(p.id === selectedProfileId)}
                onClick={() => { setSelectedProfileId(p.id); setOpen(false) }}
              >
                <div style={initials(
                  p.brand_primary_color
                    ? `linear-gradient(135deg, ${p.brand_primary_color}, ${p.brand_secondary_color || p.brand_primary_color})`
                    : null
                )}>{initialsOf(p.business_name)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.business_name}
                  </div>
                  {p.industry && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{p.industry}</div>}
                </div>
                {p.id === selectedProfileId && <Check size={14} style={{ color: 'var(--red)' }} />}
              </div>
            ))
          )}
          <div style={{ height: 1, background: 'var(--border)', margin: '6px 4px' }} />
          <button style={action} onClick={() => { setOpen(false); navigate('/profiles') }}>
            <Plus size={14} /> Create new brand
          </button>
          <button style={action} onClick={() => { setOpen(false); navigate('/profiles') }}>
            <Settings size={14} /> Manage profiles
          </button>
        </div>
      )}
    </div>
  )
}
