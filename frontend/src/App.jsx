import { useState, useEffect } from 'react'
import VideoPlayer from './components/VideoPlayer.jsx'
import AdminDashboard from './components/AdminDashboard.jsx'
import Login from './components/Login.jsx'
import CatalogHome from './components/CatalogHome.jsx'

function resolveViewFromPath(pathname, isAdmin) {
  if (pathname.startsWith('/admin') && isAdmin) return 'admin'
  if (pathname.startsWith('/watch')) return 'player'
  return 'home'
}

function pathForView(nextView, selectedVideoId) {
  if (nextView === 'admin') return '/admin'
  if (nextView === 'player') return `/watch/${selectedVideoId || ''}`
  return '/home'
}

export default function App() {
  const [auth,     setAuth]     = useState(null)     // null | { token, user }
  const [view,     setView]     = useState('home')   // 'home' | 'player' | 'admin'
  const [session,  setSession]  = useState(null)
  const [selVideo, setSelVideo] = useState(null)

  const navigate = (nextView, { replace = false, videoId = null } = {}) => {
    setView(nextView)
    const nextPath = pathForView(nextView, videoId)
    if (replace) {
      window.history.replaceState({ view: nextView, videoId }, '', nextPath)
    } else {
      window.history.pushState({ view: nextView, videoId }, '', nextPath)
    }
  }

  // Restore session from localStorage on first load
  useEffect(() => {
    const stored = localStorage.getItem('auth')
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        const isAdmin = parsed.user.role === 'admin'
        const startView = resolveViewFromPath(window.location.pathname, isAdmin)
        setAuth(parsed)
        setView(startView)
        window.history.replaceState({ view: startView }, '', pathForView(startView))
      } catch {
        localStorage.removeItem('auth')
      }
    } else {
      window.history.replaceState({ view: 'home' }, '', '/home')
    }
  }, [])

  useEffect(() => {
    const onPopState = () => {
      if (!auth) return
      const next = resolveViewFromPath(window.location.pathname, auth.user.role === 'admin')
      if (next === 'player' && !session) {
        setView('home')
        return
      }
      setView(next)
    }

    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [auth, session])

  const handleLogin = (authData) => {
    localStorage.setItem('auth', JSON.stringify(authData))
    setAuth(authData)
    navigate(authData.user.role === 'admin' ? 'admin' : 'home', { replace: true })
  }

  const handleLogout = () => {
    localStorage.removeItem('auth')
    setAuth(null)
    setView('home')
    setSession(null)
    setSelVideo(null)
    window.history.replaceState({ view: 'home' }, '', '/home')
  }

  const handlePlayVideo = async (video) => {
    try {
      const r = await fetch(`/api/playback/start?videoId=${video.id}&clientRegion=dhaka&userId=${auth.user.username}`)
      const data = await r.json()
      setSession(data)
      setSelVideo(video)
      navigate('player', { videoId: video.id })
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

  const handlePlaySeries = async (seriesId) => {
    try {
      const r = await fetch(`/api/catalog/series/${seriesId}/episodes`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      const payload = await r.json()
      if (!r.ok) throw new Error(payload.detail || 'Could not load episodes')

      const episodes = Array.isArray(payload.episodes) ? payload.episodes : []
      if (episodes.length === 0) {
        throw new Error('No episodes found for this title')
      }

      await handlePlayEpisode(episodes[0].episode_id)
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
        padding: '14px 40px', background: 'linear-gradient(to bottom, rgba(0,0,0,0.86), rgba(0,0,0,0.48))',
        display: 'flex', alignItems: 'center', gap: 32,
        position: 'sticky', top: 0, zIndex: 100,
        backdropFilter: 'blur(6px)',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}>
        <h1 style={{ color: '#e50914', fontSize: 22, fontWeight: 700, letterSpacing: 2 }}>
          NETFLIX
        </h1>
        <nav style={{ display: 'flex', gap: 20 }}>
          <NavBtn label="Home"       active={view === 'home'}  onClick={() => navigate('home')}  />
          {isAdmin && (
            <NavBtn label="Dashboard" active={view === 'admin'} onClick={() => navigate('admin')} />
          )}
        </nav>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16 }}>
          {view === 'player' && (
            <button
              onClick={() => window.history.back()}
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
        <CatalogHome
          token={auth.token}
          onPlayEpisode={handlePlayEpisode}
          onPlayVideo={handlePlayVideo}
          onPlaySeries={handlePlaySeries}
        />
      )}

      {view === 'player' && session && (
        <VideoPlayer session={session} video={selVideo} />
      )}

      {view === 'player' && !session && (
        <div style={{ padding: 40, color: '#aaa' }}>
          Playback session expired.{' '}
          <button
            onClick={() => navigate('home', { replace: true })}
            style={{ background: 'none', color: '#fff', border: '1px solid #555', borderRadius: 4, padding: '6px 10px', cursor: 'pointer' }}
          >
            Go Home
          </button>
        </div>
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
