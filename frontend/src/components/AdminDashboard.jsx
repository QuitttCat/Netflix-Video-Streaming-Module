import { useEffect, useRef, useState } from 'react'

export default function AdminDashboard() {
  const [data,      setData]      = useState(null)
  const [connected, setConnected] = useState(false)
  const wsRef = useRef(null)

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

  return (
    <div style={{ padding: '32px 40px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
        <h2 style={{ fontSize: 18 }}>Admin Dashboard</h2>
        <div style={{ width: 9, height: 9, borderRadius: '50%',
                      background: connected ? '#46d369' : '#e50914' }} />
        <span style={{ fontSize: 12, color: '#555' }}>{connected ? 'Live (WebSocket)' : 'Connecting…'}</span>
        {data && (
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#555' }}>
            {new Date(data.timestamp).toLocaleTimeString()}
          </span>
        )}
      </div>

      {!data ? (
        <div style={{ color: '#555', textAlign: 'center', marginTop: 80 }}>
          Waiting for data… Start streaming a video to see live metrics.
        </div>
      ) : (
        <>
          {/* Summary */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 24 }}>
            <StatCard label="Active Sessions" value={data.active_sessions}    color="#46d369" />
            <StatCard label="CDN Nodes"       value={data.cdn_nodes?.length ?? 0} color="#e50914" />
            <StatCard label="Buffer Events"   value={data.recent_events?.length ?? 0} color="#f5a623" />
          </div>

          {/* CDN nodes */}
          <Section title="CDN Node Health">
            {data.cdn_nodes?.length > 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                {data.cdn_nodes.map(n => (
                  <CDNCard key={n.id} node={n} />
                ))}
              </div>
            ) : (
              <Empty msg="No CDN nodes registered. Nodes register automatically on startup." />
            )}
          </Section>

          {/* Active sessions */}
          <Section title="Active Sessions">
            {data.sessions?.length > 0 ? (
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
            ) : (
              <Empty msg="No active sessions. Click Play on a video." />
            )}
          </Section>

          {/* Buffer events */}
          <Section title="Recent Buffer Events">
            {data.recent_events?.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
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
    </div>
  )
}

function StatCard({ label, value, color }) {
  return (
    <div style={{ background: '#1a1a1a', borderRadius: 8, padding: 20, textAlign: 'center' }}>
      <div style={{ fontSize: 36, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 12, color: '#555', marginTop: 6 }}>{label}</div>
    </div>
  )
}

function CDNCard({ node }) {
  const alive = node.status === 'active'
  return (
    <div style={{
      background: '#1a1a1a', borderRadius: 8, padding: 14,
      border: `1px solid ${alive ? '#46d36922' : '#e5091422'}`,
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
    <div style={{ background: '#1a1a1a', borderRadius: 4, padding: '7px 12px',
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
      <h3 style={{ fontSize: 12, color: '#555', letterSpacing: 1, marginBottom: 12 }}>
        {title.toUpperCase()}
      </h3>
      {children}
    </div>
  )
}

function Empty({ msg }) {
  return (
    <div style={{ background: '#1a1a1a', borderRadius: 6, padding: 20,
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
