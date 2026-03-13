import { useEffect, useState } from 'react'

export default function CatalogHome({ token, onPlayEpisode, onPlayVideo, onPlaySeries }) {
  const [data, setData] = useState(null)
  const [uploads, setUploads] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

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

  useEffect(() => {
    let alive = true
    fetch('/api/videos?limit=24')
      .then(async r => {
        const payloadText = await r.text()
        const payload = payloadText ? JSON.parse(payloadText) : {}
        if (!r.ok) throw new Error(payload.detail || 'Failed to load videos')
        if (alive) setUploads(Array.isArray(payload.items) ? payload.items : [])
      })
      .catch(() => {
        if (alive) setUploads([])
      })
    return () => {
      alive = false
    }
  }, [])

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
  const hasAnyItems = rows.some(r => (r.items?.length || 0) > 0) || uploads.length > 0

  return (
    <div>
      {hero && (
        <HeroBanner hero={hero} onPlay={() => onPlayEpisode(firstEpisodeId)} />
      )}

      <div style={{ marginTop: -80, position: 'relative', zIndex: 2, paddingBottom: 36 }}>
        <Row
          key="uploads"
          title="Uploaded Videos"
          items={uploads}
          type="video"
          onPlayEpisode={onPlayEpisode}
          onPlayVideo={onPlayVideo}
          onPlaySeries={onPlaySeries}
        />

        {rows.map(row => (
          <Row
            key={row.id}
            title={row.title}
            items={row.items}
            type={row.type}
            onPlayEpisode={onPlayEpisode}
            onPlayVideo={onPlayVideo}
            onPlaySeries={onPlaySeries}
          />
        ))}

        {!hasAnyItems && (
          <div style={{ padding: '0 48px', marginTop: 20, color: '#b3b3b3' }}>
            No catalog items yet. Seed catalog from admin dashboard.
          </div>
        )}
      </div>
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
      height: 560,
      backgroundImage: withImage,
      backgroundSize: 'cover',
      backgroundPosition: 'center top',
      display: 'flex',
      alignItems: 'flex-end',
      padding: '0 48px 90px',
      boxSizing: 'border-box',
    }}>
      <div style={{ maxWidth: 520 }}>
        <div style={{ fontSize: 44, fontWeight: 800, marginBottom: 16, textShadow: '0 2px 12px rgba(0,0,0,0.5)' }}>
          {hero.title}
        </div>
        <div style={{ color: '#d2d2d2', lineHeight: 1.5, marginBottom: 20, fontSize: 15 }}>
          {hero.synopsis}
        </div>
        <button
          onClick={onPlay}
          style={{
            background: '#fff', color: '#111', border: 'none', borderRadius: 4,
            padding: '10px 26px', fontWeight: 700, fontSize: 16, cursor: 'pointer',
          }}
        >
          ▶ Play Demo Episode
        </button>
      </div>
    </div>
  )
}

function Row({ title, items, type, onPlayEpisode, onPlayVideo, onPlaySeries }) {
  const list = Array.isArray(items) ? items : []
  return (
    <div style={{ padding: '0 48px', marginTop: 28 }}>
      <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 10 }}>{title}</div>
      <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 10 }}>
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
              if (type === 'series') onPlaySeries(item.series_id)
            }}
            clickable={type === 'episode' || type === 'video' || type === 'series'}
          />
        ))}
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
      style={{
        minWidth: 220,
        width: 220,
        borderRadius: 6,
        overflow: 'hidden',
        cursor: clickable ? 'pointer' : 'default',
        background: '#222',
        transform: hover ? 'scale(1.07)' : 'scale(1)',
        transition: 'transform 0.18s ease',
      }}
    >
      <div
        style={{
          height: 124,
          backgroundImage: imageUrl
            ? `url(${imageUrl})`
            : 'linear-gradient(120deg, #363636 0%, #222 100%)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          position: 'relative',
          backgroundColor: '#333',
        }}
      >
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
      <div style={{ padding: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>{item.title}</div>
        <div style={{ fontSize: 12, color: '#9a9a9a', marginTop: 4, minHeight: 18 }}>
          {item.subtitle || (item.duration_seconds ? `${item.duration_seconds}s` : `${item.year || ''} ${item.maturity || ''}`)}
        </div>
      </div>
    </div>
  )
}
