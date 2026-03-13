import { useEffect, useState } from 'react'

export default function CatalogHome({ token, onPlayEpisode }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/catalog/home', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async r => {
        const payload = await r.json()
        if (!r.ok) throw new Error(payload.detail || 'Failed to load catalog')
        setData(payload)
      })
      .catch(e => setError(e.message))
  }, [token])

  if (error) {
    return <div style={{ padding: 40, color: '#e50914' }}>Catalog error: {error}</div>
  }
  if (!data) {
    return <div style={{ padding: 40, color: '#aaa' }}>Loading catalog…</div>
  }

  const hero = data.hero

  return (
    <div>
      {hero && (
        <HeroBanner hero={hero} onPlay={() => onPlayEpisode(1)} />
      )}

      <div style={{ marginTop: -80, position: 'relative', zIndex: 2, paddingBottom: 36 }}>
        {data.rows?.map(row => (
          <Row
            key={row.id}
            title={row.title}
            items={row.items}
            type={row.type}
            onPlayEpisode={onPlayEpisode}
          />
        ))}
      </div>
    </div>
  )
}

function HeroBanner({ hero, onPlay }) {
  return (
    <div style={{
      height: 560,
      backgroundImage: `linear-gradient(to top, #141414 8%, rgba(20,20,20,0.3) 40%, rgba(20,20,20,0.4) 100%), url(${hero.backdrop_url})`,
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

function Row({ title, items, type, onPlayEpisode }) {
  return (
    <div style={{ padding: '0 48px', marginTop: 28 }}>
      <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 10 }}>{title}</div>
      <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 10 }}>
        {items?.map((item, idx) => (
          <Card
            key={`${title}-${idx}`}
            item={item}
            onClick={() => {
              if (type === 'episode') onPlayEpisode(item.episode_id)
            }}
            clickable={type === 'episode'}
          />
        ))}
      </div>
    </div>
  )
}

function Card({ item, onClick, clickable }) {
  const [hover, setHover] = useState(false)
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
          backgroundImage: `url(${item.poster_url || item.backdrop_url || ''})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          position: 'relative',
          backgroundColor: '#333',
        }}
      >
        {clickable && !item.playable && (
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
          {item.subtitle || `${item.year || ''} ${item.maturity || ''}`}
        </div>
      </div>
    </div>
  )
}
