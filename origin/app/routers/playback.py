import os
import json
import uuid
from datetime import datetime
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import and_, or_, select, update
import redis.asyncio as aioredis

from ..auth import get_current_user
from ..database import get_db
from ..models import Video, CDNNode, Episode, Season, Session, User, VideoProgress, MediaTrack

router = APIRouter()
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")


class PlaybackProgressRequest(BaseModel):
    session_id: str | None = None
    video_id: int
    playhead_position: float


def _score_node(node: CDNNode, client_region: str) -> float:
    region_bonus = 0 if (node.location or "").lower() == (client_region or "").lower() else 100
    return region_bonus + float(node.load_percent or 0.0) + float(node.latency_ms or 0) / 10.0


def _to_client_url(raw_url: str) -> str:
    parsed = urlparse(raw_url or "")
    if not parsed.scheme:
        return raw_url

    host = parsed.hostname or ""
    # Browser cannot resolve docker-internal service names.
    if host in {"origin", "cdn-node-1", "cdn-node-2", "cdn-node-3"}:
        host = "localhost"

    netloc = host
    if parsed.port:
        netloc = f"{host}:{parsed.port}"
    return f"{parsed.scheme}://{netloc}"


async def _load_episode_tracks(db: AsyncSession, video_id: int) -> tuple[int | None, list[dict]]:
    episode_result = await db.execute(
        select(Episode.id)
        .where(Episode.video_id == video_id)
        .limit(1)
    )
    episode_id = episode_result.scalar_one_or_none()
    if episode_id is None:
        return None, []

    track_result = await db.execute(
        select(MediaTrack)
        .where(MediaTrack.episode_id == episode_id)
        .order_by(MediaTrack.track_type.asc(), MediaTrack.id.asc())
    )
    tracks = track_result.scalars().all()

    subtitle_index = 0
    payload = []
    for track in tracks:
        item = {
            "id": track.id,
            "track_type": track.track_type,
            "language": track.language,
            "label": track.label,
            "codec": track.codec,
            "is_default": bool(track.is_default),
        }
        if track.track_type == "subtitle":
            item["subtitle_index"] = subtitle_index
            item["source_url"] = f"/api/videos/{video_id}/subtitle_{subtitle_index}.vtt"
            subtitle_index += 1
        payload.append(item)

    return episode_id, payload


