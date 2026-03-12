import { useEffect, useRef, useState, useCallback } from 'react'
import dashjs from 'dashjs'
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

// Network condition presets for demo (simulated throughput caps in kbps)
const NET_PRESETS = {
  good:    { label: 'Good (3 Mbps)',    cap: 3000,  color: '#46d369' },
  medium:  { label: 'Medium (800 kbps)', cap: 800,   color: '#f5a623' },
  poor:    { label: 'Poor (200 kbps)',   cap: 200,   color: '#e50914' },
  offline: { label: 'Offline (0)',       cap: 0,     color: '#ff0000' },
}

export default function VideoPlayer({ session, video }) {
  const videoRef  = useRef(null)
  const playerRef = useRef(null)
  const [playing,     setPlaying]     = useState(false)
  const [zone,        setZone]        = useState('reservoir')
  const [quality,     setQuality]     = useState('360p')
  const [playhead,    setPlayhead]    = useState(0)
  const [priority,    setPriority]    = useState('video')
  const [prefetch,    setPrefetch]    = useState(null)
  const [recQuality,  setRecQuality]  = useState(null)
  const [dashReady,   setDashReady]   = useState(false)
  const [netMode,     setNetMode]     = useState('good')
  const [simBuf,      setSimBuf]      = useState(0)  // simulated buffer for BBA demo
  const prefetchTriggered = useRef(false)

  const duration = session?.video_metadata?.duration || 900
  const preset = NET_PRESETS[netMode]

  // Initialize dash.js player with smaller buffer targets
  useEffect(() => {
    if (!videoRef.current || !session?.manifest_url) return

    const videoId = session.video_metadata?.id || video.id
    const manifestUrl = `/api/videos/${videoId}/manifest.mpd`

    const player = dashjs.MediaPlayer().create()
    player.initialize(videoRef.current, manifestUrl, false)
    player.updateSettings({
      streaming: {
        buffer: {
          fastSwitchEnabled: true,
          stableBufferTime: 12,
          bufferTimeAtTopQuality: 20,
          bufferTimeAtTopQualityLongForm: 20,
        },
        abr: {
          autoSwitchBitrate: { video: true, audio: true },
        },
      },
    })
    playerRef.current = player
    setDashReady(true)

    return () => {
      player.destroy()
      playerRef.current = null
    }
  }, [session, video])

  // Simulate buffer dynamics based on network preset
  // Real dash.js buffer fills too fast on localhost, so we simulate
  // a separate BBA buffer that drains/fills based on the selected network mode
  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => {
      setSimBuf(prev => {
        const capKbps = NET_PRESETS[netMode].cap
        // Simulate: each tick (500ms), we "download" some data and "consume" some
        // consumption = current quality bitrate worth of 0.5s
        const qualityBitrates = { '360p': 400, '480p': 800, '720p': 1500, '1080p': 3000 }
        const consumeRate = qualityBitrates[quality] || 800  // kbps being consumed
        const downloadSeconds = capKbps > 0 ? (capKbps / consumeRate) * 0.5 : 0
        const drainSeconds = 0.5  // we consume 0.5s of buffer per 0.5s tick
        const delta = downloadSeconds - drainSeconds
        return Math.max(0, Math.min(MAX_BUF, prev + delta))
      })
    }, 500)
    return () => clearInterval(t)
  }, [playing, netMode, quality])

  // Poll real playhead from dash.js
  useEffect(() => {
    if (!dashReady) return
    const t = setInterval(() => {
      const player = playerRef.current
      if (!player) return
      try {
        const time = player.time() || 0
        setPlayhead(time)
        setPlaying(!videoRef.current?.paused)
      } catch (_) {}
    }, 500)
    return () => clearInterval(t)
  }, [dashReady])

  // Derive zone & quality from simulated buffer using BBA
  useEffect(() => {
    const { quality: q, zone: z } = bba(simBuf)
    setZone(z)
    setQuality(q)
    setPriority(simBuf < 5 ? 'audio' : 'video')
  }, [simBuf])

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
          current_buffer_seconds: simBuf,
          current_quality:        quality,
          playhead_position:      playhead,
          segments_buffered:      Array.from({ length: 5 }, (_, i) => Math.floor(playhead / 4) + i),
          download_speed_kbps:    preset.cap,
        }),
      })
      const rec = await r.json()
      setRecQuality(rec.recommended_quality)
    } catch (_) {}
  }, [simBuf, quality, playhead, session, video, preset])

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

  const handlePlayPause = () => {
    if (!videoRef.current) return
    if (videoRef.current.paused) {
      videoRef.current.play()
      // Kickstart simulated buffer when first playing
      if (simBuf === 0) setSimBuf(2)
    } else {
      videoRef.current.pause()
    }
  }

  const zoneColor = { reservoir: '#e50914', cushion: '#f5a623', upper_reservoir: '#46d369' }

  return (
    <div style={{ padding: '32px 40px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24 }}>

        {/* Left: player + buffer bar */}
        <div>
          {/* Real video player */}
          <div style={{ position: 'relative', borderRadius: 8, overflow: 'hidden', border: '1px solid #222', background: '#000' }}>
            <video
              ref={videoRef}
              style={{ width: '100%', aspectRatio: '16/9', display: 'block', background: '#000' }}
              onClick={handlePlayPause}
            />
            <div style={{
              position: 'absolute', top: 10, right: 10, padding: '4px 10px',
              background: 'rgba(0,0,0,0.7)', borderRadius: 4, fontSize: 12,
              color: zoneColor[zone],
            }}>
              {quality} {priority === 'audio' ? ' | AUDIO PRIORITY' : ''}
            </div>
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

          <BufferBar bufferSeconds={simBuf} zone={zone} />

          {/* Network Simulator Controls */}
          <div style={{ marginTop: 14, padding: 14, background: '#1a1a1a', borderRadius: 8 }}>
            <div style={{ fontSize: 11, color: '#555', letterSpacing: 1, marginBottom: 10 }}>
              NETWORK SIMULATOR
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {Object.entries(NET_PRESETS).map(([key, p]) => (
                <button
                  key={key}
                  onClick={() => setNetMode(key)}
                  style={{
                    padding: '6px 14px', borderRadius: 4, fontSize: 12, cursor: 'pointer',
                    border: netMode === key ? `2px solid ${p.color}` : '2px solid #333',
                    background: netMode === key ? `${p.color}22` : '#111',
                    color: netMode === key ? p.color : '#666',
                    fontWeight: netMode === key ? 700 : 400,
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: '#555' }}>
              Simulated throughput: <span style={{ color: preset.color, fontWeight: 600 }}>{preset.cap} kbps</span>
              {' '} — switch to see BBA adapt quality in real-time
            </div>
          </div>

          {prefetch?.next_video_id && (
            <div style={{ marginTop: 12, padding: 12, background: '#0d1f0d',
                          border: '1px solid #46d369', borderRadius: 6, fontSize: 13, color: '#46d369' }}>
              Preloading Episode {prefetch.next_video_id} -- segments 0-4 ({prefetch.quality})
            </div>
          )}
        </div>

        {/* Right: info panel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Panel title="Session">
            <Row label="ID"     value={session.session_id} />
            <Row label="Status" value={playing ? 'Playing' : 'Paused'} />
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
            <Row label="Buffer"   value={<span style={{ color: zoneColor[zone] }}>{simBuf.toFixed(1)}s</span>} />
            <Row label="Zone"     value={<span style={{ color: zoneColor[zone] }}>{zone}</span>} />
            <Row label="Quality"  value={<span style={{ color: '#46d369' }}>{quality}</span>} />
            <Row label="Priority" value={priority} />
            <Row label="Network"  value={<span style={{ color: preset.color }}>{preset.cap} kbps</span>} />
            {recQuality && recQuality !== quality && (
              <Row label="Rec."   value={<span style={{ color: '#f5a623' }}>{recQuality}</span>} />
            )}
          </Panel>

          <Panel title="Algorithm Zones">
            <div style={{ fontSize: 11, color: '#555', lineHeight: 2 }}>
              <div><span style={{ color: '#e50914' }}>|</span> 0-10s = Reservoir = 360p</div>
              <div><span style={{ color: '#f5a623' }}>|</span> 10-45s = Cushion = linear</div>
              <div><span style={{ color: '#46d369' }}>|</span> 45-60s = Upper = 1080p</div>
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
