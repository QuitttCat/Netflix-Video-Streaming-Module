import { useEffect, useRef, useState, useCallback } from 'react'
import dashjs from 'dashjs'
import { FaCompress, FaExpand, FaPause, FaPlay, FaVolumeMute, FaVolumeUp } from 'react-icons/fa'
import { MdOutlineForward10, MdOutlineReplay10 } from 'react-icons/md'
import BufferBar from './BufferBar.jsx'

const QUALITIES = ['360p', '480p', '720p', '1080p']
const MAX_BUF = 60
const RESERVOIR = 10
const CUSHION_T = 45

function bba(buf) {
  if (buf <= RESERVOIR) return { quality: '360p', zone: 'reservoir' }
  if (buf >= CUSHION_T) return { quality: '1080p', zone: 'upper_reservoir' }
  const r = (buf - RESERVOIR) / (CUSHION_T - RESERVOIR)
  return { quality: QUALITIES[Math.min(Math.floor(r * QUALITIES.length), QUALITIES.length - 1)], zone: 'cushion' }
}

// Network condition presets for demo (simulated throughput caps in kbps)
const NET_PRESETS = {
  good: { label: 'Good (3 Mbps)', cap: 3000, color: '#46d369' },
  medium: { label: 'Medium (800 kbps)', cap: 800, color: '#f5a623' },
  poor: { label: 'Poor (200 kbps)', cap: 200, color: '#e50914' },
  offline: { label: 'Offline (0)', cap: 0, color: '#ff0000' },
}

const LANGUAGE_LABELS = {
  chi: 'Chinese',
  eng: 'English',
  fre: 'French',
  hin: 'Hindi',
  ind: 'Indonesian',
  jpn: 'Japanese',
  kor: 'Korean',
  por: 'Portuguese',
  rus: 'Russian',
  spa: 'Spanish',
  tha: 'Thai',
}

function normalizeLanguage(value) {
  return String(value || '').trim().toLowerCase()
}

function trackLabel(track) {
  const language = normalizeLanguage(track?.language || track?.lang)
  return track?.label || LANGUAGE_LABELS[language] || (language ? language.toUpperCase() : 'Unknown')
}

function pickDefaultSubtitleTrack(tracks) {
  const defaults = tracks.filter(track => track.is_default)
  return defaults.find(track => normalizeLanguage(track.language) === 'eng') || defaults[0] || null
}