async def _resolve_next_video_id(db: AsyncSession, video_id: int) -> int | None:
    current_result = await db.execute(
        select(Episode, Season)
        .join(Season, Season.id == Episode.season_id)
        .where(Episode.video_id == video_id)
        .order_by(Season.season_number.asc(), Episode.episode_number.asc())
    )
    current_row = current_result.first()
    if not current_row:
        return None

    current_episode, current_season = current_row

    next_result = await db.execute(
        select(Episode.video_id)
        .join(Season, Season.id == Episode.season_id)
        .where(
            and_(
                Episode.series_id == current_episode.series_id,
                Episode.playable == True,
                Episode.video_id.is_not(None),
                or_(
                    Season.season_number > current_season.season_number,
                    and_(
                        Season.season_number == current_season.season_number,
                        Episode.episode_number > current_episode.episode_number,
                    ),
                ),
            )
        )
        .order_by(Season.season_number.asc(), Episode.episode_number.asc())
        .limit(1)
    )
    next_row = next_result.first()
    return next_row[0] if next_row else None


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
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
    user: User = Depends(get_current_user),
):
    episode_id, tracks = await _load_episode_tracks(db, videoId)

    cached = await redis.get(f"manifest:{videoId}")
    if cached:
        video_data = json.loads(cached)
        next_video_id = await _resolve_next_video_id(db, videoId)
        video_data["has_next_episode"] = next_video_id is not None
        video_data["next_episode_id"] = next_video_id
    else:
        result = await db.execute(select(Video).where(Video.id == videoId))
        video = result.scalar_one_or_none()
        if not video:
            raise HTTPException(status_code=404, detail="Video not found")
        next_video_id = await _resolve_next_video_id(db, video.id)
        video_data = {
            "id":                  video.id,
            "title":               video.title,
            "duration":            video.duration_seconds,
            "total_segments":      video.total_segments,
            "available_qualities": video.available_qualities or ["360p", "480p", "720p", "1080p"],
            "has_next_episode":    next_video_id is not None,
            "next_episode_id":     next_video_id,
        }
        await redis.setex(f"manifest:{videoId}", 300, json.dumps(video_data))

    video_data["episode_id"] = episode_id
    video_data["tracks"] = tracks

    cdn_result = await db.execute(select(CDNNode).where(CDNNode.status == "active"))
    nodes = cdn_result.scalars().all()

    if nodes:
        best_node = min(nodes, key=lambda n: _score_node(n, clientRegion))
        internal_cdn_url = best_node.url
        client_cdn_url = _to_client_url(internal_cdn_url)
        cdn_info = {
            "id": best_node.id,
            "name": best_node.name,
            "url": client_cdn_url,
            "internal_url": internal_cdn_url,
        }
    else:
        internal_cdn_url = "http://origin:8000"
        client_cdn_url = "http://localhost:8000"
        cdn_info = {
            "id": "origin",
            "name": "origin-server",
            "url": client_cdn_url,
            "internal_url": internal_cdn_url,
        }

    session_id = str(uuid.uuid4())[:8]
    resume_position_seconds = 0.0
    vp_result = await db.execute(
        select(VideoProgress).where(VideoProgress.user_id == user.id, VideoProgress.video_id == videoId)
    )
    vp = vp_result.scalar_one_or_none()
    if vp is not None and vp.playhead_seconds is not None:
        resume_position_seconds = float(max(0.0, vp.playhead_seconds))

    session = Session(
        id=session_id,
        user_id=user.username,
        video_id=videoId,
        cdn_node_id=cdn_info["id"] if cdn_info["id"] != "origin" else None,
        status="active",
        playhead_position=resume_position_seconds,
    )
    db.add(session)
    await db.commit()

    return {
        "session_id":    session_id,
        "manifest_url":  f"{client_cdn_url}/videos/{videoId}/manifest.mpd",
        "cdn_node":      cdn_info,
        "video_metadata": video_data,
        "resume_position_seconds": resume_position_seconds,
        "buffering_config": {
            "min_buffer_seconds":               10,
            "max_buffer_seconds":               60,
            "prefetch_next_episode_at_percent":  90,
            "audio_priority":                   True,
        },
    }


@router.post("/end")
async def end_playback(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.user_id != user.username:
        raise HTTPException(status_code=403, detail="Forbidden")

    await db.execute(
        update(Session)
        .where(Session.id == session_id)
        .values(status="ended", ended_at=datetime.utcnow())
    )
    await db.commit()
    return {"ok": True}


@router.post("/progress")
async def save_playback_progress(
    payload: PlaybackProgressRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    safe_position = float(max(0.0, payload.playhead_position or 0.0))

    video_result = await db.execute(select(Video).where(Video.id == payload.video_id))
    video = video_result.scalar_one_or_none()
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    if payload.session_id:
        session_result = await db.execute(select(Session).where(Session.id == payload.session_id))
        session = session_result.scalar_one_or_none()
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        if session.user_id != user.username:
            raise HTTPException(status_code=403, detail="Forbidden")

    existing_result = await db.execute(
        select(VideoProgress).where(VideoProgress.user_id == user.id, VideoProgress.video_id == payload.video_id)
    )
    existing = existing_result.scalar_one_or_none()

    if existing is None:
        existing = VideoProgress(
            user_id=user.id,
            video_id=payload.video_id,
            playhead_seconds=safe_position,
            updated_at=datetime.utcnow(),
        )
        db.add(existing)
    else:
        existing.playhead_seconds = safe_position
        existing.updated_at = datetime.utcnow()

    if payload.session_id:
        await db.execute(
            update(Session)
            .where(Session.id == payload.session_id)
            .values(playhead_position=safe_position)
        )

    await db.commit()
    return {
        "ok": True,
        "video_id": payload.video_id,
        "user_id": user.username,
        "playhead_position": safe_position,
    }


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
