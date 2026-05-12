// PlatformBadge — small circular brand mark used in row cells, calendar
// cards, filter chips, and anywhere else we need to denote a social
// platform compactly. Real SVG icons come from the sm_icons Supabase
// bucket; Threads + LinkedIn don't have hosted assets yet so they fall
// back to a colored brand-letter chip. Adding a logo URL is a one-line
// change in PLATFORMS below — the component auto-renders <img>.

const SM_ICON_BASE = 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/sm_icons'

export const PLATFORMS = [
  { id: 'tiktok',    label: 'TikTok',    kinds: ['video', 'text'],          color: '#ff0050', initial: 'T', logo: `${SM_ICON_BASE}/tiktok.svg` },
  { id: 'instagram', label: 'Instagram', kinds: ['image', 'video'],         color: '#e1306c', initial: 'I', logo: `${SM_ICON_BASE}/instagram.svg` },
  { id: 'youtube',   label: 'YouTube',   kinds: ['video'],                  color: '#ff0000', initial: 'Y', logo: `${SM_ICON_BASE}/youtube.svg` },
  { id: 'facebook',  label: 'Facebook',  kinds: ['image', 'video', 'text'], color: '#1877f2', initial: 'F', logo: `${SM_ICON_BASE}/facebook.svg` },
  { id: 'linkedin',  label: 'LinkedIn',  kinds: ['image', 'video', 'text'], color: '#0a66c2', initial: 'L', logo: `${SM_ICON_BASE}/linkedin-svgrepo-com.svg` },
  { id: 'threads',   label: 'Threads',   kinds: ['image', 'video', 'text'], color: '#000000', initial: '@', logo: `${SM_ICON_BASE}/threads.svg` },
  { id: 'x',         label: 'X',         kinds: ['image', 'video', 'text'], color: '#000000', initial: '𝕏', logo: `${SM_ICON_BASE}/x.svg` },
]

export function PlatformBadge({ id, size = 18, title }) {
  const def = PLATFORMS.find((p) => p.id === id)
  if (!def) return null
  if (def.logo) {
    return (
      <img
        src={def.logo}
        alt={def.label}
        title={title || def.label}
        style={{
          width: size, height: size, borderRadius: 999,
          objectFit: 'cover', flexShrink: 0,
          background: '#fff',
        }}
      />
    )
  }
  return (
    <span
      title={title || def.label}
      style={{
        display: 'inline-grid', placeItems: 'center',
        width: size, height: size, borderRadius: 999,
        background: def.color, color: '#fff',
        fontFamily: 'var(--font-display)', fontWeight: 700,
        fontSize: Math.round(size * 0.55), lineHeight: 1, flexShrink: 0,
      }}
    >{def.initial}</span>
  )
}

// Pretty label list for a comma-separated string like "TikTok, Instagram".
export function platformLabels(ids) {
  return (Array.isArray(ids) ? ids : [])
    .map((id) => PLATFORMS.find((p) => p.id === id)?.label || id)
    .join(', ')
}
