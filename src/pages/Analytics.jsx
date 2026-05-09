import { useEffect, useMemo, useState } from 'react'
import { BarChart3, RefreshCw, Loader2, Music2, Instagram, Youtube, Twitter, Linkedin, AtSign, Facebook, Eye, Heart, MessageCircle, Share2, Users } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useProfile } from '../context/ProfileContext.jsx'

// Per-profile content analytics. First-pass scope: published volume,
// platform mix, weekly trend chart, recent posts list. Engagement
// metrics from Upload-Post show up under upload_post stats when their
// API returns data — surfaced in the platform cards as a secondary
// "views" line.

const WINDOWS = [
  { id: '7d',  label: 'Last 7 days'  },
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 90 days' },
]

function fmtNum(n) {
  const v = Number(n) || 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000)     return `${(v / 1_000).toFixed(1)}K`
  return new Intl.NumberFormat().format(v)
}

const PLATFORM_META = {
  tiktok:    { label: 'TikTok',    color: '#fe2c55', Icon: Music2 },
  instagram: { label: 'Instagram', color: '#e1306c', Icon: Instagram },
  youtube:   { label: 'YouTube',   color: '#ff0000', Icon: Youtube },
  x:         { label: 'X',         color: '#e7e9ea', Icon: Twitter },
  linkedin:  { label: 'LinkedIn',  color: '#0a66c2', Icon: Linkedin },
  threads:   { label: 'Threads',   color: '#a78bfa', Icon: AtSign },
  facebook:  { label: 'Facebook',  color: '#1877f2', Icon: Facebook },
}

