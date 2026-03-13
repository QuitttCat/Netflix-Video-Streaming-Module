import os
import json
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
import redis.asyncio as aioredis

from ..database import get_db
from ..models import Video, CDNNode, Session

router = APIRouter()
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")


async def get_redis():
    r = aioredis.from_url(REDIS_URL)
    try:
        yield r
    finally:
        await r.aclose()


@router.get("/start")
async def start_playback(
    videoId: int,
    clientRegion: str = "dhaka",
    userId: str = "anonymous",
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    cached = await redis.get(f"manifest:{videoId}")
    if cached:
        video_data = json.loads(cached)
    else:
        result = await db.execute(select(Video).where(Video.id == videoId))
        video = result.scalar_one_or_none()
        if not video:
            raise HTTPException(status_code=404, detail="Video not found")
        video_data = {
            "id":                  video.id,
            "title":               video.title,
            "duration":            video.duration_seconds,
            "total_segments":      video.total_segments,
            "available_qualities": video.available_qualities or ["320p", "480p", "720p"],
            "has_next_episode":    video.next_episode_id is not None,
            "next_episode_id":     video.next_episode_id,
        }
        await redis.setex(f"manifest:{videoId}", 300, json.dumps(video_data))

    cdn_result = await db.execute(select(CDNNode).where(CDNNode.status == "active"))
    nodes = cdn_result.scalars().all()

    if nodes:
        def score(n):
            region_bonus = 0 if n.location.lower() == clientRegion.lower() else 100
            return region_bonus + n.load_percent
        best_node = min(nodes, key=score)
        cdn_url  = best_node.url
        cdn_info = {"id": best_node.id, "name": best_node.name, "url": cdn_url}
    else:
        cdn_url  = "http://localhost:8000"
        cdn_info = {"id": "origin", "name": "origin-server", "url": cdn_url}

    session_id = str(uuid.uuid4())[:8]
    session = Session(
        id=session_id,
        user_id=userId,
        video_id=videoId,
        cdn_node_id=cdn_info["id"] if cdn_info["id"] != "origin" else None,
        status="active",
    )
    db.add(session)
    await db.commit()

    return {
        "session_id":    session_id,
        "manifest_url":  f"{cdn_url}/videos/{videoId}/manifest.mpd",
        "cdn_node":      cdn_info,
        "video_metadata": video_data,
        "buffering_config": {
            "min_buffer_seconds":               10,
            "max_buffer_seconds":               60,
            "prefetch_next_episode_at_percent":  90,
            "audio_priority":                   True,
        },
    }


@router.post("/end")
async def end_playback(session_id: str, db: AsyncSession = Depends(get_db)):
    await db.execute(
        update(Session)
        .where(Session.id == session_id)
        .values(status="ended", ended_at=datetime.utcnow())
    )
    await db.commit()
    return {"ok": True}


@router.get("/manifest/{video_id}")
async def get_manifest_meta(video_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Video).where(Video.id == video_id))
    video = result.scalar_one_or_none()
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")
    return {
        "video_id":       video_id,
        "title":          video.title,
        "duration":       video.duration_seconds,
        "total_segments": video.total_segments,
        "qualities":      video.available_qualities,
    }
