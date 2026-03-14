import asyncio
import re
import xml.etree.ElementTree as ET
from datetime import datetime

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import and_, or_, select

from ..database import get_db
from ..models import Video, CDNNode, Episode, Season, Session

router = APIRouter()
prefetch_status_store: dict[str, dict] = {}


def _prefetch_key(session_id: str, current_video_id: int) -> str:
    return f"{session_id}:{current_video_id}"


def _replace_number_token(template: str, number: int) -> str:
    # Supports both $Number$ and $Number%05d$ forms.
    return re.sub(
        r"\$Number(%0\d+d)?\$",
        lambda m: (f"{number:{m.group(1)[1:]}}" if m.group(1) else str(number)),
        template,
    )


def _parse_prefetch_paths_from_mpd(mpd_bytes: bytes, segment_count: int = 5) -> list[str]:
    root = ET.fromstring(mpd_bytes)
    paths: list[str] = []

    for adaptation in [n for n in root.iter() if n.tag.endswith("AdaptationSet")]:
        adaptation_template = next((c for c in adaptation if c.tag.endswith("SegmentTemplate")), None)

        reps = [c for c in adaptation if c.tag.endswith("Representation")]
        for rep in reps:
            rep_id = rep.attrib.get("id", "")
            template = next((c for c in rep if c.tag.endswith("SegmentTemplate")), adaptation_template)
            if template is None:
                continue

            init_t = template.attrib.get("initialization")
            media_t = template.attrib.get("media")
            start_num = int(template.attrib.get("startNumber", "1"))

            if init_t:
                init_path = init_t.replace("$RepresentationID$", rep_id)
                if init_path not in paths:
                    paths.append(init_path)

            if media_t:
                for idx in range(start_num, start_num + segment_count):
                    media_path = media_t.replace("$RepresentationID$", rep_id)
                    media_path = _replace_number_token(media_path, idx)
                    if media_path not in paths:
                        paths.append(media_path)

    return paths


async def _resolve_next_video_id(db: AsyncSession, current_video_id: int) -> int | None:
    current_episode, next_episode = await _load_episode_navigation(db, current_video_id)
    return next_episode["video_id"] if next_episode else None


def _serialize_episode(episode: Episode, season: Season) -> dict:
    return {
        "episode_id": episode.id,
        "video_id": episode.video_id,
        "episode_number": episode.episode_number,
        "season_number": season.season_number,
        "title": episode.title,
        "synopsis": episode.synopsis,
    }


