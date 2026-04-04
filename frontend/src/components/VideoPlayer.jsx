import { useEffect, useRef, useState, useCallback } from 'react'
import dashjs from 'dashjs'
import {
  MdFullscreen,
  MdFullscreenExit,
  MdHighQuality,
  MdOutlineForward10,
  MdOutlineReplay10,
  MdPause,
  MdPlayArrow,
  MdSkipNext,
  MdSpeed,
  MdSubtitles,
  MdViewList,
  MdVolumeOff,
  MdVolumeUp,
} from 'react-icons/md'
import BufferBar from './BufferBar.jsx'

const QUALITIES = ['360p', '480p', '720p', '1080p']
const MAX_BUF = 60
const RESERVOIR = 10
const CUSHION_T = 45
const RESOLUTION_PRESETS = [
  { key: 'auto', label: 'Auto', targetHeight: null },
  { key: 'hd', label: 'HD', targetHeight: 1080 },
  { key: '1080p', label: '1080p', targetHeight: 1080 },
  { key: '720p', label: '720p', targetHeight: 720 },
  { key: '360p', label: '360p', targetHeight: 360 },
]

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
  chi: 'Chinese (Simplified)',
  zho: 'Chinese (Simplified)',
  zh: 'Chinese (Simplified)',
  eng: 'English',
  en: 'English',
  fre: 'French',
  fra: 'French',
  hin: 'Hindi',
  hi: 'Hindi',
  ind: 'Indonesian',
  id: 'Indonesian',
  jpn: 'Japanese',
  ja: 'Japanese',
  kor: 'Korean',
  ko: 'Korean',
  por: 'Portuguese (Brazil)',
  pt: 'Portuguese',
  'pt-br': 'Portuguese (Brazil)',
  rus: 'Russian',
  ru: 'Russian',
  spa: 'Spanish',
  es: 'Spanish',
  tha: 'Thai',
  th: 'Thai',
}

function normalizeLanguage(value) {
  return String(value || '').trim().toLowerCase().replace(/_/g, '-')
}

function cleanTrackLabel(value) {
  const label = String(value || '').replace(/\s+/g, ' ').trim()
  if (!label) return ''

  const withoutCorruptedParens = label
    .replace(/\s*\(([^)]*)\)/g, (full, inner) => {
      const hasCorruptedText = /[^\x20-\x7E]/.test(inner)
      return hasCorruptedText ? '' : full
    })
    .replace(/\s{2,}/g, ' ')
    .trim()

  if (!withoutCorruptedParens) return ''

  return withoutCorruptedParens
}

