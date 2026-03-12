import { useEffect, useRef, useState, useCallback } from 'react'
import BufferBar from './BufferBar.jsx'

const QUALITIES  = ['360p', '480p', '720p', '1080p']
const MAX_BUF    = 60
const RESERVOIR  = 10
const CUSHION_T  = 45

function bba(buf) {
  if (buf <= RESERVOIR) return { quality: '360p', zone: 'reservoir' }
  if (buf >= CUSHION_T) return { quality: '1080p', zone: 'upper_reservoir' }
  const r = (buf - RESERVOIR) / (CUSHION_T - RESERVOIR)
  return { quality: QUALITIES[Math.min(Math.floor(r * QUALITIES.length), QUALITIES.length - 1)], zone: 'cushion' }
}

export default function VideoPlayer({ session, video }) {
  const [playing,     setPlaying]     = useState(false)
  const [bufSeconds,  setBufSeconds]  = useState(0)
  const [zone,        setZone]        = useState('reservoir')
  const [quality,     setQuality]     = useState('360p')
  const [playhead,    setPlayhead]    = useState(0)
  const [priority,    setPriority]    = useState('video')
  const [prefetch,    setPrefetch]    = useState(null)
  const [recQuality,  setRecQuality]  = useState(null)
  const prefetchTriggered = useRef(false)

  const duration = session?.video_metadata?.duration || 900

  // Simulate buffer filling / draining
  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => {
      setBufSeconds(b => {
        const delta = Math.random() * 2.5 - 0.4   // net gain ~1s per tick
        return Math.max(0, Math.min(MAX_BUF, b + delta))
      })
      setPlayhead(p => Math.min(duration, p + 0.5))
    }, 500)
    return () => clearInterval(t)
  }, [playing, duration])

  // Derive zone & quality from buffer
  useEffect(() => {
    const { quality: q, zone: z } = bba(bufSeconds)
    setZone(z)
    setQuality(q)
    setPriority(bufSeconds < 5 ? 'audio' : 'video')
  }, [bufSeconds])

  // Report buffer to backend every 3s
  const report = useCallback(async () => {
    if (!session?.session_id) return
    try {
      const r = await fetch('/api/buffering/report', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id:             session.session_id,
          video_id:               video.id,
          current_buffer_seconds: bufSeconds,
          current_quality:        quality,
          playhead_position:      playhead,
          segments_buffered:      Array.from({ length: 5 }, (_, i) => Math.floor(playhead / 4) + i),
          download_speed_kbps:    2500,
        }),
      })
      const rec = await r.json()
      setRecQuality(rec.recommended_quality)
    } catch (_) {}
  }, [bufSeconds, quality, playhead, session, video])

  useEffect(() => {
    if (!playing) return
    const t = setInterval(report, 3000)
    return () => clearInterval(t)
  }, [playing, report])

  // Trigger next-episode prefetch at 90%
  useEffect(() => {
    if (!playing || prefetchTriggered.current) return
    if (playhead / duration >= 0.9) {
      prefetchTriggered.current = true
      fetch(`/api/prefetch/next-episode?currentVideoId=${video.id}&sessionId=${session.session_id}`)
        .then(r => r.json()).then(setPrefetch).catch(() => {})
    }
  }, [playhead, duration, playing, video, session])

  const zoneColor = { reservoir: '#e50914', cushion: '#f5a623', upper_reservoir: '#46d369' }

  return (
    <div style={{ padding: '32px 40px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24 }}>

        {/* Left: player + buffer bar */}
        <div>
          {/* Player screen */}
          <div
            onClick={() => setPlaying(p => !p)}
            style={{
              background: '#000', aspectRatio: '16/9', borderRadius: 8,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', position: 'relative', overflow: 'hidden',
              border: '1px solid #222',
            }}
          >
            <div style={{ textAlign: 'center', pointerEvents: 'none' }}>
              <div style={{ fontSize: 72 }}>{video.emoji || '🎬'}</div>
              <div style={{ color: '#aaa', marginTop: 8 }}>{video.title}</div>
              <div style={{ color: '#46d369', fontSize: 12, marginTop: 4 }}>
                {quality}  {priority === 'audio' ? '🔊 AUDIO PRIORITY' : ''}
              </div>
            </div>
            {!playing && (
              <div style={{
                position: 'absolute', inset: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(0,0,0,0.4)',
              }}>
                <div style={{
                  width: 72, height: 72, borderRadius: '50%',
                  background: 'rgba(255,255,255,0.15)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28,
                }}>▶</div>
              </div>
            )}
          </div>

          {/* Progress bar */}
          <div style={{ marginTop: 10, padding: '10px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#666', marginBottom: 6 }}>
              <span>{fmtTime(playhead)}</span>
              <span>{fmtTime(duration)}</span>
            </div>
            <div style={{ height: 4, background: '#333', borderRadius: 2 }}>
              <div style={{ height: '100%', background: '#e50914', borderRadius: 2,
                            width: `${(playhead / duration) * 100}%`, transition: 'width 0.5s' }} />
            </div>
          </div>

          <BufferBar bufferSeconds={bufSeconds} zone={zone} />

          {prefetch?.next_video_id && (
            <div style={{ marginTop: 12, padding: 12, background: '#0d1f0d',
                          border: '1px solid #46d369', borderRadius: 6, fontSize: 13, color: '#46d369' }}>
              ⚡ Preloading Episode {prefetch.next_video_id} — segments 0‑4 ({prefetch.quality})
            </div>
          )}
        </div>

        {/* Right: info panel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Panel title="Session">
            <Row label="ID"     value={session.session_id} />
            <Row label="Status" value={playing ? '▶ Playing' : '⏸ Paused'} />
          </Panel>

          <Panel title="CDN Node">
            {session.cdn_node ? (
              <>
                <Row label="Name"     value={session.cdn_node.name} />
                <Row label="Node ID"  value={session.cdn_node.id} />
              </>
            ) : (
              <div style={{ color: '#555', fontSize: 12 }}>Served from origin</div>
            )}
          </Panel>

          <Panel title="BBA Engine">
            <Row label="Buffer"   value={<span style={{ color: zoneColor[zone] }}>{bufSeconds.toFixed(1)}s</span>} />
            <Row label="Zone"     value={<span style={{ color: zoneColor[zone] }}>{zone}</span>} />
            <Row label="Quality"  value={<span style={{ color: '#46d369' }}>{quality}</span>} />
            <Row label="Priority" value={priority} />
            {recQuality && recQuality !== quality && (
              <Row label="Rec."   value={<span style={{ color: '#f5a623' }}>{recQuality}</span>} />
            )}
          </Panel>

          <Panel title="Algorithm Zones">
            <div style={{ fontSize: 11, color: '#555', lineHeight: 2 }}>
              <div><span style={{ color: '#e50914' }}>■</span> 0–10s → Reservoir → 360p</div>
              <div><span style={{ color: '#f5a623' }}>■</span> 10–45s → Cushion → linear</div>
              <div><span style={{ color: '#46d369' }}>■</span> 45–60s → Upper → 1080p</div>
            </div>
          </Panel>

          <Panel title="Manifest URL">
            <div style={{ fontSize: 11, color: '#555', wordBreak: 'break-all', lineHeight: 1.6 }}>
              {session.manifest_url}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}

function Panel({ title, children }) {
  return (
    <div style={{ background: '#1a1a1a', borderRadius: 8, padding: 14 }}>
      <div style={{ fontSize: 11, color: '#555', letterSpacing: 1, marginBottom: 10 }}>{title.toUpperCase()}</div>
      {children}
    </div>
  )
}

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7, fontSize: 13 }}>
      <span style={{ color: '#555' }}>{label}</span>
      <span>{value}</span>
    </div>
  )
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