async def _load_episode_navigation(db: AsyncSession, current_video_id: int) -> tuple[dict | None, dict | None]:
    current_result = await db.execute(
        select(Episode, Season)
        .join(Season, Season.id == Episode.season_id)
        .where(Episode.video_id == current_video_id)
        .order_by(Season.season_number.asc(), Episode.episode_number.asc())
    )
    current_row = current_result.first()
    if not current_row:
        return None, None

    current_episode, current_season = current_row

    next_result = await db.execute(
        select(Episode, Season)
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
    return (
        _serialize_episode(current_episode, current_season),
        _serialize_episode(next_row[0], next_row[1]) if next_row else None,
    )


async def _warm_next_episode(
    *,
    key: str,
    cdn_url: str,
    next_video_id: int,
    quality_hint: str,
) -> None:
    status = prefetch_status_store[key]
    timeout = httpx.Timeout(20.0, connect=8.0)

    async with httpx.AsyncClient(timeout=timeout) as client:
        manifest_url = f"{cdn_url}/videos/{next_video_id}/manifest.mpd"
        manifest_resp = await client.get(manifest_url)
        if manifest_resp.status_code != 200:
            raise RuntimeError("Could not fetch next-episode manifest from selected CDN node")

        paths = _parse_prefetch_paths_from_mpd(manifest_resp.content, segment_count=5)
        if not paths:
            # fallback to a deterministic minimal warmup if manifest parsing yields nothing
            paths = ["manifest.mpd"]

        status["total_steps"] = len(paths)

        warmed: list[str] = []
        for i, p in enumerate(paths, start=1):
            url = f"{cdn_url}/videos/{next_video_id}/{p.lstrip('/')}"
            r = await client.get(url)
            if r.status_code == 200:
                warmed.append(p)
            status["completed_steps"] = i
            status["progress_percent"] = int((i / max(1, len(paths))) * 100)
            status["last_item"] = p

    status["running"] = False
    status["done"] = True
    status["quality"] = quality_hint
    status["prefetch_segments"] = [0, 1, 2, 3, 4]
    status["warmed_paths_count"] = len(warmed)
    status["warmed_paths_preview"] = warmed[:10]
    status["finished_at"] = datetime.utcnow().isoformat()
    status["message"] = f"Prefetch complete: {len(warmed)} files warmed on CDN"


@router.get("/next-episode")
async def prefetch_next_episode(
    currentVideoId: int,
    sessionId: str,
    playheadSeconds: float = 0.0,
    durationSeconds: float = 0.0,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Video).where(Video.id == currentVideoId))
    video = result.scalar_one_or_none()
    if not video:
        return {"message": "no next episode", "next_video_id": None, "next_episode": None}

    current_episode, next_episode = await _load_episode_navigation(db, currentVideoId)
    next_id = next_episode["video_id"] if next_episode else None
    if not next_id:
        return {"message": "no next episode", "next_video_id": None, "next_episode": None}

    near_end = durationSeconds > 0 and playheadSeconds >= durationSeconds * 0.90
    if not near_end:
        return {
            "message": "not near end yet",
            "next_video_id": next_id,
            "next_episode": next_episode,
            "should_start_prefetch": False,
            "progress_percent": 0,
        }

    sess_result = await db.execute(select(Session).where(Session.id == sessionId))
    session = sess_result.scalar_one_or_none()

    cdn_url = "http://origin:8000"
    if session and session.cdn_node_id:
        node_result = await db.execute(
            select(CDNNode).where(CDNNode.id == session.cdn_node_id)
        )
        node = node_result.scalar_one_or_none()
        if node:
            cdn_url = node.url

    key = _prefetch_key(sessionId, currentVideoId)
    existing = prefetch_status_store.get(key)
    if existing and existing.get("running"):
        return existing

    state = {
        "session_id": sessionId,
        "current_video_id": currentVideoId,
        "next_video_id": next_id,
        "current_episode": current_episode,
        "next_episode": next_episode,
        "cdn_node_url": cdn_url,
        "manifest_url": f"{cdn_url}/videos/{next_id}/manifest.mpd",
        "prefetch_segments": [0, 1, 2, 3, 4],
        "quality": "1080p",
        "should_start_prefetch": True,
        "running": True,
        "done": False,
        "total_steps": 1,
        "completed_steps": 0,
        "progress_percent": 0,
        "started_at": datetime.utcnow().isoformat(),
        "finished_at": None,
        "message": "Starting server-side CDN preloading",
    }
    prefetch_status_store[key] = state

    async def runner():
        try:
            await _warm_next_episode(
                key=key,
                cdn_url=cdn_url,
                next_video_id=next_id,
                quality_hint="1080p",
            )
        except Exception as exc:
            state["running"] = False
            state["done"] = True
            state["finished_at"] = datetime.utcnow().isoformat()
            state["message"] = f"Prefetch failed: {str(exc)}"

    asyncio.create_task(runner())

    return state


@router.get("/status")
async def prefetch_status(sessionId: str, currentVideoId: int):
    key = _prefetch_key(sessionId, currentVideoId)
    return prefetch_status_store.get(
        key,
        {
            "session_id": sessionId,
            "current_video_id": currentVideoId,
            "next_episode": None,
            "running": False,
            "done": False,
            "progress_percent": 0,
            "message": "No prefetch job found",
        },
    )


@router.post("/status")
async def prefetch_status_ingest(data: dict):
    return {"received": True, "status": data.get("status", "unknown")}
