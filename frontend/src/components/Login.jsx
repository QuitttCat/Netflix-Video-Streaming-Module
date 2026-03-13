import { useState } from 'react'

const inputStyle = {
  background: '#333',
  border: '1px solid #444',
  borderRadius: 4,
  color: '#fff',
  padding: '14px 16px',
  fontSize: 16,
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
}

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.detail || 'Login failed')
      onLogin({ token: data.access_token, user: data.user })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(rgba(0,0,0,0.6), rgba(0,0,0,0.6)), #141414',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      fontFamily: 'Netflix Sans, Helvetica Neue, Helvetica, Arial, sans-serif',
    }}>
      {/* Top bar */}
      <div style={{ width: '100%', padding: '20px 48px', boxSizing: 'border-box' }}>
        <h1 style={{ color: '#e50914', fontSize: 32, fontWeight: 900, letterSpacing: 3, margin: 0 }}>
          NETFLIX
        </h1>
      </div>

      {/* Card */}
      <div style={{
        background: 'rgba(0,0,0,0.82)',
        borderRadius: 8,
        padding: '56px 68px 72px',
        width: 440,
        marginTop: '6vh',
        boxSizing: 'border-box',
      }}>
        <h2 style={{ color: '#fff', fontSize: 32, fontWeight: 700, margin: '0 0 28px' }}>
          Sign In
        </h2>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            required
            autoComplete="username"
            style={inputStyle}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            style={inputStyle}
          />

          {error && (
            <div style={{
              color: '#e87c03', fontSize: 13,
              background: 'rgba(232,124,3,0.1)',
              border: '1px solid rgba(232,124,3,0.35)',
              borderRadius: 4, padding: '10px 14px',
            }}>
              ⚠ {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              background: loading ? '#b0070f' : '#e50914',
              color: '#fff', border: 'none', borderRadius: 4,
              padding: '16px', fontSize: 16, fontWeight: 700,
              cursor: loading ? 'not-allowed' : 'pointer',
              marginTop: 8, transition: 'background 0.2s',
              letterSpacing: 0.5,
            }}
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        {/* Demo credentials hint */}
        <div style={{
          marginTop: 36,
          padding: '14px 16px',
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid #333',
          borderRadius: 6,
          fontSize: 13,
          color: '#999',
          lineHeight: 1.8,
        }}>
          <div style={{ color: '#ccc', fontWeight: 600, marginBottom: 6 }}>Demo accounts</div>
          <div>👤 User &nbsp;&nbsp;&nbsp;→ <span style={{ color: '#fff' }}>username:</span> user &nbsp; <span style={{ color: '#fff' }}>password:</span> user</div>
          <div>🔑 Admin → <span style={{ color: '#fff' }}>username:</span> admin &nbsp;<span style={{ color: '#fff' }}>password:</span> admin</div>
        </div>
      </div>
    </div>
  )
}