export default function Analytics() {
  const { session } = useAuth()
  const { selectedProfileId } = useProfile()
  const [windowId, setWindowId] = useState('30d')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const refresh = async (force = false) => {
    if (!session?.access_token || !selectedProfileId) return
    setLoading(true); setError(null)
    try {
      const url = `/api/analytics?profile_id=${selectedProfileId}&window=${windowId}${force ? '&refresh=1' : ''}`
      const r = await fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `Failed (${r.status})`)
      setData(body)
    } catch (e) {
      setError(e.message); setData(null)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { refresh() /* eslint-disable-next-line */ }, [selectedProfileId, windowId])

  const seriesMax = useMemo(() => {
    return Math.max(1, ...(data?.series?.map((s) => s.posts) || [0]))
  }, [data])

  if (!selectedProfileId) {
    return <div className="card-flat fade-up" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', margin: 40 }}>
      Pick a brand profile to see analytics.
    </div>
  }

  return (
    <div style={{ padding: '32px 28px', maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10,
          background: 'linear-gradient(135deg, rgba(239,68,68,0.18), rgba(249,115,22,0.10))',
          border: '1px solid rgba(239,68,68,0.30)',
          color: 'var(--red)', display: 'grid', placeItems: 'center',
        }}><BarChart3 size={18} /></div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22 }}>Analytics</div>
          <div style={{ fontSize: 13, color: 'var(--text-soft)', marginTop: 2 }}>
            Posts published, platform mix, and weekly trend for the active brand.
            {data?.cached && <span style={{ marginLeft: 6, fontSize: 12, color: 'var(--muted)' }}>· cached {new Date(data.cached_at).toLocaleTimeString()}</span>}
          </div>
        </div>
        <button
          onClick={() => refresh(true)}
          disabled={loading}
          style={{
            padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)',
            background: 'var(--surface-2)', color: 'var(--text-soft)',
            display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5,
            cursor: loading ? 'wait' : 'pointer',
          }}
        >
          {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh
        </button>
      </div>

      <div style={{ display: 'inline-flex', gap: 6, background: 'var(--surface-2)', borderRadius: 10, padding: 4, marginBottom: 18 }}>
        {WINDOWS.map((w) => (
          <button
            key={w.id}
            onClick={() => setWindowId(w.id)}
            style={{
              padding: '6px 14px', borderRadius: 8, fontSize: 12.5,
              fontFamily: 'var(--font-display)', fontWeight: 600,
              background: windowId === w.id ? 'linear-gradient(135deg, var(--red), var(--red-dark))' : 'transparent',
              color: windowId === w.id ? '#fff' : 'var(--text-soft)',
              border: windowId === w.id ? 'none' : '1px solid transparent',
              cursor: 'pointer',
            }}
          >{w.label}</button>
        ))}
      </div>

      {error && <div style={{ background: 'var(--red-soft)', color: 'var(--red)', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 14 }}>{error}</div>}

      {data && (
        <>
          {/* Engagement totals — pulled from Upload-Post per-post + */}
          {/* impressions endpoints. Renders only when those return data. */}
          {(data.engagement_totals || data.total_impressions) && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 12 }}>
              {data.total_impressions && (
                <Stat label="Impressions" value={fmtNum(data.total_impressions.total)} icon={Users} accent />
              )}
              {data.engagement_totals && (
                <>
                  <Stat label="Views"    value={fmtNum(data.engagement_totals.views)}    icon={Eye} />
                  <Stat label="Likes"    value={fmtNum(data.engagement_totals.likes)}    icon={Heart} />
                  <Stat label="Comments" value={fmtNum(data.engagement_totals.comments)} icon={MessageCircle} />
                  <Stat label="Shares"   value={fmtNum(data.engagement_totals.shares)}   icon={Share2} />
                </>
              )}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 18 }}>
            <Stat label="Posts published" value={data.total_posts} accent />
            {Object.entries(data.platform_counts || {}).slice(0, 4).map(([p, n]) => (
              <Stat key={p} label={PLATFORM_META[p]?.label || p} value={n} icon={PLATFORM_META[p]?.Icon} color={PLATFORM_META[p]?.color} />
            ))}
          </div>

          {/* Account-level platform breakdown (followers / reach / views) */}
          {data.uploadpost_stats && (
            <div className="card-flat" style={{ marginBottom: 18, padding: 18 }}>
              <div style={sectionLabel}>Account analytics</div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead>
                    <tr>
                      <th style={th}>Platform</th>
                      <th style={th}>Followers</th>
                      <th style={th}>Reach</th>
                      <th style={th}>Views</th>
                      <th style={th}>Likes</th>
                      <th style={th}>Comments</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.uploadpost_stats).map(([p, s]) => {
                      if (!s || typeof s !== 'object') return null
                      const meta = PLATFORM_META[p] || { label: p, color: 'var(--muted)' }
                      return (
                        <tr key={p} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={td}><span style={{ color: meta.color, fontWeight: 700 }}>{meta.label}</span></td>
                          <td style={td}>{fmtNum(s.followers)}</td>
                          <td style={td}>{fmtNum(s.reach)}</td>
                          <td style={td}>{fmtNum(s.views)}</td>
                          <td style={td}>{fmtNum(s.likes)}</td>
                          <td style={td}>{fmtNum(s.comments)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Weekly trend bars */}
          <div className="card-flat" style={{ marginBottom: 18, padding: 18 }}>
            <div style={sectionLabel}>Weekly publishing volume</div>
            {!data.series?.length ? (
              <div style={{ padding: 18, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>No data yet — publish a post to see the trend.</div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 160, padding: '12px 0' }}>
                {data.series.map((s, i) => {
                  const h = Math.max(2, Math.round((s.posts / seriesMax) * 140))
                  return (
                    <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }} title={`${s.week}: ${s.posts} post${s.posts === 1 ? '' : 's'}`}>
                      <div style={{ fontSize: 10, color: 'var(--muted)' }}>{s.posts || ''}</div>
                      <div style={{
                        width: '100%', height: h,
                        background: s.posts > 0 ? 'linear-gradient(180deg, var(--red), var(--red-dark))' : 'var(--surface-2)',
                        borderRadius: 4,
                      }} />
                      <div style={{ fontSize: 9.5, color: 'var(--muted)' }}>
                        {new Date(s.week).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Platform breakdown bar */}
          <div className="card-flat" style={{ marginBottom: 18, padding: 18 }}>
            <div style={sectionLabel}>Platform mix</div>
            {Object.keys(data.platform_counts || {}).length === 0 ? (
              <div style={{ padding: 18, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>No publishing activity in this window.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {Object.entries(data.platform_counts).sort((a, b) => b[1] - a[1]).map(([p, n]) => {
                  const meta = PLATFORM_META[p] || { label: p, color: 'var(--muted)' }
                  const pct = data.total_posts ? Math.round((n / data.total_posts) * 100) : 0
                  return (
                    <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 110, fontSize: 13, color: 'var(--text)' }}>{meta.label}</div>
                      <div style={{ flex: 1, height: 14, borderRadius: 999, background: 'var(--surface-2)', overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: meta.color, transition: 'width 0.3s ease' }} />
                      </div>
                      <div style={{ width: 64, textAlign: 'right', fontSize: 12.5, color: 'var(--text-soft)' }}>
                        {n} <span style={{ color: 'var(--muted)' }}>({pct}%)</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Recent posts */}
          <div className="card-flat" style={{ padding: 18 }}>
            <div style={sectionLabel}>Recent published posts</div>
            {!data.recent_posts?.length ? (
              <div style={{ padding: 18, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>Nothing published in this window.</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead>
                    <tr>
                      <th style={th}>Date</th>
                      <th style={th}>Title</th>
                      <th style={th}>Platforms</th>
                      <th style={th}>Type</th>
                      <th style={th}>Performance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent_posts.map((p) => (
                      <tr key={p.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={td}>{new Date(p.created_at).toLocaleDateString()}</td>
                        <td style={{ ...td, maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {p.title || <span style={{ color: 'var(--muted)' }}>{p.caption}</span>}
                        </td>
                        <td style={td}>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {p.platforms.map((pl) => {
                              const meta = PLATFORM_META[pl] || { label: pl, color: 'var(--muted)' }
                              return (
                                <span key={pl} style={{
                                  fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 999,
                                  background: 'var(--surface-2)', color: meta.color, border: '1px solid var(--border)',
                                }}>{meta.label}</span>
                              )
                            })}
                          </div>
                        </td>
                        <td style={td}>{p.media_type}</td>
                        <td style={td}>
                          {p.metrics ? (
                            <div style={{ display: 'flex', gap: 10, fontSize: 11.5, color: 'var(--text-soft)' }}>
                              <span title="Views"><Eye size={11} style={{ verticalAlign: '-1px', marginRight: 3 }} />{fmtNum(p.metrics.views)}</span>
                              <span title="Likes"><Heart size={11} style={{ verticalAlign: '-1px', marginRight: 3 }} />{fmtNum(p.metrics.likes)}</span>
                              <span title="Comments"><MessageCircle size={11} style={{ verticalAlign: '-1px', marginRight: 3 }} />{fmtNum(p.metrics.comments)}</span>
                              <span title="Shares"><Share2 size={11} style={{ verticalAlign: '-1px', marginRight: 3 }} />{fmtNum(p.metrics.shares)}</span>
                            </div>
                          ) : (
                            <span style={{ color: 'var(--muted)' }}>—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Stat({ label, value, icon: Icon, color, accent }) {
  return (
    <div style={{
      padding: 14, borderRadius: 12,
      background: accent ? 'linear-gradient(135deg, rgba(239,68,68,0.14), rgba(249,115,22,0.08))' : 'var(--surface)',
      border: accent ? '1px solid rgba(239,68,68,0.32)' : '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        {Icon && <Icon size={11} style={{ color: color || 'var(--muted)' }} />}
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>
          {label}
        </div>
      </div>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22, color: accent ? 'var(--red)' : 'var(--text)' }}>
        {value ?? '—'}
      </div>
    </div>
  )
}

const sectionLabel = { fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 }
const th = { padding: '8px 10px', textAlign: 'left', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }
const td = { padding: '8px 10px', textAlign: 'left', color: 'var(--text)' }
