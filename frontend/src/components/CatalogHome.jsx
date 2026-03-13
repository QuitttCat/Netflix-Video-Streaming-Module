import { useEffect, useState } from 'react'

export default function CatalogHome({ token, onPlayEpisode, onPlayVideo, onPlaySeries }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [seriesModal, setSeriesModal] = useState(null)
  const [seriesEpisodes, setSeriesEpisodes] = useState([])
  const [seriesEpisodesLoading, setSeriesEpisodesLoading] = useState(false)
  const [seriesModalMsg, setSeriesModalMsg] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    fetch('/api/catalog/home', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async r => {
        const payloadText = await r.text()
        const payload = payloadText ? JSON.parse(payloadText) : {}
        if (!r.ok) throw new Error(payload.detail || 'Failed to load catalog')
        if (alive) {
          setData(payload)
          setError('')
        }
      })
      .catch(e => {
        if (alive) setError(e.message)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })

    return () => {
      alive = false
    }
  }, [token])

  if (error) {
    return (
      <div style={{ padding: 40 }}>
        <div style={{ color: '#e50914', marginBottom: 14 }}>Catalog error: {error}</div>
        <button
          onClick={() => window.location.reload()}
          style={{
            background: '#e50914', color: '#fff', border: 'none', borderRadius: 4,
            padding: '8px 14px', cursor: 'pointer', fontWeight: 700,
          }}
        >
          Reload
        </button>
      </div>
    )
  }
  if (loading || !data) {
    return <div style={{ padding: 40, color: '#aaa' }}>Loading catalog…</div>
  }

  const hero = data.hero
  const rows = Array.isArray(data.rows) ? data.rows : []
  const continueRow = rows.find(r => r.id === 'continue')
  const firstEpisodeId = continueRow?.items?.[0]?.episode_id || 1
  const hasAnyItems = rows.some(r => (r.items?.length || 0) > 0)

  const openSeriesModal = async (seriesItem) => {
    setSeriesModal(seriesItem)
    setSeriesEpisodes([])
    setSeriesModalMsg('')
    setSeriesEpisodesLoading(true)
    try {
      const r = await fetch(`/api/catalog/series/${seriesItem.series_id}/episodes`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const payloadText = await r.text()
      const payload = payloadText ? JSON.parse(payloadText) : {}
      if (!r.ok) throw new Error(payload.detail || 'Failed to load episodes')

      if (payload.series) {
        setSeriesModal(payload.series)
      }

      const episodes = Array.isArray(payload.episodes) ? payload.episodes : []
      setSeriesEpisodes(episodes)

      const playableCount = episodes.filter(ep => ep.playable && ep.video_id).length
      if (episodes.length === 0) {
        setSeriesModalMsg('No episodes found for this title yet.')
      } else if (playableCount === 0) {
        setSeriesModalMsg('Episodes exist, but no episode is uploaded and playable yet.')
      }
    } catch (e) {
      setSeriesModalMsg(e.message)
    } finally {
      setSeriesEpisodesLoading(false)
    }
  }

  const handleSeriesEpisodeClick = async (episode) => {
    if (!episode.playable || !episode.video_id) {
      setSeriesModalMsg(`S${episode.season_number}:E${episode.episode_number} is not uploaded yet.`)
      return
    }
    setSeriesModal(null)
    setSeriesModalMsg('')
    await onPlayEpisode(episode.episode_id)
  }

  return (
    <div className="home-shell">
      {hero && (
        <HeroBanner hero={hero} onPlay={() => onPlayEpisode(firstEpisodeId)} />
      )}

      <div style={{ marginTop: -80, position: 'relative', zIndex: 2, paddingBottom: 36 }}>
        {rows.map(row => (
          <Row
            key={row.id}
            title={row.title}
            items={row.items}
            type={row.type}
            onPlayEpisode={onPlayEpisode}
            onPlayVideo={onPlayVideo}
            onPlaySeries={onPlaySeries}
            onOpenSeries={openSeriesModal}
          />
        ))}

        {!hasAnyItems && (
          <div style={{ padding: '0 48px', marginTop: 20, color: '#b3b3b3' }}>
            No catalog items yet. Seed catalog from admin dashboard.
          </div>
        )}
      </div>

      {seriesModal && (
        <SeriesEpisodesModal
          series={seriesModal}
          episodes={seriesEpisodes}
          loading={seriesEpisodesLoading}
          message={seriesModalMsg}
          onClose={() => {
            setSeriesModal(null)
            setSeriesModalMsg('')
          }}
          onPlayEpisode={handleSeriesEpisodeClick}
        />
      )}
    </div>
  )
}

