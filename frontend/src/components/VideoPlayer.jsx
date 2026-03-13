import { useEffect, useRef, useState, useCallback } from 'react'
import dashjs from 'dashjs'
import BufferBar from './BufferBar.jsx'

const QUALITIES  = ['320p', '480p', '720p']
const MAX_BUF    = 60
const RESERVOIR  = 10
const CUSHION_T  = 45

function bba(buf) {
  if (buf <= RESERVOIR) return { quality: '320p', zone: 'reservoir' }
  if (buf >= CUSHION_T) return { quality: '720p', zone: 'upper_reservoir' }
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

export default function VideoPlayer({ session, video, user, token }) {
  const videoRef  = useRef(null)
  const playerRef = useRef(null)
  const resumeAppliedRef = useRef(false)
  const lastProgressSavedAtRef = useRef(0)
  const [playing,     setPlaying]     = useState(false)
  const [muted,       setMuted]       = useState(false)
  const [volume,      setVolume]      = useState(1)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [durationReal, setDurationReal] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [autoplayBlocked, setAutoplayBlocked] = useState(false)
  const [zone,        setZone]        = useState('reservoir')
  const [quality,     setQuality]     = useState('320p')
  const [playhead,    setPlayhead]    = useState(0)
  const [priority,    setPriority]    = useState('video')
  const [prefetch,    setPrefetch]    = useState(null)
  const [recQuality,  setRecQuality]  = useState(null)
  const [dashReady,   setDashReady]   = useState(false)
  const [netMode,     setNetMode]     = useState('good')
  const [simBuf,      setSimBuf]      = useState(0)  // simulated buffer for BBA demo
  const prefetchTriggered = useRef(false)

  const duration = Math.max(session?.video_metadata?.duration || 0, durationReal || 0, 1)
  const preset = NET_PRESETS[netMode]

  // Initialize dash.js player with smaller buffer targets
  useEffect(() => {
    if (!videoRef.current || !session?.manifest_url) return

    const videoId = session.video_metadata?.id || video.id
    const manifestUrl = `/api/videos/${videoId}/manifest.mpd`

    const player = dashjs.MediaPlayer().create()
    player.initialize(videoRef.current, manifestUrl, true)
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

    const element = videoRef.current
    element.volume = volume
    element.muted = muted
    element.playbackRate = playbackRate

    const tryAutoplay = async () => {
      try {
        await element.play()
        setPlaying(true)
        setAutoplayBlocked(false)
        if (simBuf === 0) setSimBuf(2)
      } catch {
        setAutoplayBlocked(true)
      }
    }

    tryAutoplay()
    playerRef.current = player
    setDashReady(true)

    return () => {
      player.destroy()
      playerRef.current = null
    }
  }, [session, video])

  useEffect(() => {
    resumeAppliedRef.current = false
  }, [session?.session_id])

  useEffect(() => {
    const el = videoRef.current
    const resume = Number(session?.resume_position_seconds || 0)
    if (!el || resume <= 0 || resumeAppliedRef.current === true) return

    const applyResume = () => {
      if (resumeAppliedRef.current) return
      const cap = Number.isFinite(el.duration) && el.duration > 0 ? Math.max(0, el.duration - 1) : resume
      const next = Math.max(0, Math.min(resume, cap))
      el.currentTime = next
      setPlayhead(next)
      resumeAppliedRef.current = true
    }

    if (el.readyState >= 1) {
      applyResume()
      return
    }

    el.addEventListener('loadedmetadata', applyResume, { once: true })
    return () => el.removeEventListener('loadedmetadata', applyResume)
  }, [session?.resume_position_seconds, dashReady])

  useEffect(() => {
    if (!videoRef.current) return
    videoRef.current.volume = volume
    videoRef.current.muted = muted
  }, [volume, muted])

  useEffect(() => {
    if (!videoRef.current) return
    videoRef.current.playbackRate = playbackRate
  }, [playbackRate])

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      if (!videoRef.current) return

      if (e.key === ' ' || e.key.toLowerCase() === 'k') {
        e.preventDefault()
        handlePlayPause()
      } else if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'l') {
        e.preventDefault()
        seekBy(10)
      } else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'j') {
        e.preventDefault()
        seekBy(-10)
      } else if (e.key.toLowerCase() === 'm') {
        e.preventDefault()
        setMuted(v => !v)
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault()
        toggleFullscreen()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [playing])

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
        const qualityBitrates = { '320p': 250, '480p': 800, '720p': 1500 }
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

  const savePlaybackProgress = useCallback(async (force = false) => {
    if (!session?.session_id || !video?.id || !user?.username || !token) return
    const now = Date.now()
    if (!force && now - lastProgressSavedAtRef.current < 10000) return
    lastProgressSavedAtRef.current = now

    try {
      await fetch('/api/playback/progress', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          session_id: session.session_id,
          video_id: video.id,
          playhead_position: playhead,
        }),
      })
    } catch (_) {}
  }, [session?.session_id, video?.id, user?.username, token, playhead])

  useEffect(() => {
    if (!playing) return
    const t = setInterval(report, 3000)
    return () => clearInterval(t)
  }, [playing, report])

  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => {
      savePlaybackProgress(false)
    }, 10000)
    return () => clearInterval(t)
  }, [playing, savePlaybackProgress])

  useEffect(() => {
    if (playing) return
    savePlaybackProgress(true)
  }, [playing, savePlaybackProgress])

  useEffect(() => {
    return () => {
      savePlaybackProgress(true)
      if (session?.session_id) {
        fetch(`/api/playback/end?session_id=${encodeURIComponent(session.session_id)}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }).catch(() => {})
      }
    }
  }, [savePlaybackProgress, session?.session_id, token])

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
      videoRef.current.play().then(() => {
        setAutoplayBlocked(false)
        if (simBuf === 0) setSimBuf(2)
      }).catch(() => setAutoplayBlocked(true))
    } else {
      videoRef.current.pause()
    }
  }

  const seekBy = (seconds) => {
    if (!videoRef.current) return
    const next = Math.max(0, Math.min(duration, (videoRef.current.currentTime || 0) + seconds))
    videoRef.current.currentTime = next
    setPlayhead(next)
  }

  const seekToPercent = (evt) => {
    if (!videoRef.current || !duration) return
    const rect = evt.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width))
    const next = ratio * duration
    videoRef.current.currentTime = next
    setPlayhead(next)
  }

  const toggleFullscreen = async () => {
    const container = document.getElementById('player-shell')
    if (!container) return
    if (!document.fullscreenElement) {
      await container.requestFullscreen?.()
    } else {
      await document.exitFullscreen?.()
    }
  }

  const zoneColor = { reservoir: '#e50914', cushion: '#f5a623', upper_reservoir: '#46d369' }

  return (
    <div style={{ padding: '32px 40px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24 }}>

        {/* Left: player + buffer bar */}
        <div>
          {/* Real video player */}
          <div id="player-shell" style={{ position: 'relative', borderRadius: 8, overflow: 'hidden', border: '1px solid #222', background: '#000' }}>
            <video
              ref={videoRef}
              style={{ width: '100%', aspectRatio: '16/9', display: 'block', background: '#000' }}
              onLoadedMetadata={() => setDurationReal(videoRef.current?.duration || 0)}
              onClick={handlePlayPause}
            />

            {autoplayBlocked && (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(0,0,0,0.45)',
              }}>
                <button
                  onClick={handlePlayPause}
                  style={{ background: '#e50914', color: '#fff', border: 'none', borderRadius: 999, padding: '12px 22px', fontWeight: 700, cursor: 'pointer' }}
                >
                  ▶ Play
                </button>
              </div>
            )}

            <div style={{
              position: 'absolute', top: 10, right: 10, padding: '4px 10px',
              background: 'rgba(0,0,0,0.7)', borderRadius: 4, fontSize: 12,
              color: zoneColor[zone],
            }}>
              {quality} {priority === 'audio' ? ' | AUDIO PRIORITY' : ''}
            </div>

            <div style={{
              position: 'absolute', left: 12, right: 12, bottom: 12,
              background: 'linear-gradient(to top, rgba(0,0,0,0.8), rgba(0,0,0,0.1))',
              borderRadius: 8, padding: 10,
            }}>
              <div
                onClick={seekToPercent}
                style={{ height: 6, background: '#505050', borderRadius: 99, cursor: 'pointer', marginBottom: 10 }}
              >
                <div style={{ height: '100%', width: `${(playhead / duration) * 100}%`, borderRadius: 99, background: '#e50914' }} />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#fff' }}>
                <CtlBtn onClick={handlePlayPause}>{playing ? '❚❚' : '▶'}</CtlBtn>
                <CtlBtn onClick={() => seekBy(-10)}>↺ 10</CtlBtn>
                <CtlBtn onClick={() => seekBy(10)}>10 ↻</CtlBtn>
                <CtlBtn onClick={() => setMuted(v => !v)}>{muted || volume === 0 ? '🔇' : '🔊'}</CtlBtn>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={muted ? 0 : volume}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    setVolume(v)
                    if (muted && v > 0) setMuted(false)
                  }}
                  style={{ width: 90 }}
                />

                <span style={{ marginLeft: 6, fontSize: 12, color: '#d0d0d0' }}>{fmtTime(playhead)} / {fmtTime(duration)}</span>

                <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select
                    value={playbackRate}
                    onChange={(e) => setPlaybackRate(Number(e.target.value))}
                    style={{ background: '#1a1a1a', color: '#fff', border: '1px solid #444', borderRadius: 4, padding: '4px 6px', fontSize: 12 }}
                  >
                    {[0.5, 0.75, 1, 1.25, 1.5, 2].map(r => (
                      <option key={r} value={r}>{r}x</option>
                    ))}
                  </select>
                  <CtlBtn onClick={toggleFullscreen}>{isFullscreen ? '⤢' : '⛶'}</CtlBtn>
                </div>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 12, padding: '8px 2px 2px' }}>
            <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 0.2 }}>{video?.title || 'Now Playing'}</div>
            <div style={{ marginTop: 6, color: '#b0b0b0', fontSize: 14, lineHeight: 1.6 }}>
              {video?.description || video?.subtitle || 'No description available.'}
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
              <div><span style={{ color: '#e50914' }}>|</span> 0-10s = Reservoir = 320p</div>
              <div><span style={{ color: '#f5a623' }}>|</span> 10-45s = Cushion = linear</div>
              <div><span style={{ color: '#46d369' }}>|</span> 45-60s = Upper = 720p</div>
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

function CtlBtn({ children, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'rgba(255,255,255,0.12)',
        color: '#fff',
        border: '1px solid rgba(255,255,255,0.25)',
        borderRadius: 6,
        padding: '5px 9px',
        cursor: 'pointer',
        fontSize: 12,
      }}
    >
      {children}
    </button>
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
