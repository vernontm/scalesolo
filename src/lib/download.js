// Robust "save this media" helper that works on phones, not just desktop.
//
// The naive approach (`<a href={url} download>`) silently fails on mobile:
// browsers ignore the download attribute for cross-origin URLs (our media
// lives on Supabase storage, a different origin), so tapping the button just
// opens the video full-screen in a new view with no way to save it. That is
// exactly the "it just opens in a window" behaviour users hit on iPhone.
//
// saveMedia() handles all three environments:
//   1. Phone/tablet with the Web Share API for files (iOS Safari, Android
//      Chrome): hand the file to the native share sheet, which offers
//      "Save Image" / "Save Video" (to Photos) and "Save to Files".
//   2. Desktop: fetch the bytes and trigger a normal same-origin blob
//      download via a temporary <a> (works cross-origin because the object
//      URL we build is same-origin).
//   3. Fetch blocked (network / CORS): open the URL in a new tab as a last
//      resort so the media is at least reachable to long-press / right-click.

// Coarse-pointer / touch signal. We only reach for the share sheet on these
// devices so desktop keeps its plain-download behaviour (no surprise OS
// share dialog on machines that happen to expose navigator.share).
function isTouchDevice() {
  if (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) return true
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(pointer: coarse)').matches
  }
  return false
}

export async function saveMedia(url, filename) {
  if (!url) return
  const name = filename || url.split('/').pop()?.split('?')[0] || 'download'

  let blob
  try {
    const r = await fetch(url)
    if (!r.ok) throw new Error(`fetch ${r.status}`)
    blob = await r.blob()
  } catch {
    // Couldn't read the bytes (network / CORS). Fall back to opening the
    // URL so the media stays reachable rather than failing silently.
    window.open(url, '_blank', 'noopener')
    return
  }

  // Mobile: native share sheet -> Save to Photos / Save to Files.
  if (isTouchDevice() && typeof navigator !== 'undefined' && navigator.canShare) {
    try {
      const file = new File([blob], name, { type: blob.type || 'application/octet-stream' })
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] })
        return
      }
    } catch (e) {
      // User dismissed the share sheet: stop here, don't also download.
      if (e && e.name === 'AbortError') return
      // Any other share failure: fall through to the blob-download path.
    }
  }

  // Desktop (or no file-share support): normal download.
  const obj = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = obj
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(obj), 1500)
}