function HeroBanner({ hero, onPlay }) {
  const fallbackBg =
    'linear-gradient(135deg, rgba(229,9,20,0.35) 0%, rgba(20,20,20,1) 50%, rgba(20,20,20,1) 100%)'
  const withImage = hero.backdrop_url
    ? `linear-gradient(to top, #141414 8%, rgba(20,20,20,0.3) 40%, rgba(20,20,20,0.4) 100%), url(${hero.backdrop_url})`
    : fallbackBg

  return (
    <div style={{
      minHeight: 620,
      backgroundImage: withImage,
      backgroundSize: 'cover',
      backgroundPosition: 'center top',
      display: 'flex',
      alignItems: 'flex-end',
      padding: '0 48px 90px',
      boxSizing: 'border-box',
    }}>
      <div className="hero-content" style={{ maxWidth: 620 }}>
        <div style={{ fontSize: 54, fontWeight: 800, marginBottom: 16, textShadow: '0 2px 20px rgba(0,0,0,0.65)' }}>
          {hero.title}
        </div>
        <div style={{ color: '#d2d2d2', lineHeight: 1.6, marginBottom: 20, fontSize: 17, maxWidth: 560 }}>
          {hero.synopsis}
        </div>

        <div className="hero-actions">
          <button className="btn-primary" onClick={onPlay}>▶ Play</button>
          <button className="btn-secondary" onClick={onPlay}>ⓘ More Info</button>
        </div>
      </div>
    </div>
  )
}

function Row({ title, items, type, onPlayEpisode, onPlayVideo, onPlaySeries, onOpenSeries }) {
  const list = Array.isArray(items) ? items : []
  return (
    <div style={{ padding: '0 48px', marginTop: 28 }}>
      <div className="nf-row-title">{title}</div>
      <div className="nf-row-scroll">
        {list.length === 0 && (
          <div style={{ color: '#777', fontSize: 13, padding: '10px 2px' }}>
            No items available.
          </div>
        )}

        {list.map((item, idx) => (
          <Card
            key={`${title}-${idx}`}
            item={item}
            onClick={() => {
              if (type === 'episode') onPlayEpisode(item.episode_id)
              if (type === 'video') onPlayVideo(item)
              if (type === 'series') onOpenSeries?.(item)
            }}
            clickable={type === 'episode' || type === 'video' || type === 'series'}
          />
        ))}
      </div>
    </div>
  )
}

