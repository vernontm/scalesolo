// Browser-side image compression. Used by upload flows that need to
// stay under a hard size limit (HeyGen avatar photo: 10MB; KIE image
// inputs: similar; Storage CDN: any). Decodes via createImageBitmap
// (fast, off-thread), redraws onto a canvas at a scaled-down size if
// needed, and re-encodes as JPEG at progressively lower quality + size
// until the blob is under the target. Always returns a File so call
// sites can drop it straight into a FormData / Storage upload.
//
// The original file is returned untouched if it's already small enough
// or the user uploads a non-raster format we can't decode (SVG, HEIC
// without browser support). Errors throw so the caller can surface a
// clear message instead of silently uploading a broken file.

const DEFAULT_TARGET_BYTES = 8 * 1024 * 1024  // 8MB — leaves headroom under a 10MB limit
const DEFAULT_MAX_DIMENSION = 4096            // covers HeyGen's 4K input ceiling
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.70, 0.62, 0.55, 0.48]
const DIMENSION_STEPS = [1, 0.85, 0.7, 0.55]  // multipliers vs starting dimension

// Attempt order:
//   1. Decode the file
//   2. Walk QUALITY_STEPS at the original-but-capped dimension
//   3. If still too big, scale down by DIMENSION_STEPS and rewalk quality
//   4. Last attempt is whatever we got, even if still over (caller can
//      surface the size; we don't lose work)
export async function compressImageIfLarge(file, {
  targetBytes = DEFAULT_TARGET_BYTES,
  maxDimension = DEFAULT_MAX_DIMENSION,
  // When true, always re-encode (useful if you want a predictable
  // JPEG output regardless of input). Default skips when already small.
  forceReencode = false,
  // Output mime. JPEG is the right call for photos; PNG re-encoding
  // can actually grow the file. Falls back to JPEG even if the input
  // was PNG since user-facing limit is what matters.
  mime = 'image/jpeg',
  onProgress,                              // optional (stage, info) callback for UI
} = {}) {
  if (!(file instanceof Blob)) throw new Error('compressImageIfLarge: expected a Blob/File')
  if (!forceReencode && file.size <= targetBytes) return file
  // Bail on unsupported formats — let the caller decide what to do.
  // SVG isn't a raster. HEIC works in Safari only.
  const fName = (file.name || '').toLowerCase()
  if (file.type === 'image/svg+xml' || fName.endsWith('.svg')) return file

  onProgress?.('decoding', { sourceBytes: file.size })
  const bitmap = await decodeBitmap(file)
  try {
    const startW = bitmap.width
    const startH = bitmap.height
    let bestBlob = null

    for (const dimMult of DIMENSION_STEPS) {
      // Cap by maxDimension AND apply the dimension reduction step.
      const scale = Math.min(1, maxDimension / Math.max(startW, startH)) * dimMult
      const w = Math.max(64, Math.round(startW * scale))
      const h = Math.max(64, Math.round(startH * scale))

      const canvas = makeCanvas(w, h)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Could not get 2d context')
      // White matte for transparent PNGs encoded to JPEG. JPEG has no
      // alpha and the default would render as black.
      if (mime === 'image/jpeg') {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
      }
      ctx.drawImage(bitmap, 0, 0, w, h)

      for (const q of QUALITY_STEPS) {
        const blob = await canvasToBlob(canvas, mime, q)
        if (!blob) continue
        bestBlob = blob
        onProgress?.('encoding', { width: w, height: h, quality: q, bytes: blob.size })
        if (blob.size <= targetBytes) {
          return blobToFile(blob, file, mime)
        }
      }
    }

    // Couldn't get under target — return the smallest attempt we made.
    // Caller can decide whether to surface a warning. We don't fall back
    // to the original because the original is what's already over.
    return blobToFile(bestBlob || file, file, mime)
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close()
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

async function decodeBitmap(file) {
  // createImageBitmap is the fast path (off-thread on most browsers).
  // Fall back to <img> + dataURL for HEIC / older Safari.
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file) } catch {}
  }
  return await new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      // Polyfill ImageBitmap-ish shape: {width,height} + drawImage works.
      try {
        URL.revokeObjectURL(url)
        resolve(img)
      } catch (e) { reject(e) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode image')) }
    img.src = url
  })
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') {
    try { return new OffscreenCanvas(w, h) } catch {}
  }
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  return c
}

async function canvasToBlob(canvas, mime, quality) {
  if (typeof canvas.convertToBlob === 'function') {
    // OffscreenCanvas path
    return canvas.convertToBlob({ type: mime, quality })
  }
  return await new Promise((res) => canvas.toBlob((b) => res(b), mime, quality))
}

function blobToFile(blob, originalFile, mime) {
  const baseName = (originalFile.name || 'image').replace(/\.[^.]+$/, '')
  const ext = mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] || 'bin')
  return new File([blob], `${baseName}.${ext}`, { type: mime, lastModified: Date.now() })
}
