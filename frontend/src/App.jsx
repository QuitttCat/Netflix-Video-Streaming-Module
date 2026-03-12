import { useState } from 'react'
import VideoPlayer from './components/VideoPlayer.jsx'
import AdminDashboard from './components/AdminDashboard.jsx'

const VIDEOS = [
  { id: 1, title: 'Demo Episode 1', subtitle: 'Buffering & CDN Demo', emoji: '🎬' },
  { id: 2, title: 'Demo Episode 2', subtitle: 'CDN Failover Demo',    emoji: '🎥' },
]

export default function App() {
  const [view,    setView]    = useState('home')  // 'home' | 'player' | 'admin'
  const [session, setSession] = useState(null)
  const [selVideo, setSelVideo] = useState(null)

  const handlePlay = async (video) => {
    try {
      const r = await fetch(`/api/playback/start?videoId=${video.id}&clientRegion=dhaka`)
      const data = await r.json()
      setSession(data)
      setSelVideo(video)
      setView('player')
    } catch (e) {
      alert('Could not start playback: ' + e.message)
    }
  }

  return (
    <div style={{ minHeight: '100vh' }}>
      <header style={{
        padding: '14px 40px', background: 'rgba(0,0,0,0.85)',
        display: 'flex', alignItems: 'center', gap: 32,
        position: 'sticky', top: 0, zIndex: 100,
      }}>
        <h1 style={{ color: '#e50914', fontSize: 22, fontWeight: 700, letterSpacing: 2 }}>
          NETFLIX DEMO
        </h1>
        <nav style={{ display: 'flex', gap: 20 }}>
          <NavBtn label="Home"       active={view === 'home'}  onClick={() => setView('home')}  />
          <NavBtn label="Dashboard"  active={view === 'admin'} onClick={() => setView('admin')} />
        </nav>
        {view === 'player' && (
          <button
            onClick={() => setView('home')}
            style={{ marginLeft: 'auto', background: 'none', border: '1px solid #555',
                     color: '#aaa', padding: '6px 14px', cursor: 'pointer', borderRadius: 4, fontSize: 13 }}>
            ← Back
          </button>
        )}
      </header>

      {view === 'home' && (
        <div style={{ padding: '48px 40px' }}>
          <h2 style={{ marginBottom: 8,  fontSize: 13, color: '#aaa', letterSpacing: 1 }}>
            CONTINUE WATCHING
          </h2>
          <div style={{ display: 'flex', gap: 16, marginTop: 16 }}>
            {VIDEOS.map(v => (
              <VideoCard key={v.id} video={v} onPlay={() => handlePlay(v)} />
            ))}
          </div>

          <div style={{ marginTop: 48 }}>
            <h2 style={{ marginBottom: 16, fontSize: 13, color: '#aaa', letterSpacing: 1 }}>
              SYSTEM INFO
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <InfoCard title="BBA Algorithm" desc="Buffer-Based Adaptation from Stanford/Netflix 2014 paper. Quality is driven by buffer level, not bandwidth." />
              <InfoCard title="CDN Simulation" desc="3 Docker edge nodes (Dhaka, Chittagong, Sylhet). Each caches segments, sends heartbeats, reports health." />
              <InfoCard title="Preloading" desc="At 90% of episode, next episode chunks are prefetched to CDN. Instant auto-play with no spinner." />
            </div>
          </div>
        </div>
      )}

      {view === 'player' && session && (
        <VideoPlayer session={session} video={selVideo} />
      )}

      {view === 'admin' && <AdminDashboard />}
    </div>
  )
}

function NavBtn({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      background: 'none', border: 'none',
      color: active ? '#fff' : '#aaa',
      fontWeight: active ? 700 : 400,
      fontSize: 14, cursor: 'pointer', padding: '4px 0',
      borderBottom: active ? '2px solid #e50914' : '2px solid transparent',
    }}>
      {label}
    </button>
  )
}

function VideoCard({ video, onPlay }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onClick={onPlay}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 220, background: '#1a1a1a', borderRadius: 6, cursor: 'pointer',
        transform: hover ? 'scale(1.05)' : 'scale(1)',
        transition: 'transform 0.2s',
        border: hover ? '1px solid #e50914' : '1px solid transparent',
        overflow: 'hidden',
      }}
    >
      <div style={{
        height: 124, background: '#2a2a2a',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 48,
      }}>
        {video.emoji}
      </div>
      <div style={{ padding: '10px 12px' }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{video.title}</div>
        <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>{video.subtitle}</div>
      </div>
    </div>
  )
}

function InfoCard({ title, desc }) {
  return (
    <div style={{ background: '#1a1a1a', borderRadius: 6, padding: 16 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 12, color: '#666', lineHeight: 1.6 }}>{desc}</div>
    </div>
  )
}