export default function VideoPlayer({ session, video, user, token, onPlayNextEpisode }) {
  const videoRef = useRef(null)
  const playerRef = useRef(null)
  const resumeAppliedRef = useRef(false)
  const lastProgressSavedAtRef = useRef(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [durationReal, setDurationReal] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [autoplayBlocked, setAutoplayBlocked] = useState(false)
  const [zone, setZone] = useState('reservoir')
  const [quality, setQuality] = useState('360p')
  const [playhead, setPlayhead] = useState(0)
  const [priority, setPriority] = useState('video')
  const [prefetch, setPrefetch] = useState(null)
  const [prefetchStatus, setPrefetchStatus] = useState(null)
  const [prefetchPolling, setPrefetchPolling] = useState(false)
  const [recQuality, setRecQuality] = useState(null)
  const [dashReady, setDashReady] = useState(false)
  const [netMode, setNetMode] = useState('good')
  const [simBuf, setSimBuf] = useState(0)  // simulated buffer for BBA demo
  const [autoNextCountdown, setAutoNextCountdown] = useState(null)
  const [audioOptions, setAudioOptions] = useState([])
  const [selectedAudioIndex, setSelectedAudioIndex] = useState('')
  const [selectedSubtitleUrl, setSelectedSubtitleUrl] = useState('off')
  const prefetchTriggered = useRef(false)
  const autoNextCancelledRef = useRef(false)
  const audioInitDoneRef = useRef(false)
  const metadataAudioTracksRef = useRef([])
  const [controlsVisible, setControlsVisible] = useState(true)
  const idleTimerRef = useRef(null)

  const currentVideoId =
    session?.video_metadata?.id ||
    video?.id
  const nextEpisode = session?.video_metadata?.next_episode || null
  const trackMetadata = Array.isArray(session?.video_metadata?.tracks)
    ? session.video_metadata.tracks
    : Array.isArray(video?.tracks)
      ? video.tracks
      : []
  const metadataAudioTracks = trackMetadata.filter(track => track.track_type === 'audio')
  metadataAudioTracksRef.current = metadataAudioTracks
  const subtitleTracks = trackMetadata
    .filter(track => track.track_type === 'subtitle')
    .map((track, index) => ({
      ...track,
      source_url: track.source_url || `/api/videos/${currentVideoId}/subtitle_${track.subtitle_index ?? index}.vtt`,
    }))

  const duration = Math.max(session?.video_metadata?.duration || 0, durationReal || 0, 1)
  const knownDuration = Math.max(session?.video_metadata?.duration || 0, durationReal || 0)
  const preset = NET_PRESETS[netMode]
  const watchedPercent = Math.max(0, Math.min(100, Math.round((playhead / duration) * 100)))
  const prefetchTriggerProgress = Math.max(0, Math.min(100, Math.round((playhead / duration) / 0.9 * 100)))
  const prefetchUiStatus = prefetchStatus || {
    running: false,
    done: false,
    progress_percent: 0,
    completed_steps: 0,
    total_steps: 0,
    message: playing
      ? `Waiting to reach 90% watch progress before next-episode preloading starts (${watchedPercent}% watched).`
      : 'Preloading status idle. Start playback to enable next-episode preloading.',
  }
  const prefetchNextEpisode = prefetchUiStatus.next_episode || prefetch?.next_episode || nextEpisode
  const prefetchLabel = prefetchNextEpisode?.episode_number
    ? `Season ${prefetchNextEpisode.season_number} • Episode ${prefetchNextEpisode.episode_number}`
    : prefetchUiStatus.next_video_id
      ? `Video ${prefetchUiStatus.next_video_id}`
      : ''
  const prefetchCompleteLabel = prefetchNextEpisode?.episode_number
    ? `Episode ${prefetchNextEpisode.episode_number}${prefetchNextEpisode.title ? `: ${prefetchNextEpisode.title}` : ''}`
    : prefetch?.next_video_id
      ? `Video ${prefetch.next_video_id}`
      : 'the next video'

  // Initialize dash.js player with smaller buffer targets
  useEffect(() => {
    if (!videoRef.current || !session?.manifest_url) return

    const manifestUrl = session.manifest_url

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
    // Populate the audio dropdown and apply the default track exactly once per stream load.
    // We use a ref for the metadata so this closure never goes stale without being in deps.
    const handleStreamInitialized = () => {
      const dashTracks = player.getTracksFor?.('audio') || []
      if (!dashTracks.length) return

      const options = dashTracks.map((t, i) => {
        const lang = normalizeLanguage(t.lang || t.language)
        const meta = metadataAudioTracksRef.current.find(m => normalizeLanguage(m.language) === lang)
        return {
          index: String(i),
          label: meta?.label || LANGUAGE_LABELS[lang] || (lang ? lang.toUpperCase() : `Track ${i + 1}`),
          language: lang,
          is_default: Boolean(meta?.is_default),
        }
      })
      setAudioOptions(options)

      // Apply the default track once — never on subsequent TRACK_CHANGE_RENDERED callbacks
      if (!audioInitDoneRef.current) {
        audioInitDoneRef.current = true
        const defaultOpt = options.find(o => o.is_default) || options[0]
        if (defaultOpt) {
          setSelectedAudioIndex(defaultOpt.index)
          const defaultTrack = dashTracks[Number(defaultOpt.index)]
          if (defaultTrack) player.setCurrentTrack(defaultTrack)
        }
      }
    }

    // Only mirror what dash.js has selected into the UI — never calls setCurrentTrack (no oscillation)
    const handleTrackChangeRendered = () => {
      const dashTracks = player.getTracksFor?.('audio') || []
      const current = player.getCurrentTrackFor?.('audio')
      if (!current || !dashTracks.length) return
      const currentLang = normalizeLanguage(current.lang || current.language)
      const currentIdx = dashTracks.findIndex(t => normalizeLanguage(t.lang || t.language) === currentLang)
      if (currentIdx >= 0) setSelectedAudioIndex(String(currentIdx))
    }

    player.on?.(dashjs.MediaPlayer.events.STREAM_INITIALIZED, handleStreamInitialized)
    player.on?.(dashjs.MediaPlayer.events.TRACK_CHANGE_RENDERED, handleTrackChangeRendered)

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
      audioInitDoneRef.current = false
      player.destroy()
      playerRef.current = null
    }
  }, [session, video])

  useEffect(() => {
    resumeAppliedRef.current = false
  }, [session?.session_id])

  useEffect(() => {
    prefetchTriggered.current = false
    setPrefetch(null)
    setPrefetchStatus(null)
    setPrefetchPolling(false)
    setAutoNextCountdown(null)
    setAudioOptions([])
    setSelectedAudioIndex('')
    setSelectedSubtitleUrl('off')
    autoNextCancelledRef.current = false
  }, [session?.session_id])

  useEffect(() => {
    const defaultSubtitleTrack = pickDefaultSubtitleTrack(subtitleTracks)
    setSelectedSubtitleUrl(defaultSubtitleTrack?.source_url || 'off')
  }, [session?.session_id])

  useEffect(() => {
    const element = videoRef.current
    if (!element) return
    const intervalIds = []

    const raiseSubtitleCues = (track) => {
      if (!track?.cues) return
      for (let i = 0; i < track.cues.length; i += 1) {
        const cue = track.cues[i]
        if (cue && 'line' in cue) {
          cue.line = -3
        }
      }
    }

    const syncSubtitleTracks = () => {
      const textTracks = element.textTracks
      for (let index = 0; index < textTracks.length; index += 1) {
        textTracks[index].mode = 'disabled'
      }

      if (selectedSubtitleUrl === 'off') return

      const selectedIndex = subtitleTracks.findIndex(track => track.source_url === selectedSubtitleUrl)
      if (selectedIndex >= 0 && textTracks[selectedIndex]) {
        const selectedTrack = textTracks[selectedIndex]
        selectedTrack.mode = 'showing'

        // Cues may arrive shortly after enabling the track; retry briefly.
        let attempts = 0
        const maxAttempts = 10
        const intervalId = window.setInterval(() => {
          raiseSubtitleCues(selectedTrack)
          attempts += 1
          if (attempts >= maxAttempts || (selectedTrack.cues && selectedTrack.cues.length > 0)) {
            window.clearInterval(intervalId)
          }
        }, 200)
        intervalIds.push(intervalId)
      }
    }

    const timer = window.setTimeout(syncSubtitleTracks, 0)
    element.addEventListener('loadedmetadata', syncSubtitleTracks)
    return () => {
      window.clearTimeout(timer)
      intervalIds.forEach(id => window.clearInterval(id))
      element.removeEventListener('loadedmetadata', syncSubtitleTracks)
    }
  }, [selectedSubtitleUrl, subtitleTracks, session?.session_id])

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
      } catch (_) { }
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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: session.session_id,
          video_id: video.id,
          current_buffer_seconds: simBuf,
          current_quality: quality,
          playhead_position: playhead,
          segments_buffered: Array.from({ length: 5 }, (_, i) => Math.floor(playhead / 4) + i),
          download_speed_kbps: preset.cap,
        }),
      })
      const rec = await r.json()
      setRecQuality(rec.recommended_quality)
    } catch (_) { }
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
    } catch (_) { }
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
        }).catch(() => { })
      }
    }
  }, [savePlaybackProgress, session?.session_id, token])

  // Trigger next-episode prefetch at 90%
  useEffect(() => {
    if (!playing || prefetchTriggered.current || !currentVideoId || !session?.session_id) return
    if (!knownDuration || knownDuration <= 0) return
    if (playhead / knownDuration >= 0.9) {
      prefetchTriggered.current = true
      fetch(
        `/api/prefetch/next-episode?currentVideoId=${currentVideoId}&sessionId=${session.session_id}` +
        `&playheadSeconds=${encodeURIComponent(playhead)}&durationSeconds=${encodeURIComponent(knownDuration)}`
      )
        .then(r => r.json())
        .then((payload) => {
          setPrefetch(payload)
          setPrefetchStatus(payload)
          if (payload?.should_start_prefetch) {
            setPrefetchPolling(true)
          }
        })
        .catch(() => {
          setPrefetchStatus({
            done: true,
            running: false,
            progress_percent: 0,
            message: 'Prefetch request failed',
          })
        })
    }
  }, [playhead, knownDuration, playing, currentVideoId, session?.session_id])

  useEffect(() => {
    if (!prefetchPolling || !session?.session_id || !currentVideoId) return
    const t = setInterval(async () => {
      try {
        const r = await fetch(
          `/api/prefetch/status?sessionId=${session.session_id}&currentVideoId=${currentVideoId}`
        )
        const payload = await r.json()
        setPrefetchStatus(payload)
        if (payload?.done || payload?.running === false) {
          setPrefetchPolling(false)
        }
      } catch (_) {
        setPrefetchPolling(false)
      }
    }, 1000)
    return () => clearInterval(t)
  }, [prefetchPolling, session?.session_id, currentVideoId])

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

  const canPlayNextEpisode = !!(nextEpisode?.video_id || session?.video_metadata?.next_episode_id)

  const handlePlayNextEpisode = async () => {
    if (!canPlayNextEpisode || !onPlayNextEpisode) return
    await onPlayNextEpisode(nextEpisode || session.video_metadata.next_episode_id)
  }

  const handleAudioTrackChange = (event) => {
    const nextIndex = event.target.value
    setSelectedAudioIndex(nextIndex)

    const player = playerRef.current
    if (!player?.getTracksFor || !player.setCurrentTrack) return

    const dashTracks = player.getTracksFor('audio') || []
    const selectedTrack = dashTracks[Number(nextIndex)]
    if (selectedTrack) {
      player.setCurrentTrack(selectedTrack)
    }
  }

  const handleSubtitleTrackChange = (event) => {
    setSelectedSubtitleUrl(event.target.value)
  }

  useEffect(() => {
    if (autoNextCountdown === null) return
    if (autoNextCountdown <= 0) return

    const t = window.setTimeout(() => {
      setAutoNextCountdown(current => {
        if (current === null) return null
        if (current <= 1) {
          if (!autoNextCancelledRef.current && canPlayNextEpisode && onPlayNextEpisode) {
            onPlayNextEpisode(nextEpisode || session.video_metadata.next_episode_id)
          }
          return null
        }
        return current - 1
      })
    }, 1000)

    return () => window.clearTimeout(t)
  }, [autoNextCountdown, canPlayNextEpisode, nextEpisode, onPlayNextEpisode, session?.video_metadata?.next_episode_id])

  const handleVideoEnded = () => {
    if (!canPlayNextEpisode || !onPlayNextEpisode) return
    if (autoNextCancelledRef.current) return
    setAutoNextCountdown(10)
  }

  const cancelAutoNextEpisode = () => {
    autoNextCancelledRef.current = true
    setAutoNextCountdown(null)
  }

  const resetIdleTimer = useCallback(() => {
    setControlsVisible(true)
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current)
    idleTimerRef.current = window.setTimeout(() => {
      if (!videoRef.current?.paused) setControlsVisible(false)
    }, 3000)
  }, [])

  // Always show controls while paused
  useEffect(() => {
    if (!playing) {
      setControlsVisible(true)
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current)
    }
  }, [playing])

  const zoneColor = { reservoir: '#e50914', cushion: '#f5a623', upper_reservoir: '#46d369' }

  return (
    <div style={{ padding: '32px 40px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24 }}>

        {/* Left: player + buffer bar */}
        <div>
          {/* Real video player */}
          <div
            id="player-shell"
            onMouseMove={resetIdleTimer}
            onMouseEnter={resetIdleTimer}
            onMouseLeave={() => { if (playing) setControlsVisible(false) }}
            style={{ position: 'relative', borderRadius: 8, overflow: 'hidden', border: '1px solid #222', background: '#000', cursor: controlsVisible ? 'default' : 'none' }}
          >
            <video
              ref={videoRef}
              className="nf-player"
              style={{ width: '100%', aspectRatio: '16/9', display: 'block', background: '#000' }}
              onLoadedMetadata={() => setDurationReal(videoRef.current?.duration || 0)}
              onClick={handlePlayPause}
              onEnded={handleVideoEnded}
            >
              {subtitleTracks.map((track) => (
                <track
                  key={track.source_url}
                  kind="subtitles"
                  src={track.source_url}
                  srcLang={normalizeLanguage(track.language) || 'und'}
                  label={trackLabel(track)}
                  default={track.source_url === selectedSubtitleUrl}
                />
              ))}
            </video>

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

            {autoNextCountdown !== null && canPlayNextEpisode && (
              <div style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                zIndex: 3,
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                flexWrap: 'wrap',
                background: 'rgba(0,0,0,0.72)',
                border: '1px solid #4a3a18',
                borderRadius: 8,
                padding: '8px 10px',
              }} role="status" aria-live="polite">
                <span style={{ fontSize: 13, color: '#f5a623', fontWeight: 700 }}>
                  Next episode in {autoNextCountdown}s
                </span>
                <button
                  onClick={cancelAutoNextEpisode}
                  style={{
                    background: '#2b2b2b',
                    border: '1px solid #555',
                    color: '#fff',
                    borderRadius: 6,
                    padding: '6px 10px',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Cancel Next Episode
                </button>
              </div>
            )}

            <div style={{
              position: 'absolute', top: 10, right: 10, padding: '4px 10px',
              background: 'rgba(0,0,0,0.7)', borderRadius: 4, fontSize: 12,
              color: zoneColor[zone],
              opacity: controlsVisible ? 1 : 0,
              transition: 'opacity 0.3s ease',
              pointerEvents: controlsVisible ? 'auto' : 'none',
            }}>
              {quality} {priority === 'audio' ? ' | AUDIO PRIORITY' : ''}
            </div>

            <div style={{
              position: 'absolute', left: 12, right: 12, bottom: 12,
              background: 'linear-gradient(to top, rgba(0,0,0,0.8), rgba(0,0,0,0.1))',
              borderRadius: 8, padding: 10,
              opacity: controlsVisible ? 1 : 0,
              transition: 'opacity 0.3s ease',
              pointerEvents: controlsVisible ? 'auto' : 'none',
            }}>
              <div
                onClick={seekToPercent}
                style={{ height: 6, background: '#505050', borderRadius: 99, cursor: 'pointer', marginBottom: 10 }}
              >
                <div style={{ height: '100%', width: `${(playhead / duration) * 100}%`, borderRadius: 99, background: '#e50914' }} />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#fff' }}>
                <CtlBtn onClick={handlePlayPause} ariaLabel={playing ? 'Pause' : 'Play'}>
                  {playing ? <FaPause size={13} /> : <FaPlay size={13} style={{ marginLeft: 2 }} />}
                </CtlBtn>
                <CtlBtn onClick={() => seekBy(-10)} ariaLabel="Back 10 seconds">
                  <MdOutlineReplay10 size={25} color="#fff" />
                </CtlBtn>
                <CtlBtn onClick={() => seekBy(10)} ariaLabel="Forward 10 seconds">
                  <MdOutlineForward10 size={25} color="#fff" />
                </CtlBtn>
                <CtlBtn onClick={() => setMuted(v => !v)} ariaLabel={muted || volume === 0 ? 'Unmute' : 'Mute'}>
                  {muted || volume === 0 ? <FaVolumeMute size={13} /> : <FaVolumeUp size={13} />}
                </CtlBtn>
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
                    value={selectedAudioIndex}
                    onChange={handleAudioTrackChange}
                    disabled={audioOptions.length === 0}
                    title="Audio track"
                    style={{ background: '#1a1a1a', color: '#fff', border: '1px solid #444', borderRadius: 4, padding: '4px 6px', fontSize: 12, maxWidth: 140 }}
                  >
                    {audioOptions.length === 0 && (
                      <option value="">Audio</option>
                    )}
                    {audioOptions.map(track => (
                      <option key={track.index} value={track.index}>{track.label}</option>
                    ))}
                  </select>
                  <select
                    value={selectedSubtitleUrl}
                    onChange={handleSubtitleTrackChange}
                    title="Subtitle track"
                    style={{ background: '#1a1a1a', color: '#fff', border: '1px solid #444', borderRadius: 4, padding: '4px 6px', fontSize: 12, maxWidth: 140 }}
                  >
                    <option value="off">Subtitles Off</option>
                    {subtitleTracks.map(track => (
                      <option key={track.source_url} value={track.source_url}>{trackLabel(track)}</option>
                    ))}
                  </select>
                  <select
                    value={playbackRate}
                    onChange={(e) => setPlaybackRate(Number(e.target.value))}
                    style={{ background: '#1a1a1a', color: '#fff', border: '1px solid #444', borderRadius: 4, padding: '4px 6px', fontSize: 12 }}
                  >
                    {[0.5, 0.75, 1, 1.25, 1.5, 2].map(r => (
                      <option key={r} value={r}>{r}x</option>
                    ))}
                  </select>
                  <CtlBtn onClick={toggleFullscreen} ariaLabel={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}>
                    {isFullscreen ? <FaCompress size={12} /> : <FaExpand size={12} />}
                  </CtlBtn>
                </div>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 12, padding: '8px 2px 2px' }}>
            <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 0.2 }}>{video?.title || 'Now Playing'}</div>
            <div style={{ marginTop: 6, color: '#b0b0b0', fontSize: 14, lineHeight: 1.6 }}>
              {video?.description || video?.subtitle || 'No description available.'}
            </div>
            <div style={{ marginTop: 10 }}>
              <button
                onClick={handlePlayNextEpisode}
                disabled={!canPlayNextEpisode}
                style={{
                  background: canPlayNextEpisode ? '#e50914' : '#2b2b2b',
                  border: canPlayNextEpisode ? '1px solid #b90710' : '1px solid #3d3d3d',
                  color: '#fff',
                  borderRadius: 6,
                  padding: '8px 12px',
                  fontWeight: 700,
                  cursor: canPlayNextEpisode ? 'pointer' : 'not-allowed',
                  opacity: canPlayNextEpisode ? 1 : 0.7,
                }}
              >
                Next Episode →
              </button>
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

          <div style={{ marginTop: 12, padding: 12, background: '#0e1b2d', border: '1px solid #2f76d2', borderRadius: 6 }}>
            <div style={{ fontSize: 12, color: '#9ec6ff', marginBottom: 8, fontWeight: 700 }}>
              Server Preloading Status {prefetchLabel ? `(${prefetchLabel})` : ''}
            </div>
            <div style={{ height: 8, background: '#1d2b3d', borderRadius: 999, overflow: 'hidden' }}>
              <div
                style={{
                  width: `${Math.max(0, Math.min(100, Number(prefetchUiStatus.progress_percent || 0)))}%`,
                  height: '100%',
                  background: 'linear-gradient(90deg, #2f76d2, #46d369)',
                  transition: 'width 0.4s ease',
                }}
              />
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: '#c7dbff' }}>
              {prefetchUiStatus.message || (prefetchUiStatus.running ? 'Preloading in progress...' : 'Preload idle')}
            </div>
            <div style={{ marginTop: 4, fontSize: 11, color: '#9db1d1' }}>
              {Number(prefetchUiStatus.completed_steps || 0)} / {Number(prefetchUiStatus.total_steps || 0)} files warmed
            </div>
            {!prefetchStatus && (
              <div style={{ marginTop: 4, fontSize: 11, color: '#9db1d1' }}>
                Trigger threshold: {prefetchTriggerProgress}% of 90% target reached
              </div>
            )}
          </div>

          {prefetch?.next_video_id && prefetchStatus?.done && (
            <div style={{
              marginTop: 12, padding: 12, background: '#0d1f0d',
              border: '1px solid #46d369', borderRadius: 6, fontSize: 13, color: '#46d369'
            }}>
              Preloading complete for {prefetchCompleteLabel} -- segments 0-4 ({prefetch.quality || '1080p'})
            </div>
          )}
        </div>

        {/* Right: info panel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Panel title="Session">
            <Row label="ID" value={session.session_id} />
            <Row label="Status" value={playing ? 'Playing' : 'Paused'} />
          </Panel>

          <Panel title="CDN Node">
            {session.cdn_node ? (
              <>
                <Row label="Name" value={session.cdn_node.name} />
                <Row label="Node ID" value={session.cdn_node.id} />
              </>
            ) : (
              <div style={{ color: '#555', fontSize: 12 }}>Served from origin</div>
            )}
          </Panel>

          <Panel title="BBA Engine">
            <Row label="Buffer" value={<span style={{ color: zoneColor[zone] }}>{simBuf.toFixed(1)}s</span>} />
            <Row label="Zone" value={<span style={{ color: zoneColor[zone] }}>{zone}</span>} />
            <Row label="Quality" value={<span style={{ color: '#46d369' }}>{quality}</span>} />
            <Row label="Priority" value={priority} />
            <Row label="Network" value={<span style={{ color: preset.color }}>{preset.cap} kbps</span>} />
            <Row label="Audio" value={audioOptions.find(track => track.index === selectedAudioIndex)?.label || 'Default'} />
            <Row label="Subtitle" value={selectedSubtitleUrl === 'off' ? 'Off' : (subtitleTracks.find(track => track.source_url === selectedSubtitleUrl)?.label || 'Selected')} />
            {recQuality && recQuality !== quality && (
              <Row label="Rec." value={<span style={{ color: '#f5a623' }}>{recQuality}</span>} />
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

function CtlBtn({ children, onClick, ariaLabel }) {
  return (
    <button
      onClick={onClick}
      aria-label={ariaLabel}
      style={{
        background: 'rgba(0,0,0,0.55)',
        color: '#fff',
        border: '1px solid rgba(255,255,255,0.3)',
        borderRadius: 999,
        width: 36,
        height: 36,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        fontSize: 12,
        backdropFilter: 'blur(2px)',
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
