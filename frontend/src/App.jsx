import { useState, useEffect } from 'react'
import VideoPlayer from './components/VideoPlayer.jsx'
import AdminDashboard from './components/AdminDashboard.jsx'
import Login from './components/Login.jsx'
import CatalogHome from './components/CatalogHome.jsx'

function resolveViewFromPath(pathname, isAdmin) {
  if (pathname.startsWith('/admin/content') && isAdmin) return 'content'
  if (pathname.startsWith('/admin') && isAdmin) return 'admin'
  if (pathname.startsWith('/watch')) return 'player'
  return 'home'
}

function pathForView(nextView, selectedVideoId) {
  if (nextView === 'content') return '/admin/content'
  if (nextView === 'admin') return '/admin'
  if (nextView === 'player') return `/watch/${selectedVideoId || ''}`
  return '/home'
}

export default function App() {
  const [auth,     setAuth]     = useState(null)     // null | { token, user }
  const [view,     setView]     = useState('home')   // 'home' | 'player' | 'admin' | 'content'
  const [session,  setSession]  = useState(null)
  const [selVideo, setSelVideo] = useState(null)
  const [bootstrapping, setBootstrapping] = useState(true)

  const navigate = (nextView, { replace = false, videoId = null } = {}) => {
    setView(nextView)
    const nextPath = pathForView(nextView, videoId)
    if (replace) {
      window.history.replaceState({ view: nextView, videoId }, '', nextPath)
    } else {
      window.history.pushState({ view: nextView, videoId }, '', nextPath)
    }
  }

  // Restore session from localStorage on first load and verify token
  useEffect(() => {
    let alive = true

    const bootstrapAuth = async () => {
      const stored = localStorage.getItem('auth')
      if (!stored) {
        if (!alive) return
        window.history.replaceState({ view: 'login' }, '', '/login')
        setBootstrapping(false)
        return
      }

      try {
        const parsed = JSON.parse(stored)
        const verify = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${parsed.token}` },
        })

        if (!verify.ok) {
          throw new Error('Session expired')
        }

        const me = await verify.json()
        if (!alive) return

        const nextAuth = { token: parsed.token, user: me }
        const isAdmin = me.role === 'admin'
        const startView = resolveViewFromPath(window.location.pathname, isAdmin)
        localStorage.setItem('auth', JSON.stringify(nextAuth))
        setAuth(nextAuth)
        setView(startView)
        window.history.replaceState({ view: startView }, '', pathForView(startView))
      } catch {
        if (!alive) return
        localStorage.removeItem('auth')
        setAuth(null)
        setView('home')
        window.history.replaceState({ view: 'login' }, '', '/login')
      } finally {
        if (alive) setBootstrapping(false)
      }
    }

    bootstrapAuth()

    return () => {
      alive = false
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
    window.history.replaceState({ view: 'login' }, '', '/login')
  }

  const handlePlayVideo = async (video) => {
    try {
      const r = await fetch(`/api/playback/start?videoId=${video.id}&clientRegion=dhaka`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.detail || 'Could not start playback')
      const currentEpisode = data.video_metadata?.current_episode
      setSession(data)
      setSelVideo({
        ...video,
        title: currentEpisode?.title || data.video_metadata?.title || video.title,
        description: currentEpisode?.synopsis || data.video_metadata?.description || video.description,
        subtitle: currentEpisode?.episode_number
          ? `Season ${currentEpisode.season_number} • Episode ${currentEpisode.episode_number}`
          : video.subtitle,
        episode_id: currentEpisode?.episode_id || data.video_metadata?.episode_id || video.episode_id,
        tracks: data.video_metadata?.tracks || video.tracks || [],
      })
      navigate('player', { videoId: video.id })
    } catch (e) {
      alert('Could not start playback: ' + e.message)
    }
  }

  const handlePlayNextEpisode = async (nextEpisode) => {
    const nextVideoId = typeof nextEpisode === 'object' ? nextEpisode?.video_id : nextEpisode
    if (!nextVideoId) return
    await handlePlayVideo({
      id: nextVideoId,
      title: nextEpisode?.title || `Episode ${nextVideoId}`,
      description: nextEpisode?.synopsis || 'Next episode',
      subtitle: nextEpisode?.episode_number
        ? `Season ${nextEpisode.season_number} • Episode ${nextEpisode.episode_number}`
        : 'Auto queue',
      episode_id: nextEpisode?.episode_id,
    })
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
        title: resolved.title || `Episode ${episodeId}`,
        description: resolved.description || '',
        subtitle: resolved.fallback ? 'Demo Fallback' : 'Playable Episode',
        episode_id: episodeId,
        tracks: resolved.tracks || [],
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

  if (bootstrapping) {
    return <div style={{ padding: 40, color: '#aaa' }}>Checking session…</div>
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
        <nav style={{ display: 'flex', gap: 10 }}>
          <NavBtn label="Home"       active={view === 'home'}  onClick={() => navigate('home')}  />
          {isAdmin && (
            <>
              <NavBtn label="Dashboard" active={view === 'admin'} onClick={() => navigate('admin')} />
              <NavBtn label="Content" active={view === 'content'} onClick={() => navigate('content')} />
            </>
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
        <VideoPlayer
          session={session}
          video={selVideo}
          user={auth.user}
          token={auth.token}
          onPlayNextEpisode={handlePlayNextEpisode}
        />
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

      {view === 'admin' && <AdminDashboard token={auth.token} mode="ops" onOpenContentManager={() => navigate('content')} />}
      {view === 'content' && <AdminDashboard token={auth.token} mode="content" />}
    </div>
  )
}

function NavBtn({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      background: active ? 'rgba(229,9,20,0.16)' : 'rgba(255,255,255,0.04)',
      border: active ? '1px solid rgba(229,9,20,0.5)' : '1px solid rgba(255,255,255,0.14)',
      borderRadius: 999,
      color: active ? '#fff' : '#c2c2c2',
      fontWeight: active ? 700 : 400,
      fontSize: 13, cursor: 'pointer', padding: '6px 14px',
      letterSpacing: 0.2,
    }}>
      {label}
    </button>
  )
}
