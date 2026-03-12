import asyncio
import json
from datetime import datetime

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from ..database import get_db, AsyncSessionLocal
from ..models import Session, CDNNode, BufferEvent

router    = APIRouter()
ws_router = APIRouter()


@router.get("/sessions")
async def active_sessions(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Session).where(Session.status == "active"))
    sessions = result.scalars().all()
    return {
        "active_count": len(sessions),
        "sessions": [
            {
                "id":               s.id,
                "user_id":          s.user_id,
                "video_id":         s.video_id,
                "cdn_node_id":      s.cdn_node_id,
                "quality":          s.quality,
                "playhead_position": s.playhead_position,
                "created_at":       s.created_at.isoformat(),
            }
            for s in sessions
        ],
    }


@router.get("/cdn-health")
async def cdn_health(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(CDNNode))
    nodes = result.scalars().all()
    return {
        "nodes": [
            {
                "id":             n.id,
                "name":           n.name,
                "location":       n.location,
                "status":         n.status,
                "latency_ms":     n.latency_ms,
                "load_percent":   n.load_percent,
                "cache_hit_ratio": round(
                    n.cache_hit_count / max(1, n.cache_hit_count + n.cache_miss_count) * 100, 1
                ),
                "last_heartbeat": n.last_heartbeat.isoformat() if n.last_heartbeat else None,
            }
            for n in nodes
        ]
    }


@ws_router.websocket("/ws/monitor")
async def monitor_ws(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            async with AsyncSessionLocal() as db:
                sess_result = await db.execute(
                    select(Session).where(Session.status == "active")
                )
                sessions = sess_result.scalars().all()

                cdn_result = await db.execute(select(CDNNode))
                nodes = cdn_result.scalars().all()

                evt_result = await db.execute(
                    select(BufferEvent).order_by(BufferEvent.timestamp.desc()).limit(10)
                )
                events = evt_result.scalars().all()

            payload = {
                "timestamp":       datetime.utcnow().isoformat(),
                "active_sessions": len(sessions),
                "sessions": [
                    {
                        "id":          s.id,
                        "video_id":    s.video_id,
                        "quality":     s.quality,
                        "cdn_node_id": s.cdn_node_id,
                    }
                    for s in sessions
                ],
                "cdn_nodes": [
                    {
                        "id":             n.id,
                        "name":           n.name,
                        "status":         n.status,
                        "load_percent":   n.load_percent,
                        "latency_ms":     n.latency_ms,
                        "cache_hit_ratio": round(
                            n.cache_hit_count / max(1, n.cache_hit_count + n.cache_miss_count) * 100, 1
                        ),
                    }
                    for n in nodes
                ],
                "recent_events": [
                    {
                        "session_id":    e.session_id,
                        "buffer_seconds": e.buffer_seconds,
                        "quality":       e.quality,
                        "buffer_zone":   e.buffer_zone,
                        "timestamp":     e.timestamp.isoformat(),
                    }
                    for e in events
                ],
            }
            await websocket.send_json(payload)
            await asyncio.sleep(2)
    except WebSocketDisconnect:
        pass
