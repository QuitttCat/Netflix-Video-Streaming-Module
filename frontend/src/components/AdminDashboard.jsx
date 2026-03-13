import { useEffect, useRef, useState } from 'react'

export default function AdminDashboard({ token, mode = 'ops', onOpenContentManager }) {
  const isContentMode = mode === 'content'
  const [data,      setData]      = useState(null)
  const [connected, setConnected] = useState(false)
  const [series, setSeries] = useState([])
  const [selectedSeries, setSelectedSeries] = useState(null)
  const [selectedSeason, setSelectedSeason] = useState(null)
  const [modalSeries, setModalSeries] = useState(null)
  const [modalSeason, setModalSeason] = useState(null)
  const [uploadMsg, setUploadMsg] = useState('')
  const [fileByEpisode, setFileByEpisode] = useState({})
  const [thumbByEpisode, setThumbByEpisode] = useState({})
  const [uploadingEpisodeId, setUploadingEpisodeId] = useState(null)
  const [uploadingThumbEpisodeId, setUploadingThumbEpisodeId] = useState(null)
  const [seedStatus, setSeedStatus] = useState(null)
  const [seedMsg, setSeedMsg] = useState('')
  const [videos, setVideos] = useState([])
  const [videoUploadFile, setVideoUploadFile] = useState(null)
  const [videoUploadTitle, setVideoUploadTitle] = useState('')
  const [videoUploadDesc, setVideoUploadDesc] = useState('')
  const [videoThumbFileById, setVideoThumbFileById] = useState({})
  const [newSeriesTitle, setNewSeriesTitle] = useState('')
  const [newSeriesSynopsis, setNewSeriesSynopsis] = useState('')
  const [newEpisodeTitle, setNewEpisodeTitle] = useState('')
  const [newEpisodeSynopsis, setNewEpisodeSynopsis] = useState('')
  const [newEpisodeNumber, setNewEpisodeNumber] = useState('1')
  const [seriesSearch, setSeriesSearch] = useState('')
  const [seriesThumbFile, setSeriesThumbFile] = useState(null)
  const wsRef = useRef(null)

  const fetchSeriesOverview = async () => {
    try {
      const r = await fetch('/api/catalog/admin/series-overview', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const payloadText = await r.text()
      const payload = parseMaybeJson(payloadText)
      if (!r.ok) throw new Error(payload.detail || payload.raw || 'Failed to load series overview')
      const items = payload.items || []
      setSeries(items)

      if (items.length > 0) {
        const nextSeries = selectedSeries
          ? (items.find(x => x.series_id === selectedSeries.series_id) || items[0])
          : (items.find(x => x.missing_episodes > 0) || items[0])
        setSelectedSeries(nextSeries)

        const nextSeason = selectedSeason
          ? (nextSeries.seasons?.find(x => x.season_id === selectedSeason.season_id) || nextSeries.seasons?.[0] || null)
          : (nextSeries.seasons?.[0] || null)
        setSelectedSeason(nextSeason)

        if (modalSeries) {
          const refreshedModalSeries = items.find(x => x.series_id === modalSeries.series_id) || null
          setModalSeries(refreshedModalSeries)
          if (refreshedModalSeries) {
            const refreshedModalSeason = modalSeason
              ? (refreshedModalSeries.seasons?.find(x => x.season_id === modalSeason.season_id) || refreshedModalSeries.seasons?.[0] || null)
              : (refreshedModalSeries.seasons?.[0] || null)
            setModalSeason(refreshedModalSeason)
          } else {
            setModalSeason(null)
          }
        }
      }
    } catch (e) {
      setUploadMsg(`Series overview error: ${e.message}`)
    }
  }

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws    = new WebSocket(`${proto}//${window.location.host}/ws/monitor`)
    wsRef.current = ws

    ws.onopen    = () => setConnected(true)
    ws.onmessage = (e) => setData(JSON.parse(e.data))
    ws.onclose   = () => setConnected(false)
    ws.onerror   = () => setConnected(false)

    return () => ws.close()
  }, [])

  useEffect(() => {
    if (!isContentMode) return
    fetchSeriesOverview()
    fetchSeedStatus()
    fetchVideos()
  }, [isContentMode])

  useEffect(() => {
    if (!isContentMode || !seedStatus?.running) return
    const t = setInterval(fetchSeedStatus, 2000)
    return () => clearInterval(t)
  }, [isContentMode, seedStatus?.running])

  useEffect(() => {
    if (!isContentMode) return
    if (seedStatus?.running === false && seedStatus?.success === true) {
      fetchSeriesOverview()
    }
  }, [isContentMode, seedStatus?.running, seedStatus?.success])

  const selectSeries = (item) => {
    setSelectedSeries(item)
    setSelectedSeason(item.seasons?.[0] || null)
  }

  const uploadEpisodeVideo = async (episode) => {
    setUploadMsg('')
    const file = fileByEpisode[episode.episode_id]
    if (!file) {
      setUploadMsg(`Select a video file for S${modalSeason?.season_number}:E${episode.episode_number}`)
      return
    }
    try {
      setUploadingEpisodeId(episode.episode_id)
      const form = new FormData()
      form.append('episode_id', String(episode.episode_id))
      form.append('title', `Episode ${episode.episode_number}`)
      form.append('description', 'Uploaded from admin dashboard')
      form.append('file', file)

      const r = await fetch(`/api/catalog/admin/episodes/${episode.episode_id}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      })
      const payloadText = await r.text()
      const payload = parseMaybeJson(payloadText)
      if (!r.ok) throw new Error(payload.detail || payloadText || 'Upload failed')

      setUploadMsg(`Uploaded ${episode.title} → video_id ${payload.video_id}. Encode this video to make playback ready.`)
      setFileByEpisode(prev => {
        const copy = { ...prev }
        delete copy[episode.episode_id]
        return copy
      })
      await fetchSeriesOverview()
    } catch (err) {
      setUploadMsg(`Upload error: ${err.message}`)
    } finally {
      setUploadingEpisodeId(null)
    }
  }

  const fetchSeedStatus = async () => {
    try {
      const r = await fetch('/api/catalog/admin/seed-catalog-status', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const txt = await r.text()
      const payload = parseMaybeJson(txt)
      if (!r.ok) throw new Error(payload.detail || payload.raw || 'Failed to fetch seed status')
      setSeedStatus(payload)
    } catch (e) {
      setSeedMsg(`Seed status error: ${e.message}`)
    }
  }

  const fetchVideos = async () => {
    try {
      const r = await fetch('/api/videos?limit=100')
      const text = await r.text()
      const payload = parseMaybeJson(text)
      if (!r.ok) throw new Error(payload.detail || payload.raw || 'Failed to load videos')
      setVideos(payload.items || [])
    } catch (e) {
      setUploadMsg(`Video list error: ${e.message}`)
    }
  }

  const createSeries = async () => {
    if (!newSeriesTitle.trim()) {
      setUploadMsg('Series title is required')
      return
    }
    try {
      const r = await fetch('/api/catalog/admin/series', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: newSeriesTitle, synopsis: newSeriesSynopsis.trim(), content_type: 'series' }),
      })
      const t = await r.text()
      const payload = parseMaybeJson(t)
      if (!r.ok) throw new Error(payload.detail || payload.raw || 'Failed to create series')
      setUploadMsg(`Series created: ${payload.series?.title}`)
      setNewSeriesTitle('')
      setNewSeriesSynopsis('')
      await fetchSeriesOverview()
    } catch (e) {
      setUploadMsg(`Create series error: ${e.message}`)
    }
  }

  const createEpisode = async () => {
    if (!modalSeries || !modalSeason) return
    if (!newEpisodeTitle.trim()) {
      setUploadMsg('Episode title is required')
      return
    }
    try {
      const r = await fetch(`/api/catalog/admin/series/${modalSeries.series_id}/episodes`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          season_id: modalSeason.season_id,
          title: newEpisodeTitle,
          episode_number: Number(newEpisodeNumber) || 1,
          synopsis: newEpisodeSynopsis.trim(),
          duration_sec: 0,
        }),
      })
      const t = await r.text()
      const payload = parseMaybeJson(t)
      if (!r.ok) throw new Error(payload.detail || payload.raw || 'Failed to create episode')
      setUploadMsg(`Episode created: ${payload.episode?.title}`)
      setNewEpisodeTitle('')
      setNewEpisodeSynopsis('')
      setNewEpisodeNumber('1')
      await fetchSeriesOverview()
    } catch (e) {
      setUploadMsg(`Create episode error: ${e.message}`)
    }
  }

  const editSeries = async (seriesItem) => {
    const nextTitle = window.prompt('Update series title', seriesItem.title)
    if (nextTitle === null) return
    const nextSynopsis = window.prompt('Update series description', seriesItem.synopsis || '')
    if (nextSynopsis === null) return
    try {
      const r = await fetch(`/api/catalog/admin/series/${seriesItem.series_id}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: nextTitle, synopsis: nextSynopsis }),
      })
      const t = await r.text()
      const payload = parseMaybeJson(t)
      if (!r.ok) throw new Error(payload.detail || payload.raw || 'Failed to update series')
      setUploadMsg(`Series updated: ${payload.series?.title}`)
      await fetchSeriesOverview()
    } catch (e) {
      setUploadMsg(`Series update error: ${e.message}`)
    }
  }

  const deleteSeries = async (seriesItem) => {
    if (!window.confirm(`Delete series "${seriesItem.title}" and its seasons/episodes?`)) return
    try {
      const r = await fetch(`/api/catalog/admin/series/${seriesItem.series_id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const t = await r.text()
      const payload = parseMaybeJson(t)
      if (!r.ok) throw new Error(payload.detail || payload.raw || 'Failed to delete series')
      setUploadMsg(`Series deleted: ${seriesItem.title}`)
      setModalSeries(null)
      setModalSeason(null)
      await fetchSeriesOverview()
    } catch (e) {
      setUploadMsg(`Series delete error: ${e.message}`)
    }
  }

  const editEpisode = async (ep) => {
    const nextTitle = window.prompt('Update episode title', ep.title)
    if (nextTitle === null) return
    const nextSynopsis = window.prompt('Update episode description', ep.synopsis || '')
    if (nextSynopsis === null) return
    try {
      const r = await fetch(`/api/catalog/admin/episodes/${ep.episode_id}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: nextTitle, synopsis: nextSynopsis }),
      })
      const t = await r.text()
      const payload = parseMaybeJson(t)
      if (!r.ok) throw new Error(payload.detail || payload.raw || 'Failed to update episode')
      setUploadMsg(`Episode updated: ${payload.episode?.title}`)
      await fetchSeriesOverview()
    } catch (e) {
      setUploadMsg(`Episode update error: ${e.message}`)
    }
  }

  const deleteEpisode = async (ep) => {
    if (!window.confirm(`Delete episode "${ep.title}"?`)) return
    try {
      const r = await fetch(`/api/catalog/admin/episodes/${ep.episode_id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const t = await r.text()
      const payload = parseMaybeJson(t)
      if (!r.ok) throw new Error(payload.detail || payload.raw || 'Failed to delete episode')
      setUploadMsg(`Episode deleted: ${ep.title}`)
      await fetchSeriesOverview()
    } catch (e) {
      setUploadMsg(`Episode delete error: ${e.message}`)
    }
  }

  const uploadNewVideo = async () => {
    if (!videoUploadFile) {
      setUploadMsg('Select a video file first')
      return
    }
    try {
      const form = new FormData()
      form.append('file', videoUploadFile)
      const title = videoUploadTitle.trim() || videoUploadFile.name.replace(/\.[^.]+$/, '')
      const description = videoUploadDesc.trim()
      const r = await fetch(`/api/videos/upload?title=${encodeURIComponent(title)}&description=${encodeURIComponent(description)}`, {
        method: 'POST',
        body: form,
      })
      const t = await r.text()
      const payload = parseMaybeJson(t)
      if (!r.ok) throw new Error(payload.detail || payload.raw || 'Upload failed')
      setUploadMsg(`Video uploaded: ID ${payload.video_id}`)
      setVideoUploadFile(null)
      setVideoUploadTitle('')
      setVideoUploadDesc('')
      await fetchVideos()
    } catch (e) {
      setUploadMsg(`Video upload error: ${e.message}`)
    }
  }

  const editVideo = async (videoItem) => {
    const nextTitle = window.prompt('Update video title', videoItem.title)
    if (nextTitle === null) return
    const nextDesc = window.prompt('Update video description', videoItem.description || '')
    if (nextDesc === null) return
    try {
      const r = await fetch(`/api/videos/${videoItem.id}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: nextTitle, description: nextDesc }),
      })
      const t = await r.text()
      const payload = parseMaybeJson(t)
      if (!r.ok) throw new Error(payload.detail || payload.raw || 'Video update failed')
      setUploadMsg(`Video updated: ${payload.item?.title}`)
      await fetchVideos()
    } catch (e) {
      setUploadMsg(`Video update error: ${e.message}`)
    }
  }

  const deleteVideo = async (videoItem) => {
    if (!window.confirm(`Delete video "${videoItem.title}"?`)) return
    try {
      const r = await fetch(`/api/videos/${videoItem.id}?remove_storage=true`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const t = await r.text()
      const payload = parseMaybeJson(t)
      if (!r.ok) throw new Error(payload.detail || payload.raw || 'Video delete failed')
      setUploadMsg(`Video deleted: ${videoItem.title}`)
      await fetchVideos()
      await fetchSeriesOverview()
    } catch (e) {
      setUploadMsg(`Video delete error: ${e.message}`)
    }
  }

  const uploadVideoThumbnailById = async (videoId) => {
    const file = videoThumbFileById[videoId]
    if (!file) {
      setUploadMsg('Select a thumbnail file first')
      return
    }
    try {
      const form = new FormData()
      form.append('file', file)
      const r = await fetch(`/api/videos/${videoId}/thumbnail`, {
        method: 'POST',
        body: form,
      })
      const t = await r.text()
      const payload = parseMaybeJson(t)
      if (!r.ok) throw new Error(payload.detail || payload.raw || 'Thumbnail upload failed')
      setUploadMsg(`Thumbnail updated for video ${videoId}`)
      setVideoThumbFileById(prev => {
        const copy = { ...prev }
        delete copy[videoId]
        return copy
      })
      await fetchVideos()
    } catch (e) {
      setUploadMsg(`Thumbnail upload error: ${e.message}`)
    }
  }

  const deleteVideoThumbnailById = async (videoId) => {
    if (!window.confirm(`Delete thumbnail for video ${videoId}?`)) return
    try {
      const r = await fetch(`/api/videos/${videoId}/thumbnail`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const t = await r.text()
      const payload = parseMaybeJson(t)
      if (!r.ok) throw new Error(payload.detail || payload.raw || 'Thumbnail delete failed')
      setUploadMsg(`Thumbnail deleted for video ${videoId}`)
      await fetchVideos()
      await fetchSeriesOverview()
    } catch (e) {
      setUploadMsg(`Thumbnail delete error: ${e.message}`)
    }
  }

  const uploadSeriesThumbnail = async (seriesId) => {
    if (!seriesThumbFile) {
      setUploadMsg('Select a series thumbnail first')
      return
    }
    try {
      const form = new FormData()
      form.append('file', seriesThumbFile)
      const r = await fetch(`/api/catalog/admin/series/${seriesId}/thumbnail`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      })
      const t = await r.text()
      const payload = parseMaybeJson(t)
      if (!r.ok) throw new Error(payload.detail || payload.raw || 'Series thumbnail upload failed')
      setUploadMsg('Series thumbnail updated')
      setSeriesThumbFile(null)
      await fetchSeriesOverview()
    } catch (e) {
      setUploadMsg(`Series thumbnail error: ${e.message}`)
    }
  }

  const deleteSeriesThumbnail = async (seriesId) => {
    if (!window.confirm('Delete this series thumbnail?')) return
    try {
      const r = await fetch(`/api/catalog/admin/series/${seriesId}/thumbnail`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const t = await r.text()
      const payload = parseMaybeJson(t)
      if (!r.ok) throw new Error(payload.detail || payload.raw || 'Series thumbnail delete failed')
      setUploadMsg('Series thumbnail deleted')
      await fetchSeriesOverview()
    } catch (e) {
      setUploadMsg(`Series thumbnail delete error: ${e.message}`)
    }
  }

  const uploadEpisodeThumbnail = async (episode) => {
    setUploadMsg('')
    if (!episode.video_id) {
      setUploadMsg(`Upload video first for S${modalSeason?.season_number}:E${episode.episode_number}`)
      return
    }

    const file = thumbByEpisode[episode.episode_id]
    if (!file) {
      setUploadMsg(`Select an image for S${modalSeason?.season_number}:E${episode.episode_number}`)
      return
    }

    try {
      setUploadingThumbEpisodeId(episode.episode_id)
      const form = new FormData()
      form.append('file', file)

      const r = await fetch(`/api/videos/${episode.video_id}/thumbnail`, {
        method: 'POST',
        body: form,
      })
      const payloadText = await r.text()
      const payload = parseMaybeJson(payloadText)
      if (!r.ok) throw new Error(payload.detail || payload.raw || 'Thumbnail upload failed')

      setUploadMsg(`Thumbnail uploaded for episode ${episode.episode_number} (video ${episode.video_id}).`)
      setThumbByEpisode(prev => {
        const copy = { ...prev }
        delete copy[episode.episode_id]
        return copy
      })
      await fetchSeriesOverview()
    } catch (e) {
      setUploadMsg(`Thumbnail upload error: ${e.message}`)
    } finally {
      setUploadingThumbEpisodeId(null)
    }
  }

  const startSeedCatalog = async () => {
    setSeedMsg('')
    try {
      const r = await fetch('/api/catalog/admin/seed-catalog', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          movie_limit: 100,
          series_limit: 40,
          max_seasons_per_series: 2,
          max_episodes_per_season: 10,
          reset_movies: true,
          reset_series: true,
        }),
      })
      const txt = await r.text()
      const payload = parseMaybeJson(txt)
      if (!r.ok) throw new Error(payload.detail || payload.raw || 'Failed to start seed job')
      setSeedMsg('Catalog seed started.')
      await fetchSeedStatus()
    } catch (e) {
      setSeedMsg(`Seed start error: ${e.message}`)
    }
  }

  return (
    <div className="admin-shell" style={{ padding: '32px 40px' }}>
      {/* Header */}
      <div className="admin-panel" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24, padding: '14px 16px' }}>
        <h2 style={{ fontSize: 22, letterSpacing: 0.2 }}>{isContentMode ? 'Content Manager' : 'Admin Dashboard'}</h2>
        <div style={{ width: 9, height: 9, borderRadius: '50%',
                      background: connected ? '#46d369' : '#e50914' }} />
        <span className="admin-chip">{connected ? 'Live (WebSocket)' : 'Connecting…'}</span>
        {data && (
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#555' }}>
            {new Date(data.timestamp).toLocaleTimeString()}
          </span>
        )}
      </div>

      {!isContentMode && (
        <>
          {/* Summary */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 24 }}>
            <StatCard label="Active Sessions" value={data?.active_sessions ?? 0} color="#46d369" />
            <StatCard label="CDN Nodes" value={data?.cdn_nodes?.length ?? 0} color="#e50914" />
            <StatCard label="Buffer Events" value={data?.recent_events?.length ?? 0} color="#f5a623" />
          </div>

          {!data && (
            <div style={{ color: '#555', textAlign: 'center', marginTop: 8, marginBottom: 22 }}>
              Live telemetry not connected yet. Catalog tools are available in Content Manager.
            </div>
          )}

          {/* CDN nodes */}
          <Section title="CDN Node Health">
            {data?.cdn_nodes?.length > 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                {data.cdn_nodes.map(n => (
                  <CDNCard key={n.id} node={n} />
                ))}
              </div>
            ) : (
              <Empty msg="No CDN node telemetry yet." />
            )}
          </Section>

          {/* Active sessions */}
          <Section title="Active Sessions">
            {data?.sessions?.length > 0 ? (
              <div className="admin-panel admin-table-wrap" style={{ padding: 10 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    {['Session', 'Video', 'Quality', 'CDN Node'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '8px 12px',
                                           color: '#555', borderBottom: '1px solid #2a2a2a' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.sessions.map(s => (
                    <tr key={s.id} style={{ borderBottom: '1px solid #1e1e1e' }}>
                      <td style={{ padding: '8px 12px' }}>{s.id}</td>
                      <td style={{ padding: '8px 12px' }}>Video {s.video_id}</td>
                      <td style={{ padding: '8px 12px', color: '#46d369' }}>{s.quality}</td>
                      <td style={{ padding: '8px 12px', color: '#aaa' }}>{s.cdn_node_id ?? 'origin'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            ) : (
              <Empty msg="No active sessions." />
            )}
          </Section>

          {/* Buffer events */}
          <Section title="Recent Buffer Events">
            {data?.recent_events?.length > 0 ? (
              <div className="admin-panel" style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: 8 }}>
                {data.recent_events.map((e, i) => (
                  <BufferEventRow key={i} event={e} />
                ))}
              </div>
            ) : (
              <Empty msg="No buffer events yet." />
            )}
          </Section>
        </>
      )}

      {isContentMode && <Section title="Episode Asset Manager">
        <div className="admin-panel" style={{ padding: 14 }}>
              <div style={{ marginBottom: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  value={newSeriesTitle}
                  onChange={e => setNewSeriesTitle(e.target.value)}
                  placeholder="New series title"
                  style={{ background: '#0f0f0f', border: '1px solid #333', color: '#fff', borderRadius: 4, padding: '8px 10px', minWidth: 240 }}
                />
                <input
                  value={newSeriesSynopsis}
                  onChange={e => setNewSeriesSynopsis(e.target.value)}
                  placeholder="Series description"
                  style={{ background: '#0f0f0f', border: '1px solid #333', color: '#fff', borderRadius: 4, padding: '8px 10px', minWidth: 320 }}
                />
                <button
                  type="button"
                  onClick={createSeries}
                  style={{ background: '#e50914', color: '#fff', border: 'none', borderRadius: 4, padding: '8px 12px', cursor: 'pointer', fontWeight: 700 }}
                >
                  Create Series
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 12, color: '#aaa' }}>Select any title to manage episodes and thumbnails.</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    value={seriesSearch}
                    onChange={e => setSeriesSearch(e.target.value)}
                    placeholder="Search series..."
                    style={{ background: '#0f0f0f', border: '1px solid #333', color: '#fff', borderRadius: 4, padding: '7px 10px', minWidth: 220 }}
                  />
                  <button type="button" onClick={fetchSeriesOverview} style={{ background: 'transparent', color: '#aaa', border: '1px solid #444', borderRadius: 4, padding: '7px 10px', cursor: 'pointer' }}>
                    Refresh
                  </button>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 10, marginBottom: 12 }}>
                {series.filter(x => {
                  const q = seriesSearch.trim().toLowerCase()
                  if (!q) return true
                  return (x.title || '').toLowerCase().includes(q)
                }).map(sr => {
                  const active = selectedSeries?.series_id === sr.series_id
                  return (
                    <button
                      key={sr.series_id}
                      onClick={() => {
                        selectSeries(sr)
                        setModalSeries(sr)
                        setModalSeason(sr.seasons?.[0] || null)
                      }}
                      style={{
                        textAlign: 'left', background: active ? '#2b1113' : '#111', color: '#fff',
                        border: active ? '1px solid #e50914' : '1px solid #2a2a2a', borderRadius: 6,
                        padding: 10, cursor: 'pointer',
                      }}
                    >
                      <div
                        style={{
                          width: '100%',
                          aspectRatio: '16 / 9',
                          borderRadius: 5,
                          marginBottom: 8,
                          backgroundSize: 'cover',
                          backgroundPosition: 'center',
                          backgroundImage: `url(${sr.thumbnail_url || sr.poster_url || '/default-thumbnail.svg'})`,
                        }}
                      />
                      <div style={{ fontSize: 12, fontWeight: 700 }}>{sr.title}</div>
                      <div style={{ fontSize: 11, color: '#999', marginTop: 5 }}>
                        {sr.is_movie ? 'Movie' : 'Series'} • Episodes: {sr.total_episodes} • Missing: <span style={{ color: sr.missing_episodes > 0 ? '#e50914' : '#46d369' }}>{sr.missing_episodes}</span>
                      </div>
                    </button>
                  )
                })}
              </div>

              {uploadMsg && <div style={{ marginTop: 10, fontSize: 12, color: '#f5a623' }}>{uploadMsg}</div>}
            </div>
      </Section>}

      {isContentMode && modalSeries && (
        <div
          onClick={() => { setModalSeries(null); setModalSeason(null) }}
          style={{
            position: 'fixed', inset: 0, zIndex: 2000,
            background: 'rgba(0,0,0,0.72)',
            display: 'flex', justifyContent: 'center', alignItems: 'center',
            padding: 20,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 'min(1100px, 96vw)',
              maxHeight: '90vh',
              overflow: 'auto',
              background: '#141414',
              border: '1px solid #2a2a2a',
              borderRadius: 10,
              padding: 18,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{modalSeries.title}</div>
                <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
                  {modalSeries.is_movie ? 'Movie' : 'Series'} • Missing episodes: {modalSeries.missing_episodes}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => editSeries(modalSeries)}
                  style={{ background: '#1f1f1f', border: '1px solid #444', color: '#fff', borderRadius: 4, padding: '6px 10px', cursor: 'pointer' }}
                >
                  Edit Series
                </button>
                <button
                  onClick={() => deleteSeries(modalSeries)}
                  style={{ background: '#6a0a10', border: '1px solid #8f121b', color: '#fff', borderRadius: 4, padding: '6px 10px', cursor: 'pointer' }}
                >
                  Delete Series
                </button>
                <button
                  onClick={() => { setModalSeries(null); setModalSeason(null) }}
                  style={{ background: 'none', border: '1px solid #444', color: '#aaa', borderRadius: 4, padding: '6px 10px', cursor: 'pointer' }}
                >
                  Close
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
              <div
                style={{
                  width: 220,
                  aspectRatio: '16 / 9',
                  borderRadius: 8,
                  border: '1px solid #333',
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  backgroundImage: `url(${modalSeries.thumbnail_url || modalSeries.poster_url || '/default-thumbnail.svg'})`,
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={e => setSeriesThumbFile(e.target.files?.[0] || null)}
                  style={{ color: '#aaa' }}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => uploadSeriesThumbnail(modalSeries.series_id)}
                    style={{ background: '#333', color: '#fff', border: '1px solid #555', borderRadius: 4, padding: '7px 10px', cursor: 'pointer' }}
                  >
                    Upload Series Thumbnail
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteSeriesThumbnail(modalSeries.series_id)}
                    style={{ background: '#2a2a2a', color: '#fff', border: '1px solid #555', borderRadius: 4, padding: '7px 10px', cursor: 'pointer' }}
                  >
                    Delete Series Thumbnail
                  </button>
                </div>
                <div style={{ fontSize: 12, color: '#999', maxWidth: 500 }}>
                  {modalSeries.synopsis || 'No series description yet.'}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              {modalSeries.seasons?.map(ss => (
                <button
                  key={ss.season_id}
                  onClick={() => setModalSeason(ss)}
                  style={{
                    borderRadius: 4,
                    border: modalSeason?.season_id === ss.season_id ? '1px solid #e50914' : '1px solid #333',
                    background: modalSeason?.season_id === ss.season_id ? '#2b1113' : '#111',
                    color: modalSeason?.season_id === ss.season_id ? '#fff' : '#aaa',
                    fontSize: 12,
                    padding: '6px 10px',
                    cursor: 'pointer',
                  }}
                >
                  Season {ss.season_number}
                </button>
              ))}
            </div>

            {modalSeason && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
                <input
                  value={newEpisodeTitle}
                  onChange={e => setNewEpisodeTitle(e.target.value)}
                  placeholder="New episode title"
                  style={{ background: '#0f0f0f', border: '1px solid #333', color: '#fff', borderRadius: 4, padding: '8px 10px', minWidth: 240 }}
                />
                <input
                  value={newEpisodeSynopsis}
                  onChange={e => setNewEpisodeSynopsis(e.target.value)}
                  placeholder="Episode description"
                  style={{ background: '#0f0f0f', border: '1px solid #333', color: '#fff', borderRadius: 4, padding: '8px 10px', minWidth: 300 }}
                />
                <input
                  type="number"
                  min="1"
                  value={newEpisodeNumber}
                  onChange={e => setNewEpisodeNumber(e.target.value)}
                  style={{ width: 90, background: '#0f0f0f', border: '1px solid #333', color: '#fff', borderRadius: 4, padding: '8px 10px' }}
                />
                <button
                  type="button"
                  onClick={createEpisode}
                  style={{ background: '#e50914', color: '#fff', border: 'none', borderRadius: 4, padding: '8px 12px', cursor: 'pointer', fontWeight: 700 }}
                >
                  Add Episode
                </button>
              </div>
            )}

            <div style={{ maxHeight: 420, overflow: 'auto', borderTop: '1px solid #2a2a2a', paddingTop: 10 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    {['Ep', 'Title', 'Status', 'Select Video', 'Select Thumbnail', 'Actions'].map(h => (
                      <th key={h} style={{ textAlign: 'left', color: '#777', padding: '6px 8px', borderBottom: '1px solid #2a2a2a' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(modalSeason?.episodes || []).map(ep => (
                    <tr key={ep.episode_id}>
                      <td style={{ padding: '8px' }}>{ep.episode_number}</td>
                      <td style={{ padding: '8px' }}>{ep.title}</td>
                      <td style={{ padding: '8px', color: ep.missing_video ? '#e50914' : '#46d369' }}>
                        {ep.missing_video ? 'Missing' : `Ready (video ${ep.video_id})`}
                      </td>
                      <td style={{ padding: '8px' }}>
                        <input
                          type="file"
                          accept="video/mp4"
                          onChange={e => setFileByEpisode(prev => ({ ...prev, [ep.episode_id]: e.target.files?.[0] || null }))}
                          style={{ color: '#aaa' }}
                        />
                      </td>
                      <td style={{ padding: '8px' }}>
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          onChange={e => setThumbByEpisode(prev => ({ ...prev, [ep.episode_id]: e.target.files?.[0] || null }))}
                          style={{ color: '#aaa' }}
                        />
                      </td>
                      <td style={{ padding: '8px' }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <button
                            onClick={() => uploadEpisodeVideo(ep)}
                            disabled={uploadingEpisodeId === ep.episode_id}
                            style={{
                              background: '#e50914', color: '#fff', border: 'none', borderRadius: 4,
                              padding: '7px 10px', cursor: 'pointer',
                              opacity: uploadingEpisodeId === ep.episode_id ? 0.6 : 1,
                            }}
                          >
                            {uploadingEpisodeId === ep.episode_id ? 'Uploading…' : 'Upload Video'}
                          </button>

                          <button
                            onClick={() => uploadEpisodeThumbnail(ep)}
                            disabled={uploadingThumbEpisodeId === ep.episode_id || !ep.video_id}
                            style={{
                              background: '#333', color: '#fff', border: '1px solid #555', borderRadius: 4,
                              padding: '7px 10px', cursor: ep.video_id ? 'pointer' : 'not-allowed',
                              opacity: (uploadingThumbEpisodeId === ep.episode_id || !ep.video_id) ? 0.6 : 1,
                            }}
                          >
                            {uploadingThumbEpisodeId === ep.episode_id ? 'Uploading…' : 'Upload Thumbnail'}
                          </button>

                          <button
                            onClick={() => editEpisode(ep)}
                            style={{
                              background: '#1f1f1f', color: '#fff', border: '1px solid #555', borderRadius: 4,
                              padding: '7px 10px', cursor: 'pointer',
                            }}
                          >
                            Edit
                          </button>

                          <button
                            onClick={() => deleteEpisode(ep)}
                            style={{
                              background: '#6a0a10', color: '#fff', border: '1px solid #8f121b', borderRadius: 4,
                              padding: '7px 10px', cursor: 'pointer',
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, color }) {
  return (
    <div className="admin-panel" style={{ padding: 20, textAlign: 'center' }}>
      <div style={{ fontSize: 36, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 12, color: '#555', marginTop: 6 }}>{label}</div>
    </div>
  )
}

function CDNCard({ node }) {
  const alive = node.status === 'active'
  return (
    <div style={{
      background: '#1c1c1c', borderRadius: 10, padding: 14,
      border: `1px solid ${alive ? '#46d36922' : '#e5091422'}`,
      boxShadow: '0 10px 18px rgba(0,0,0,0.25)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{node.name}</span>
        <span style={{ fontSize: 11, color: alive ? '#46d369' : '#e50914' }}>
          {alive ? '● Online' : '● Offline'}
        </span>
      </div>
      <div style={{ fontSize: 12, color: '#555', lineHeight: 1.9 }}>
        <div>Latency: <span style={{ color: '#fff' }}>{node.latency_ms} ms</span></div>
        <div>Load:    <LoadBar value={node.load_percent} /></div>
        <div>Cache Hit: <span style={{ color: '#46d369' }}>{node.cache_hit_ratio}%</span></div>
      </div>
    </div>
  )
}

function BufferEventRow({ event }) {
  const zc = { reservoir: '#e50914', cushion: '#f5a623', upper_reservoir: '#46d369' }
  return (
    <div style={{ background: '#171717', borderRadius: 6, padding: '9px 12px',
                  display: 'flex', gap: 20, fontSize: 12, flexWrap: 'wrap' }}>
      <span style={{ color: '#555' }}>{new Date(event.timestamp).toLocaleTimeString()}</span>
      <span>Session <b>{event.session_id}</b></span>
      <span>Buffer: <span style={{ color: '#f5a623' }}>{event.buffer_seconds?.toFixed(1)}s</span></span>
      <span>Zone: <span style={{ color: zc[event.buffer_zone] || '#aaa' }}>{event.buffer_zone}</span></span>
      <span>Quality: <span style={{ color: '#46d369' }}>{event.quality}</span></span>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <h3 style={{ fontSize: 13, color: '#777', letterSpacing: 1.2, marginBottom: 12, fontWeight: 700 }}>
        {title.toUpperCase()}
      </h3>
      {children}
    </div>
  )
}

function Empty({ msg }) {
  return (
    <div className="admin-panel" style={{ padding: 20,
                  color: '#444', fontSize: 13, textAlign: 'center' }}>
      {msg}
    </div>
  )
}

function LoadBar({ value }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, verticalAlign: 'middle' }}>
      <span style={{ display: 'inline-block', width: 56, height: 5, background: '#2a2a2a', borderRadius: 3 }}>
        <span style={{ display: 'block', height: '100%', borderRadius: 3,
                        width: `${Math.min(100, value)}%`,
                        background: value > 80 ? '#e50914' : '#f5a623' }} />
      </span>
      <span style={{ color: '#fff' }}>{value.toFixed(0)}%</span>
    </span>
  )
}

function parseMaybeJson(text) {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}
