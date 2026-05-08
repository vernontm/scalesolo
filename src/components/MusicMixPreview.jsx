import { useEffect, useRef, useState } from 'react'
import { Play, Pause, Volume2 } from 'lucide-react'

// Web Audio mix preview. Loads the upstream rendered video's audio
// alongside the music URL, lets the user scrub the volume slider, and
// plays both together through a single AudioContext so the levels
// match what ffmpeg will produce on the polish render.
//
// Why this matters: every polish run debits ~1500 ai_tokens and waits
// ~30s for an mp4. Tweaking music_volume by trial-and-render is brutal
// on credits. This component does the mix in-browser, free, instant.
//
// The fade-out is approximated by duck-ramping the gain when the video's
// remaining time crosses fade_secs.
export default function MusicMixPreview({ videoUrl, musicUrl, volume, fadeSecs, onChange, onChangeFade }) {
  const videoRef  = useRef(null)
  const audioRef  = useRef(null)
  const ctxRef    = useRef(null)
  const voiceGainRef = useRef(null)
  const musicGainRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState(null)

  // Init the WebAudio graph lazily on first play. Browsers refuse to
  // create an AudioContext before user gesture, so we don't spin one
  // up on mount.
  const ensureGraph = () => {
    if (ctxRef.current) return ctxRef.current
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext
      if (!Ctor) throw new Error('Web Audio not supported in this browser')
      const ctx = new Ctor()
      const v = videoRef.current
      const a = audioRef.current
      if (!v || !a) throw new Error('Media elements not ready')
      // CORS: source nodes need crossOrigin=anonymous on the elements
      // so the AudioContext can read their samples. Both Supabase
      // storage public URLs and Anthropic-side files set the right
      // headers; if they don't, we fall back to plain <video>/<audio>
      // playback (no mix preview).
      const voiceSrc = ctx.createMediaElementSource(v)
      const musicSrc = ctx.createMediaElementSource(a)
      const voiceGain = ctx.createGain()
      const musicGain = ctx.createGain()
      voiceGain.gain.value = 1
      musicGain.gain.value = volume
      voiceSrc.connect(voiceGain).connect(ctx.destination)
      musicSrc.connect(musicGain).connect(ctx.destination)
      ctxRef.current     = ctx
      voiceGainRef.current = voiceGain
      musicGainRef.current = musicGain
      return ctx
    } catch (e) {
      setError(e.message || 'Audio init failed')
      return null
    }
  }

  // Live-track the volume slider without re-initializing.
  useEffect(() => {
    if (musicGainRef.current) musicGainRef.current.gain.value = volume
  }, [volume])

  // Auto-pause when the video ends.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onEnded = () => { setPlaying(false); try { audioRef.current?.pause() } catch {} }
    v.addEventListener('ended', onEnded)
    return () => v.removeEventListener('ended', onEnded)
  }, [videoUrl])

  // Approximate the music fade-out: when the video's remaining time
  // drops below fade_secs, ramp musicGain to 0 over the remaining
  // window. ffmpeg does the real fade at render time; this mirrors it.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    let raf
    const tick = () => {
      const ctx = ctxRef.current
      const gain = musicGainRef.current
      if (ctx && gain && v.duration && !v.paused) {
        const remaining = v.duration - v.currentTime
        if (remaining > 0 && remaining < (fadeSecs || 0)) {
          const target = 0.0001  // not 0 — exponentialRampToValueAtTime hates exact zero
          gain.gain.cancelScheduledValues(ctx.currentTime)
          gain.gain.setValueAtTime(volume * (remaining / Math.max(0.05, fadeSecs)), ctx.currentTime)
          gain.gain.exponentialRampToValueAtTime(target, ctx.currentTime + remaining)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [volume, fadeSecs])

  const playPause = async () => {
    const ctx = ensureGraph()
    if (!ctx) return
    if (ctx.state === 'suspended') await ctx.resume()
    const v = videoRef.current
    const a = audioRef.current
    if (!v || !a) return
    if (playing) {
      v.pause(); a.pause()
      setPlaying(false)
    } else {
      // Sync — start music from current video time wrapped to music length
      const dur = a.duration || 0
      a.currentTime = dur > 0 ? (v.currentTime % dur) : 0
      try { await Promise.all([v.play(), a.play()]) } catch (e) { setError(e.message || 'Playback blocked') ; return }
      setPlaying(true)
    }
  }

  // No video upstream → no point rendering a player. Stay quiet; the
  // editor's other sections still work fine without it.
  if (!videoUrl) return null
  // No music yet → also stay quiet. The PolishMusicUpload component
  // above already handles the empty state with its own dropzone.
  if (!musicUrl) return null

  return (
    <div>
      <video
        ref={videoRef}
        src={videoUrl}
        crossOrigin="anonymous"
        playsInline
        muted={false}
        style={{ width: '100%', borderRadius: 8, marginBottom: 8, background: '#000' }}
      />
      <audio
        ref={audioRef}
        src={musicUrl}
        crossOrigin="anonymous"
        loop
        preload="auto"
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <button
          onClick={playPause}
          aria-label={playing ? 'Pause preview' : 'Play preview'}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 38, height: 38, borderRadius: 999,
            background: playing ? 'var(--surface-2)' : 'linear-gradient(135deg, var(--red), var(--red-dark))',
            color: playing ? 'var(--text)' : '#fff',
            border: 'none', cursor: 'pointer',
            boxShadow: playing ? 'none' : '0 4px 12px rgba(239,68,68,0.4)',
          }}
        >
          {playing ? <Pause size={15} /> : <Play size={15} style={{ marginLeft: 2 }} />}
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Volume2 size={11} /> Music volume
            </span>
            <span style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
              {Math.round(volume * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0} max={0.5} step={0.01}
            value={volume}
            onChange={(e) => onChange?.(Number(e.target.value))}
            style={{ width: '100%', accentColor: '#3b82f6' }}
          />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
        <span>Auto fade-out</span>
        <span style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{(fadeSecs ?? 1.5).toFixed(1)}s</span>
      </div>
      <input
        type="range" min={0} max={5} step={0.1}
        value={fadeSecs ?? 1.5}
        onChange={(e) => onChangeFade?.(Number(Number(e.target.value).toFixed(1)))}
        style={{ width: '100%', accentColor: '#3b82f6' }}
      />
      <div style={{ marginTop: 8, fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.4 }}>
        Live mix in your browser — no credits spent. The render uses the same volume + fade you land on here.
        {error && <> · <span style={{ color: 'var(--red)' }}>{error}</span></>}
      </div>
    </div>
  )
}

const hint = {
  padding: '10px 12px',
  borderRadius: 8,
  background: 'var(--surface-2)',
  border: '1px dashed var(--border)',
  fontSize: 11.5,
  color: 'var(--muted)',
  lineHeight: 1.4,
}
