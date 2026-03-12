from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from ..database import get_db
from ..models import Video, CDNNode, Session

router = APIRouter()


@router.get("/next-episode")
async def prefetch_next_episode(
    currentVideoId: int,
    sessionId: str,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Video).where(Video.id == currentVideoId))
    video = result.scalar_one_or_none()
    if not video or not video.next_episode_id:
        return {"message": "no next episode", "next_video_id": None}

    next_id = video.next_episode_id

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

    return {
        "next_video_id":    next_id,
        "cdn_node_url":     cdn_url,
        "manifest_url":     f"{cdn_url}/videos/{next_id}/manifest.mpd",
        "prefetch_segments": [0, 1, 2, 3, 4],
        "quality":          "720p",
    }


@router.post("/status")
async def prefetch_status(data: dict):
    return {"received": True, "status": data.get("status", "unknown")}