function trackLabel(track) {
  const language = normalizeLanguage(track?.language || track?.lang)
  const languageBase = language.split('-')[0]
  return (
    LANGUAGE_LABELS[language] ||
    LANGUAGE_LABELS[languageBase] ||
    cleanTrackLabel(track?.label) ||
    (language ? language.toUpperCase() : 'Unknown')
  )
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
  const [actionOverlay, setActionOverlay] = useState(null)
  const actionOverlayTimerRef = useRef(null)
  const [showVolumeSlider, setShowVolumeSlider] = useState(false)
  const [showEpisodePicker, setShowEpisodePicker] = useState(false)
  const [episodePickerLoading, setEpisodePickerLoading] = useState(false)
  const [episodePickerError, setEpisodePickerError] = useState('')
  const [upcomingEpisodes, setUpcomingEpisodes] = useState([])
  const [showResolutionMenu, setShowResolutionMenu] = useState(false)
  const [resolutionPreset, setResolutionPreset] = useState('auto')
  const [showAudioSubMenu, setShowAudioSubMenu] = useState(false)
  const [showSpeedMenu, setShowSpeedMenu] = useState(false)
  const [activeCdn, setActiveCdn] = useState(null) // current CDN node info
  const [cdnSwitchMsg, setCdnSwitchMsg] = useState(null)
  const popoverTimerRef = useRef(null)

  const currentVideoId =
    session?.video_metadata?.id ||
    video?.id
  const currentEpisodeId = session?.video_metadata?.current_episode?.episode_id || video?.episode_id || null
  const currentSeriesId = session?.video_metadata?.current_episode?.series_id || null
  const currentEpisodeMeta = session?.video_metadata?.current_episode || null
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
  const centerEpisodeLabel = currentEpisodeMeta?.series_title
    ? `${currentEpisodeMeta.series_title}   S${currentEpisodeMeta.season_number} E${currentEpisodeMeta.episode_number}`
    : video?.subtitle || ''

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

      if (dashTracks.length) {
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

      // Trigger autoplay only after dash.js has the stream ready — not before
      tryAutoplay()
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

    // Clear autoplayBlocked whenever the video actually starts playing
    // (covers dash.js internal autoplay, manual tap, and CDN failover resume)
    element.addEventListener('play', () => { setPlaying(true); setAutoplayBlocked(false) })

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

  // Initialize active CDN from session
  useEffect(() => {
    if (session?.cdn_node) setActiveCdn(session.cdn_node)
  }, [session?.session_id])

  // CDN health check — every 15s, check if current node is still alive
  // Only switch when current node is DEAD, not just because another is "better"
  const activeCdnRef = useRef(null)
  useEffect(() => { activeCdnRef.current = activeCdn }, [activeCdn])

  useEffect(() => {
    if (!playing || !session?.session_id || !currentVideoId) return
    const check = async () => {
      try {
        const r = await fetch(`/api/cdn/stats`)
        if (!r.ok) return
        const stats = await r.json()
        const nodes = Array.isArray(stats?.nodes) ? stats.nodes : []
        const current = activeCdnRef.current
        if (!current) return

        const currentId = current.id || current.node_id
        const currentNode = nodes.find(n => n.id === currentId)

        // Parse heartbeat timestamp as UTC (backend returns naive UTC without 'Z')
        const parseHb = (ts) => ts ? new Date(ts.endsWith('Z') || ts.includes('+') ? ts : ts + 'Z') : null

        // Current node is still alive and healthy — do nothing
        if (currentNode && currentNode.status === 'active') {
          const lastHb = parseHb(currentNode.last_heartbeat)
          const age = lastHb ? (Date.now() - lastHb.getTime()) : Infinity
          if (age < 20000) return // node is healthy, no switch
        }

        // Current node is dead/stale — find a replacement
        const alive = nodes.filter(n => {
          if (n.id === currentId) return false
          if (n.status !== 'active') return false
          const hb = parseHb(n.last_heartbeat)
          return hb && (Date.now() - hb.getTime()) < 20000
        })
        if (alive.length === 0) return // no healthy alternatives

        // Pick the one with lowest latency
        const best = alive.reduce((a, b) => (a.latency_ms || 999) <= (b.latency_ms || 999) ? a : b)

        // Switch to the replacement node
        const player = playerRef.current
        const currentTime = videoRef.current?.currentTime || 0
        const wasPlaying = !videoRef.current?.paused
        if (player) {
          // Use the node's registered public URL directly
          const clientUrl = (best.url || '').replace(/\/$/, '')
          const oldUrl = session.manifest_url || ''
          const pathMatch = oldUrl.match(/\/videos\/.*/)
          if (pathMatch) {
            const newManifest = `${clientUrl}${pathMatch[0]}`
            // Use canplay event — more reliable than STREAM_INITIALIZED on attachSource
            const vid = videoRef.current
            if (vid) {
              vid.addEventListener('canplay', function onCanPlay() {
                vid.currentTime = currentTime
                if (wasPlaying) {
                  vid.play()
                    .then(() => { setAutoplayBlocked(false); setPlaying(true) })
                    .catch(() => {})
                }
              }, { once: true })
            }
            player.attachSource(newManifest)
          }
        }
        const prevName = current.name || currentId
        setCdnSwitchMsg(`CDN failover: ${prevName} → ${best.name}`)
        setTimeout(() => setCdnSwitchMsg(null), 5000)
        setActiveCdn({ id: best.id, name: best.name, url: best.url })
      } catch {}
    }
    const t = setInterval(check, 15000)
    return () => clearInterval(t)
  }, [playing, session?.session_id, currentVideoId, session?.manifest_url])

  useEffect(() => {
    prefetchTriggered.current = false
    setPrefetch(null)
    setPrefetchStatus(null)
    setPrefetchPolling(false)
    setAutoNextCountdown(null)
    setAudioOptions([])
    setSelectedAudioIndex('')
    setSelectedSubtitleUrl('off')
    setShowEpisodePicker(false)
    setShowResolutionMenu(false)
    setShowAudioSubMenu(false)
    setShowSpeedMenu(false)
    setActionOverlay(null)
    setUpcomingEpisodes([])
    setEpisodePickerError('')
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

  const resetIdleTimer = useCallback(() => {
    setControlsVisible(true)
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current)
    idleTimerRef.current = window.setTimeout(() => {
      if (!videoRef.current?.paused) setControlsVisible(false)
    }, 3000)
  }, [])

  const showAction = useCallback((label, icon = null) => {
    setActionOverlay({ label, icon })
    if (actionOverlayTimerRef.current) window.clearTimeout(actionOverlayTimerRef.current)
    actionOverlayTimerRef.current = window.setTimeout(() => {
      setActionOverlay(null)
    }, 900)
  }, [])

  const adjustVolumeBy = useCallback((delta) => {
    const current = muted ? 0 : volume
    const next = Math.max(0, Math.min(1, Math.round((current + delta) * 100) / 100))
    setVolume(next)
    setMuted(next === 0)
    showAction(`Volume ${Math.round(next * 100)}%`, next === 0 ? '🔇' : '🔊')
  }, [muted, volume, showAction])

  useEffect(() => {
    return () => {
      if (actionOverlayTimerRef.current) window.clearTimeout(actionOverlayTimerRef.current)
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current)
      if (popoverTimerRef.current) window.clearTimeout(popoverTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      if (!videoRef.current) return

      if (e.key === ' ' || e.key.toLowerCase() === 'k') {
        e.preventDefault()
        handlePlayPause({ showOverlay: true })
      } else if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'l') {
        e.preventDefault()
        seekBy(10, { showOverlay: true })
      } else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'j') {
        e.preventDefault()
        seekBy(-10, { showOverlay: true })
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        adjustVolumeBy(0.05)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        adjustVolumeBy(-0.05)
      } else if (e.key.toLowerCase() === 'm') {
        e.preventDefault()
        setMuted(v => {
          const next = !v
          showAction(next ? 'Muted' : 'Unmuted', next ? '🔇' : '🔊')
          return next
        })
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault()
        toggleFullscreen()
      }

      resetIdleTimer()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [adjustVolumeBy, resetIdleTimer, playing])

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
    // Only let BBA drive quality when in auto mode
    if (resolutionPreset === 'auto') {
      setQuality(q)
    }
    setPriority(simBuf < 5 ? 'audio' : 'video')
  }, [simBuf, resolutionPreset])

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

  const handlePlayPause = ({ showOverlay: show = false } = {}) => {
    if (!videoRef.current) return
    if (videoRef.current.paused) {
      videoRef.current.play().then(() => {
        setAutoplayBlocked(false)
        if (simBuf === 0) setSimBuf(2)
        if (show) showAction('Play', '▶')
      }).catch(() => setAutoplayBlocked(true))
    } else {
      videoRef.current.pause()
      if (show) showAction('Pause', '⏸')
    }
  }

  const seekBy = (seconds, { showOverlay: show = false } = {}) => {
    if (!videoRef.current) return
    const next = Math.max(0, Math.min(duration, (videoRef.current.currentTime || 0) + seconds))
    videoRef.current.currentTime = next
    setPlayhead(next)
    if (show) {
      const abs = Math.abs(seconds)
      showAction(seconds > 0 ? `+${abs}s` : `-${abs}s`, seconds > 0 ? '⏩' : '⏪')
    }
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

  const loadUpcomingEpisodes = useCallback(async () => {
    if (!currentSeriesId || !currentEpisodeId || !token) {
      setEpisodePickerError('Episode list is unavailable for this title.')
      setUpcomingEpisodes([])
      return
    }

    setEpisodePickerLoading(true)
    setEpisodePickerError('')
    try {
      const r = await fetch(`/api/catalog/series/${currentSeriesId}/episodes`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const payload = await r.json()
      if (!r.ok) throw new Error(payload.detail || 'Failed to load episodes')
      const all = Array.isArray(payload.episodes) ? payload.episodes : []
      const ordered = [...all].sort((a, b) => {
        const seasonDiff = Number(a.season_number || 0) - Number(b.season_number || 0)
        if (seasonDiff !== 0) return seasonDiff
        return Number(a.episode_number || 0) - Number(b.episode_number || 0)
      })
      setUpcomingEpisodes(ordered)
      if (ordered.length === 0) setEpisodePickerError('No episodes available.')
    } catch (e) {
      setEpisodePickerError(e.message)
      setUpcomingEpisodes([])
    } finally {
      setEpisodePickerLoading(false)
    }
  }, [currentSeriesId, currentEpisodeId, token, session?.video_metadata?.current_episode?.season_number, session?.video_metadata?.current_episode?.episode_number])

  const openEpisodePicker = async () => {
    clearPopoverTimer()
    setShowEpisodePicker(true)
    setShowResolutionMenu(false)
    setShowAudioSubMenu(false)
    setShowSpeedMenu(false)
    await loadUpcomingEpisodes()
  }

  const clearPopoverTimer = () => {
    if (popoverTimerRef.current) window.clearTimeout(popoverTimerRef.current)
  }

  const startPopoverTimer = (closeFn) => {
    clearPopoverTimer()
    popoverTimerRef.current = window.setTimeout(closeFn, 2000)
  }

  const containScrollWheel = useCallback((event) => {
    event.stopPropagation()
    const element = event.currentTarget
    const canScroll = element.scrollHeight > element.clientHeight + 1

    if (!canScroll) {
      event.preventDefault()
      return
    }

    const goingDown = event.deltaY > 0
    const atTop = element.scrollTop <= 0
    const atBottom = Math.ceil(element.scrollTop + element.clientHeight) >= element.scrollHeight

    if ((atTop && !goingDown) || (atBottom && goingDown)) {
      event.preventDefault()
    }
  }, [])

  const openResolutionMenu = () => {
    clearPopoverTimer()
    setShowResolutionMenu(true)
    setShowEpisodePicker(false)
    setShowAudioSubMenu(false)
    setShowSpeedMenu(false)
  }

  const openAudioSubMenu = () => {
    clearPopoverTimer()
    setShowAudioSubMenu(true)
    setShowResolutionMenu(false)
    setShowEpisodePicker(false)
    setShowSpeedMenu(false)
  }

  const openSpeedMenu = () => {
    clearPopoverTimer()
    setShowSpeedMenu(true)
    setShowResolutionMenu(false)
    setShowAudioSubMenu(false)
    setShowEpisodePicker(false)
  }

  const notifyQualityChange = (newQuality, manualOverride) => {
    if (!session?.session_id || !token) return
    fetch('/api/playback/quality', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        session_id: session.session_id,
        quality: newQuality,
        manual_override: manualOverride,
      }),
    }).catch(() => {})
  }

  const applyResolutionPreset = (presetKey) => {
    setResolutionPreset(presetKey)
    const player = playerRef.current
    if (!player?.getBitrateInfoListFor || !player.setQualityFor) return

    const list = player.getBitrateInfoListFor('video') || []
    if (!list.length) return

    if (presetKey === 'auto') {
      player.updateSettings?.({ streaming: { abr: { autoSwitchBitrate: { video: true, audio: true } } } })
      // Let BBA drive quality again
      const { quality: q } = bba(simBuf)
      setQuality(q)
      notifyQualityChange(q, false)
      showAction('Auto Quality', 'HD')
      return
    }

    const selected = RESOLUTION_PRESETS.find(item => item.key === presetKey)
    const target = selected?.targetHeight
    if (!target) return

    player.updateSettings?.({ streaming: { abr: { autoSwitchBitrate: { video: false, audio: true } } } })
    let bestIndex = 0
    let bestDelta = Number.POSITIVE_INFINITY
    list.forEach((bitrate, index) => {
      const h = Number(bitrate.height || 0)
      if (!h) return
      const delta = Math.abs(h - target)
      if (delta < bestDelta) {
        bestDelta = delta
        bestIndex = index
      }
    })
    player.setQualityFor('video', bestIndex, true)

    // Map preset key to quality label and update state + backend
    const qualityLabel = presetKey === 'hd' ? '1080p' : presetKey
    setQuality(qualityLabel)
    notifyQualityChange(qualityLabel, true)
    showAction(selected?.label || 'Quality Changed', 'HD')
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

  // Always show controls while paused
  useEffect(() => {
    if (!playing) {
      setControlsVisible(true)
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current)
    }
  }, [playing])

  // Dismiss all overlays/popovers when controls fade out
  useEffect(() => {
    if (!controlsVisible) {
      setActionOverlay(null)
      setShowResolutionMenu(false)
      setShowAudioSubMenu(false)
      setShowSpeedMenu(false)
      setShowEpisodePicker(false)
    }
  }, [controlsVisible])

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
              background: 'none',
              borderRadius: 0, padding: '10px 6px 4px',
              opacity: controlsVisible ? 1 : 0,
              transition: 'opacity 0.3s ease',
              pointerEvents: controlsVisible ? 'auto' : 'none',
            }}>
              <div
                onClick={seekToPercent}
                style={{ position: 'relative', height: 6, background: '#505050', borderRadius: 99, cursor: 'pointer', marginBottom: 10 }}
              >
                {/* Buffer loaded bar (grey, behind playhead) */}
                <div style={{
                  position: 'absolute', top: 0, left: 0, height: '100%', borderRadius: 99, background: 'rgba(255,255,255,0.3)',
                  width: `${(() => {
                    const el = videoRef.current
                    if (!el?.buffered?.length || !duration) return 0
                    let end = 0
                    for (let i = 0; i < el.buffered.length; i++) {
                      if (el.buffered.start(i) <= playhead) end = Math.max(end, el.buffered.end(i))
                    }
                    return Math.min(100, (end / duration) * 100)
                  })()}%`,
                  transition: 'width 0.3s ease',
                }} />
                {/* Playhead bar (red) */}
                <div style={{ position: 'relative', height: '100%', width: `${(playhead / duration) * 100}%`, borderRadius: 99, background: '#e50914' }} />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#fff', position: 'relative' }}>
                <CtlBtn
                  onClick={() => handlePlayPause({ showOverlay: true })}
                  ariaLabel={playing ? 'Pause' : 'Play'}
                  tooltip={playing ? 'Space / K · Pause' : 'Space / K · Play'}
                >
                  {playing ? <MdPause size={26} /> : <MdPlayArrow size={28} style={{ marginLeft: 2 }} />}
                </CtlBtn>
                <CtlBtn
                  onClick={() => seekBy(-10, { showOverlay: true })}
                  ariaLabel="Back 10 seconds"
                  tooltip="← / J · Back 10s"
                >
                  <MdOutlineReplay10 size={28} color="#fff" />
                </CtlBtn>
                <CtlBtn
                  onClick={() => seekBy(10, { showOverlay: true })}
                  ariaLabel="Forward 10 seconds"
                  tooltip="→ / L · Forward 10s"
                >
                  <MdOutlineForward10 size={28} color="#fff" />
                </CtlBtn>

                <div
                  style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
                  onMouseEnter={() => setShowVolumeSlider(true)}
                  onMouseLeave={() => setShowVolumeSlider(false)}
                >
                  <CtlBtn
                    onClick={() => {
                      setMuted(v => {
                        const next = !v
                        showAction(next ? 'Muted' : 'Unmuted', next ? '🔇' : '🔊')
                        return next
                      })
                    }}
                    ariaLabel={muted || volume === 0 ? 'Unmute' : 'Mute'}
                    tooltip="M · Mute / Unmute"
                  >
                    {muted || volume === 0 ? <MdVolumeOff size={26} /> : <MdVolumeUp size={26} />}
                  </CtlBtn>

                  {showVolumeSlider && (
                    <div style={{
                      position: 'absolute',
                      left: '50%',
                      bottom: 48,
                      transform: 'translateX(-50%)',
                      width: 42,
                      height: 130,
                      borderRadius: 14,
                      background: 'rgba(17,17,17,0.98)',
                      border: '1px solid rgba(255,255,255,0.28)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '8px 0',
                    }}>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={muted ? 0 : volume}
                        onChange={(e) => {
                          const v = Number(e.target.value)
                          setVolume(v)
                          setMuted(v === 0)
                          showAction(`Volume ${Math.round(v * 100)}%`, v === 0 ? '🔇' : '🔊')
                        }}
                        style={{ width: 95, transform: 'rotate(-90deg)' }}
                      />
                    </div>
                  )}
                </div>

                <span style={{ marginLeft: 4, fontSize: 12, color: '#d0d0d0', whiteSpace: 'nowrap' }}>{fmtTime(playhead)} / {fmtTime(duration)}</span>

                {centerEpisodeLabel && (
                  <span style={{
                    position: 'absolute',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    color: 'rgba(255,255,255,0.88)',
                    fontSize: 11,
                    fontWeight: 500,
                    letterSpacing: 0.3,
                    textShadow: '0 1px 4px rgba(0,0,0,0.9)',
                    pointerEvents: 'none',
                    whiteSpace: 'nowrap',
                  }}>
                    {centerEpisodeLabel}
                  </span>
                )}

                <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center', position: 'relative' }}>
                  <CtlBtn
                    onClick={handlePlayNextEpisode}
                    ariaLabel="Play next episode"
                    disabled={!canPlayNextEpisode}
                    tooltip="Shift + N · Next episode"
                  >
                    <MdSkipNext size={28} />
                  </CtlBtn>

                  <CtlBtn
                    onClick={openEpisodePicker}
                    ariaLabel="Open episode list"
                    onMouseEnter={openEpisodePicker}
                    onMouseLeave={() => startPopoverTimer(() => setShowEpisodePicker(false))}
                  >
                    <MdViewList size={26} />
                  </CtlBtn>

                  <CtlBtn
                    onClick={() => {
                      if (showResolutionMenu) {
                        setShowResolutionMenu(false)
                        return
                      }
                      openResolutionMenu()
                    }}
                    ariaLabel="Resolution"
                    onMouseEnter={openResolutionMenu}
                    onMouseLeave={() => startPopoverTimer(() => setShowResolutionMenu(false))}
                  >
                    <MdHighQuality size={26} />
                  </CtlBtn>

                  <CtlBtn
                    onClick={() => {
                      if (showAudioSubMenu) {
                        setShowAudioSubMenu(false)
                        return
                      }
                      openAudioSubMenu()
                    }}
                    ariaLabel="Audio & Subtitles"
                    onMouseEnter={openAudioSubMenu}
                    onMouseLeave={() => startPopoverTimer(() => setShowAudioSubMenu(false))}
                  >
                    <MdSubtitles size={26} />
                  </CtlBtn>

                  <CtlBtn
                    onClick={() => {
                      if (showSpeedMenu) {
                        setShowSpeedMenu(false)
                        return
                      }
                      openSpeedMenu()
                    }}
                    ariaLabel="Playback speed"
                    onMouseEnter={openSpeedMenu}
                    onMouseLeave={() => startPopoverTimer(() => setShowSpeedMenu(false))}
                  >
                    <MdSpeed size={26} />
                  </CtlBtn>

                  <CtlBtn
                    onClick={toggleFullscreen}
                    ariaLabel={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                    tooltip={isFullscreen ? 'F · Exit fullscreen' : 'F · Fullscreen'}
                  >
                    {isFullscreen ? <MdFullscreenExit size={26} /> : <MdFullscreen size={26} />}
                  </CtlBtn>
                </div>
              </div>
            </div>

            {actionOverlay && (
              <div style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
                zIndex: 5,
                background: 'rgba(16,16,16,0.9)',
                border: '1px solid rgba(255,255,255,0.3)',
                borderRadius: 14,
                minWidth: 130,
                textAlign: 'center',
                padding: '12px 16px',
                color: '#fff',
                fontWeight: 700,
              }}>
                <div style={{ fontSize: 20, marginBottom: 2 }}>{actionOverlay.icon || '•'}</div>
                <div style={{ fontSize: 14 }}>{actionOverlay.label}</div>
              </div>
            )}

            {cdnSwitchMsg && (
              <div style={{
                position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)', zIndex: 10,
                background: 'rgba(16,16,16,0.92)', border: '1px solid #46d369', borderRadius: 8,
                padding: '8px 18px', fontSize: 12, color: '#46d369', whiteSpace: 'nowrap',
              }}>
                {cdnSwitchMsg}
              </div>
            )}

            {showResolutionMenu && (
              <div
                style={popoverStyle(12, 112)}
                onMouseEnter={clearPopoverTimer}
                onMouseLeave={() => startPopoverTimer(() => setShowResolutionMenu(false))}
              >
                <div style={popoverTitleStyle}>Quality</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {RESOLUTION_PRESETS.map(item => (
                    <button
                      key={item.key}
                      onClick={() => {
                        applyResolutionPreset(item.key)
                        setShowResolutionMenu(false)
                      }}
                      style={chipStyle(resolutionPreset === item.key)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {showSpeedMenu && (
              <div
                style={{
                  position: 'absolute',
                  right: 70,
                  bottom: 96,
                  width: 'min(680px, 82vw)',
                  background: 'rgba(33,33,33,0.97)',
                  borderRadius: 10,
                  padding: '20px 28px 24px',
                  zIndex: 6,
                }}
                onMouseEnter={clearPopoverTimer}
                onMouseLeave={() => startPopoverTimer(() => setShowSpeedMenu(false))}
              >
                <div style={{ color: '#fff', fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Playback Speed</div>
                <div style={{ position: 'relative', paddingTop: 4 }}>
                  <div style={{ position: 'absolute', top: 10, left: 0, right: 0, height: 2, background: 'rgba(255,255,255,0.28)' }} />
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, position: 'relative' }}>
                    {[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => (
                      <button
                        key={rate}
                        onClick={() => {
                          setPlaybackRate(rate)
                          setShowSpeedMenu(false)
                          showAction(`${rate}x`, '⏩')
                        }}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#fff',
                          cursor: 'pointer',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: 14,
                          padding: 0,
                        }}
                      >
                        <span style={{
                          width: rate === playbackRate ? 24 : 14,
                          height: rate === playbackRate ? 24 : 14,
                          borderRadius: '50%',
                          background: rate === playbackRate ? '#fff' : '#d0d0d0',
                          boxShadow: rate === playbackRate ? '0 0 0 5px rgba(255,255,255,0.32)' : 'none',
                          display: 'inline-block',
                        }} />
                        <span style={{ fontSize: rate === playbackRate ? 13 : 12, fontWeight: rate === playbackRate ? 700 : 500 }}>
                          {rate === 1 ? '1x (Normal)' : `${rate}x`}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {showAudioSubMenu && (
              <div
                style={{
                  position: 'absolute',
                  right: 12,
                  bottom: 96,
                  width: 'min(560px, 80vw)',
                  maxHeight: '72%',
                  background: 'rgba(20,20,20,0.97)',
                  border: '1px solid rgba(255,255,255,0.18)',
                  borderRadius: 10,
                  zIndex: 6,
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                }}
                onMouseEnter={clearPopoverTimer}
                onMouseLeave={() => startPopoverTimer(() => setShowAudioSubMenu(false))}
              >
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', flex: 1, minHeight: 0 }}>
                  {/* Audio column */}
                  <div style={{ padding: '20px 20px 20px 24px', borderRight: '1px solid rgba(255,255,255,0.12)', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
                    <div style={{ color: '#fff', fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Audio</div>
                    <div
                      style={{ display: 'grid', gap: 2, overflowY: 'auto', flex: 1, minHeight: 0, paddingRight: 8, overscrollBehavior: 'contain', scrollbarGutter: 'stable' }}
                      onWheel={containScrollWheel}
                    >
                      {audioOptions.length === 0 && <div style={{ color: '#888', fontSize: 12 }}>No audio tracks</div>}
                      {audioOptions.map(track => (
                        <button
                          key={track.index}
                          onClick={() => {
                            handleAudioTrackChange({ target: { value: track.index } })
                          }}
                          style={audioSubListBtnStyle(selectedAudioIndex === track.index)}
                        >
                          {selectedAudioIndex === track.index && <span style={{ marginRight: 8, color: '#fff' }}>✓</span>}
                          {track.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* Subtitles column */}
                  <div style={{ padding: '20px 24px 20px 20px', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
                    <div style={{ color: '#fff', fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Subtitles</div>
                    <div
                      style={{ display: 'grid', gap: 2, overflowY: 'auto', flex: 1, minHeight: 0, paddingRight: 4, overscrollBehavior: 'contain', scrollbarGutter: 'stable' }}
                      onWheel={containScrollWheel}
                    >
                      <button
                        onClick={() => handleSubtitleTrackChange({ target: { value: 'off' } })}
                        style={audioSubListBtnStyle(selectedSubtitleUrl === 'off')}
                      >
                        {selectedSubtitleUrl === 'off' && <span style={{ marginRight: 8, color: '#fff' }}>✓</span>}
                        Off
                      </button>
                      {subtitleTracks.map(track => (
                        <button
                          key={track.source_url}
                          onClick={() => handleSubtitleTrackChange({ target: { value: track.source_url } })}
                          style={audioSubListBtnStyle(selectedSubtitleUrl === track.source_url)}
                        >
                          {selectedSubtitleUrl === track.source_url && <span style={{ marginRight: 8, color: '#fff' }}>✓</span>}
                          {trackLabel(track)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {showEpisodePicker && (
              <div
                style={{
                  position: 'absolute',
                  right: 16,
                  bottom: 84,
                  width: 'min(520px, 74vw)',
                  maxHeight: '70%',
                  background: 'rgba(18,18,18,0.97)',
                  border: '1px solid rgba(255,255,255,0.3)',
                  borderRadius: 10,
                  zIndex: 6,
                  padding: '12px 14px',
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                }}
                onMouseEnter={clearPopoverTimer}
                onMouseLeave={() => startPopoverTimer(() => setShowEpisodePicker(false))}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ color: '#fff', fontWeight: 700 }}>Episodes</div>
                  <button
                    onClick={() => setShowEpisodePicker(false)}
                    style={{ background: 'none', border: 'none', color: '#bbb', cursor: 'pointer', fontSize: 18 }}
                  >
                    ×
                  </button>
                </div>
                <div
                  style={{ overflowY: 'auto', overscrollBehavior: 'contain', minHeight: 0, flex: 1, paddingRight: 4, scrollbarGutter: 'stable' }}
                  onWheel={containScrollWheel}
                >
                  {episodePickerLoading && <div style={{ color: '#aaa', fontSize: 13 }}>Loading episodes...</div>}
                  {!episodePickerLoading && episodePickerError && (
                    <div style={{ color: '#ff9b9b', fontSize: 13 }}>{episodePickerError}</div>
                  )}
                  {!episodePickerLoading && !episodePickerError && upcomingEpisodes.map(ep => {
                    const isCurrent = Number(ep.episode_id) === Number(currentEpisodeId)
                    return (
                    <button
                      key={ep.episode_id}
                      onClick={async () => {
                        if (isCurrent || !ep.playable || !ep.video_id) return
                        setShowEpisodePicker(false)
                        await onPlayNextEpisode?.(ep)
                      }}
                      disabled={isCurrent || !ep.playable || !ep.video_id}
                      style={{
                        width: '100%',
                        marginBottom: 8,
                        textAlign: 'left',
                        padding: '10px 12px',
                        borderRadius: 6,
                        border: isCurrent ? '1px solid rgba(229,9,20,0.75)' : '1px solid rgba(255,255,255,0.18)',
                        background: isCurrent ? 'rgba(229,9,20,0.16)' : (ep.playable && ep.video_id ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)'),
                        color: isCurrent || (ep.playable && ep.video_id) ? '#fff' : '#888',
                        cursor: isCurrent ? 'default' : (ep.playable && ep.video_id ? 'pointer' : 'not-allowed'),
                      }}
                    >
                      <div style={{ fontWeight: 700, fontSize: 13 }}>
                        S{ep.season_number}:E{ep.episode_number} • {ep.title}
                        {isCurrent && <span style={{ marginLeft: 8, color: '#ffb3b7', fontSize: 11 }}>Now Playing</span>}
                      </div>
                      <div style={{ fontSize: 12, color: '#b9b9b9', marginTop: 2 }}>{ep.synopsis || 'No synopsis available.'}</div>
                    </button>
                    )
                  })}
                </div>
              </div>
            )}
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
            {activeCdn ? (
              <>
                <Row label="Name" value={activeCdn.name} />
                <Row label="Node ID" value={activeCdn.id || activeCdn.node_id} />
                {cdnSwitchMsg && (
                  <div style={{ fontSize: 10, color: '#46d369', marginTop: 4, animation: 'fadeIn 0.3s' }}>
                    {cdnSwitchMsg}
                  </div>
                )}
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

function CtlBtn({ children, onClick, ariaLabel, disabled = false, tooltip = '', onMouseEnter, onMouseLeave }) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={(event) => {
        setHovered(true)
        onMouseEnter?.(event)
      }}
      onMouseLeave={(event) => {
        setHovered(false)
        onMouseLeave?.(event)
      }}
    >
      <button
        onClick={onClick}
        aria-label={ariaLabel}
        disabled={disabled}
        style={{
          background: 'transparent',
          color: disabled ? '#888' : '#fff',
          border: 'none',
          borderRadius: 999,
          width: 44,
          height: 44,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontSize: 12,
          opacity: disabled ? 0.65 : 1,
          padding: 0,
          filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.7))',
        }}
      >
        {children}
      </button>

      {tooltip && hovered && !disabled && (
        <div style={{
          position: 'absolute',
          left: '50%',
          bottom: 'calc(100% + 8px)',
          transform: 'translateX(-50%)',
          background: 'rgba(15,15,15,0.96)',
          color: '#fff',
          borderRadius: 6,
          padding: '6px 8px',
          fontSize: 11,
          fontWeight: 500,
          whiteSpace: 'nowrap',
          border: '1px solid rgba(255,255,255,0.14)',
          boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
          pointerEvents: 'none',
          zIndex: 8,
        }}>
          {tooltip}
        </div>
      )}
    </div>
  )
}

function popoverStyle(right, bottom) {
  return {
    position: 'absolute',
    right,
    bottom,
    background: 'rgba(18,18,18,0.96)',
    border: '1px solid rgba(255,255,255,0.28)',
    borderRadius: 10,
    padding: 10,
    minWidth: 220,
    zIndex: 6,
  }
}

const popoverTitleStyle = {
  color: '#fff',
  fontSize: 12,
  fontWeight: 700,
  marginBottom: 8,
  letterSpacing: 0.4,
}

function chipStyle(active) {
  return {
    background: active ? '#e50914' : '#111',
    color: '#fff',
    border: active ? '1px solid #ff5861' : '1px solid rgba(255,255,255,0.35)',
    borderRadius: 7,
    padding: '5px 10px',
    fontSize: 12,
    cursor: 'pointer',
  }
}


function audioSubListBtnStyle(active) {
  return {
    textAlign: 'left',
    background: 'none',
    color: active ? '#fff' : '#ccc',
    border: 'none',
    borderRadius: 4,
    padding: '8px 4px',
    fontSize: 14,
    cursor: 'pointer',
    fontWeight: active ? 700 : 400,
    display: 'flex',
    alignItems: 'flex-start',
    lineHeight: 1.35,
    whiteSpace: 'normal',
    wordBreak: 'break-word',
  }
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
