// Public renderer at /p/:slug — unauthenticated, brand-styled, with view tracking.
import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { renderSection } from '../lib/landing-sections.jsx'

export default function LandingPublic() {
  const { slug } = useParams()
  const [params] = useSearchParams()
  const [page, setPage] = useState(null)
  const [brand, setBrand] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const startedAt = useRef(Date.now())
  const maxScroll = useRef(0)
  const trackedRef = useRef(false)

  useEffect(() => {
    if (!slug) return
    const profileId = params.get('p')
    fetch(`/api/landing-pages-public?slug=${encodeURIComponent(slug)}${profileId ? `&p=${profileId}` : ''}`)
      .then((r) => r.json())
      .then((body) => {
        if (body.error) throw new Error(body.error)
        setPage(body.page)
        setBrand(body.brand)
        if (body.page?.meta?.title) document.title = body.page.meta.title
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [slug])

  useEffect(() => {
    if (!page) return
    const onScroll = () => {
      const h = document.documentElement
      const pct = Math.min(100, Math.round(((window.scrollY + window.innerHeight) / h.scrollHeight) * 100))
      if (pct > maxScroll.current) maxScroll.current = pct
    }
    window.addEventListener('scroll', onScroll, { passive: true })

    const sendBeacon = () => {
      if (trackedRef.current) return
      trackedRef.current = true
      const utm = {
        source:   params.get('utm_source') || null,
        medium:   params.get('utm_medium') || null,
        campaign: params.get('utm_campaign') || null,
        content:  params.get('utm_content') || null,
      }
      const payload = JSON.stringify({
        page_id: page.id,
        scroll_depth_pct: maxScroll.current,
        time_on_page_sec: Math.round((Date.now() - startedAt.current) / 1000),
        utm,
      })
      // navigator.sendBeacon is ideal for unload, falls back to fetch
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon('/api/landing-pages/track', new Blob([payload], { type: 'application/json' }))
        } else {
          fetch('/api/landing-pages/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true })
        }
      } catch {}
    }
    const onPageHide = () => sendBeacon()
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('beforeunload', onPageHide)
    // also send a beacon after 30s in case the user just sits on the page
    const t = setTimeout(sendBeacon, 30000)

    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('beforeunload', onPageHide)
      clearTimeout(t)
      sendBeacon()
    }
  }, [page])

  if (loading) {
    return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}><span className="spinner" /></div>
  }
  if (error || !page) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18, color: 'var(--text)', marginBottom: 6 }}>Page not found</div>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>{error || "This landing page doesn't exist or isn't published."}</div>
        </div>
      </div>
    )
  }

  return (
    <div>
      {(page.sections || []).map((s) => (
        <div key={s.id || s.type}>{renderSection(s, brand)}</div>
      ))}
      <footer style={{ padding: '24px', textAlign: 'center', fontSize: 11, color: 'var(--muted)', borderTop: '1px solid var(--border)' }}>
        Powered by ScaleSolo
      </footer>
    </div>
  )
}
