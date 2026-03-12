/**
 * Visualizes the BBA buffer zones:
 *   [0 ──── 10s] = Reservoir  (red)
 *   [10 ─── 45s] = Cushion    (orange)
 *   [45 ─── 60s] = Upper      (green)
 */
const MAX_BUF  = 60
const ZONE1    = 10   // reservoir top
const ZONE2    = 45   // cushion top

export default function BufferBar({ bufferSeconds, zone }) {
  const pct = Math.min(100, (bufferSeconds / MAX_BUF) * 100)

  const fillColor = {
    reservoir:       '#e50914',
    cushion:         '#f5a623',
    upper_reservoir: '#46d369',
  }[zone] || '#e50914'

  return (
    <div style={{ marginTop: 14, padding: 14, background: '#1a1a1a', borderRadius: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
        <span style={{ color: '#aaa' }}>Buffer Level</span>
        <span style={{ color: fillColor, fontWeight: 600 }}>{bufferSeconds.toFixed(1)}s</span>
      </div>

      {/* Zone background + fill */}
      <div style={{ height: 14, background: '#2a2a2a', borderRadius: 7, position: 'relative', overflow: 'hidden' }}>
        {/* Zone coloring */}
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0,
                      width: `${(ZONE1 / MAX_BUF) * 100}%`, background: 'rgba(229,9,20,0.12)' }} />
        <div style={{ position: 'absolute', left: `${(ZONE1 / MAX_BUF) * 100}%`, top: 0, bottom: 0,
                      width: `${((ZONE2 - ZONE1) / MAX_BUF) * 100}%`, background: 'rgba(245,166,35,0.10)' }} />
        <div style={{ position: 'absolute', left: `${(ZONE2 / MAX_BUF) * 100}%`, top: 0, bottom: 0, right: 0,
                      background: 'rgba(70,211,105,0.10)' }} />
        {/* Zone dividers */}
        <div style={{ position: 'absolute', left: `${(ZONE1 / MAX_BUF) * 100}%`, top: 0, bottom: 0,
                      width: 2, background: '#333', zIndex: 1 }} />
        <div style={{ position: 'absolute', left: `${(ZONE2 / MAX_BUF) * 100}%`, top: 0, bottom: 0,
                      width: 2, background: '#333', zIndex: 1 }} />
        {/* Actual fill */}
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0,
                      width: `${pct}%`, background: fillColor,
                      borderRadius: 7, transition: 'width 0.4s, background 0.3s', zIndex: 2 }} />
      </div>

      {/* Labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5, fontSize: 10, color: '#555' }}>
        <span>0s</span>
        <span>10s</span>
        <span>45s</span>
        <span>60s</span>
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 5, fontSize: 10 }}>
        <span style={{ color: '#e50914' }}>■ Reservoir (360p)</span>
        <span style={{ color: '#f5a623' }}>■ Cushion (linear)</span>
        <span style={{ color: '#46d369' }}>■ Upper (1080p)</span>
      </div>
    </div>
  )
}