function SeriesEpisodesModal({ series, episodes, loading, message, onClose, onPlayEpisode }) {
  const heroImage = series.backdrop_url || series.poster_url || '/default-thumbnail.svg'

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1500,
        background: 'rgba(0,0,0,0.78)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 22,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="admin-panel"
        style={{ width: 'min(980px, 96vw)', maxHeight: '90vh', overflow: 'auto', padding: 0 }}
      >
        <div
          style={{
            position: 'relative',
            minHeight: 240,
            backgroundImage: `linear-gradient(to top, rgba(20,20,20,0.95), rgba(20,20,20,0.35)), url(${heroImage})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            borderTopLeftRadius: 10,
            borderTopRightRadius: 10,
            padding: '22px 22px 18px',
          }}
        >
          <button
            onClick={onClose}
            style={{
              position: 'absolute',
              top: 14,
              right: 14,
              width: 34,
              height: 34,
              borderRadius: '50%',
              border: '1px solid rgba(255,255,255,0.35)',
              background: 'rgba(0,0,0,0.45)',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 16,
            }}
          >
            ✕
          </button>

          <div style={{ fontSize: 30, fontWeight: 800, marginTop: 18 }}>{series.title}</div>
          <div style={{ marginTop: 8, color: '#ddd', lineHeight: 1.6, maxWidth: 760 }}>
            {series.synopsis || 'No description available yet.'}
          </div>
        </div>

        <div style={{ padding: 18 }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>Episodes</div>

          {loading && <div style={{ color: '#aaa' }}>Loading episodes…</div>}
          {!loading && message && (
            <div style={{ marginBottom: 10, color: '#f5a623', fontSize: 13 }}>{message}</div>
          )}

          {!loading && episodes.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {episodes.map(ep => {
                const ready = ep.playable && ep.video_id
                const dur = ep.duration_sec ? `${Math.floor(ep.duration_sec / 60)}m ${ep.duration_sec % 60}s` : '—'
                return (
                  <button
                    key={ep.episode_id}
                    onClick={() => onPlayEpisode(ep)}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '120px 1fr auto',
                      gap: 12,
                      alignItems: 'center',
                      textAlign: 'left',
                      border: ready ? '1px solid #2f2f2f' : '1px solid #4b3120',
                      background: ready ? '#141414' : '#1f1712',
                      color: '#fff',
                      borderRadius: 8,
                      padding: 10,
                      cursor: 'pointer',
                    }}
                  >
                    <div
                      style={{
                        borderRadius: 6,
                        aspectRatio: '16 / 9',
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                        backgroundImage: ep.thumbnail_url
                          ? `url(${ep.thumbnail_url})`
                          : 'linear-gradient(120deg,#363636,#212121)',
                      }}
                    />
                    <div>
                      <div style={{ fontWeight: 700 }}>
                        S{ep.season_number}:E{ep.episode_number} • {ep.title}
                      </div>
                      <div style={{ marginTop: 5, color: '#aaa', fontSize: 12 }}>{ep.synopsis || 'No synopsis available.'}</div>
                    </div>
                    <div style={{ textAlign: 'right', minWidth: 120 }}>
                      <div style={{ fontSize: 12, color: '#bbb' }}>{dur}</div>
                      <div style={{ marginTop: 6, fontSize: 12, color: ready ? '#46d369' : '#f5a623' }}>
                        {ready ? 'Play now' : 'Not uploaded yet'}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Card({ item, onClick, clickable }) {
  const [hover, setHover] = useState(false)
  const imageUrl = item.thumbnail_url || item.poster_url || item.backdrop_url || '/default-thumbnail.svg'

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={clickable ? onClick : undefined}
      className="nf-card"
      style={{ cursor: clickable ? 'pointer' : 'default', transform: hover ? 'scale(1.08)' : 'scale(1)' }}
    >
      <div
        className="nf-card-media"
        style={{
          backgroundImage: imageUrl
            ? `url(${imageUrl})`
            : 'linear-gradient(120deg, #363636 0%, #222 100%)',
          backgroundColor: '#333',
        }}
      >
        <div className="nf-card-overlay-play"><span>▶</span></div>

        {!imageUrl && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#d2d2d2', fontSize: 12, fontWeight: 700, letterSpacing: 0.8,
          }}>
            {item.content_type === 'movie' ? 'MOVIE' : 'TITLE'}
          </div>
        )}

        {clickable && item.playable === false && (
          <span style={{
            position: 'absolute', top: 8, right: 8, fontSize: 11,
            background: 'rgba(229,9,20,0.9)', padding: '4px 8px', borderRadius: 3,
          }}>
            DEMO ONLY
          </span>
        )}
      </div>
      <div style={{ padding: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 13.5 }}>{item.title}</div>
        <div style={{ fontSize: 13, color: '#9a9a9a', marginTop: 5, minHeight: 18 }}>
          {item.subtitle || (item.duration_seconds ? `${item.duration_seconds}s` : `${item.year || ''} ${item.maturity || ''}`)}
        </div>
      </div>
    </div>
  )
}
