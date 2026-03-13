import { useState, useEffect } from 'react'
import VideoPlayer from './components/VideoPlayer.jsx'
import AdminDashboard from './components/AdminDashboard.jsx'
import Login from './components/Login.jsx'
import CatalogHome from './components/CatalogHome.jsx'

export default function App() {
  const [auth,     setAuth]     = useState(null)     // null | { token, user }
  const [view,     setView]     = useState('home')   // 'home' | 'player' | 'admin'
  const [session,  setSession]  = useState(null)
  const [selVideo, setSelVideo] = useState(null)

  // Restore session from localStorage on first load
  useEffect(() => {
    const stored = localStorage.getItem('auth')
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        setAuth(parsed)
        setView(parsed.user.role === 'admin' ? 'admin' : 'home')
      } catch {
        localStorage.removeItem('auth')
      }
    }
  }, [])

  const handleLogin = (authData) => {
    localStorage.setItem('auth', JSON.stringify(authData))
    setAuth(authData)
    setView(authData.user.role === 'admin' ? 'admin' : 'home')
  }

  const handleLogout = () => {
    localStorage.removeItem('auth')
    setAuth(null)
    setView('home')
    setSession(null)
    setSelVideo(null)
  }

  const handlePlayVideo = async (video) => {
    try {
      const r = await fetch(`/api/playback/start?videoId=${video.id}&clientRegion=dhaka&userId=${auth.user.username}`)
      const data = await r.json()
      setSession(data)
      setSelVideo(video)
      setView('player')
    } catch (e) {
      alert('Could not start playback: ' + e.message)
    }
  }

  const handlePlayEpisode = async (episodeId) => {
    try {
      const r = await fetch(`/api/catalog/episodes/${episodeId}/playback`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      const resolved = await r.json()
      if (!r.ok) throw new Error(resolved.detail || 'Could not resolve episode playback')

      if (!resolved.available) {
        alert(resolved.message)
      }

      await handlePlayVideo({
        id: resolved.video_id,
        title: `Episode ${episodeId}`,
        subtitle: resolved.fallback ? 'Demo Fallback' : 'Playable Episode',
      })
    } catch (e) {
      alert(e.message)
    }
  }

  // Not logged in → show login page
  if (!auth) return <Login onLogin={handleLogin} />

  const isAdmin = auth.user.role === 'admin'

  return (
    <div style={{ minHeight: '100vh' }}>
      <header style={{
        padding: '14px 40px', background: 'rgba(0,0,0,0.85)',
        display: 'flex', alignItems: 'center', gap: 32,
        position: 'sticky', top: 0, zIndex: 100,
      }}>
        <h1 style={{ color: '#e50914', fontSize: 22, fontWeight: 700, letterSpacing: 2 }}>
          NETFLIX
        </h1>
        <nav style={{ display: 'flex', gap: 20 }}>
          <NavBtn label="Home"       active={view === 'home'}  onClick={() => setView('home')}  />
          {isAdmin && (
            <NavBtn label="Dashboard" active={view === 'admin'} onClick={() => setView('admin')} />
          )}
        </nav>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16 }}>
          {view === 'player' && (
            <button
              onClick={() => setView('home')}
              style={{ background: 'none', border: '1px solid #555', color: '#aaa',
                       padding: '6px 14px', cursor: 'pointer', borderRadius: 4, fontSize: 13 }}>
              ← Back
            </button>
          )}
          <span style={{ color: '#aaa', fontSize: 13 }}>
            {auth.user.username}
            {isAdmin && (
              <span style={{ color: '#e50914', marginLeft: 6, fontSize: 10, fontWeight: 700,
                             background: 'rgba(229,9,20,0.15)', padding: '2px 6px', borderRadius: 3,
                             border: '1px solid rgba(229,9,20,0.4)' }}>
                ADMIN
              </span>
            )}
          </span>
          <button
            onClick={handleLogout}
            style={{ background: 'none', border: '1px solid #555', color: '#aaa',
                     padding: '6px 14px', cursor: 'pointer', borderRadius: 4, fontSize: 13 }}>
            Sign Out
          </button>
        </div>
      </header>

      {view === 'home' && (
        <CatalogHome token={auth.token} onPlayEpisode={handlePlayEpisode} />
      )}

      {view === 'player' && session && (
        <VideoPlayer session={session} video={selVideo} />
      )}

      {view === 'admin' && <AdminDashboard token={auth.token} />}
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
