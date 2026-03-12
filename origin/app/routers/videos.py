import os

import aiofiles
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from ..database import get_db
from ..models import Video

router = APIRouter()
VIDEO_STORAGE_PATH = os.getenv("VIDEO_STORAGE_PATH", "/videos")


@router.get("/{video_id}")
async def get_video(video_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Video).where(Video.id == video_id))
    video = result.scalar_one_or_none()
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")
    return {
        "id":                  video.id,
        "title":               video.title,
        "description":         video.description,
        "duration_seconds":    video.duration_seconds,
        "total_segments":      video.total_segments,
        "available_qualities": video.available_qualities,
        "next_episode_id":     video.next_episode_id,
    }


@router.get("/{video_id}/manifest.mpd")
async def get_manifest_file(video_id: int):
    path = os.path.join(VIDEO_STORAGE_PATH, str(video_id), "manifest.mpd")
    if os.path.exists(path):
        return FileResponse(path, media_type="application/dash+xml")
    raise HTTPException(status_code=404, detail="Manifest not found")


@router.get("/{video_id}/segments/{quality}/{segment_number}")
async def get_segment(video_id: int, quality: str, segment_number: int):
    path = os.path.join(
        VIDEO_STORAGE_PATH, str(video_id), quality,
        f"segment_{segment_number:04d}.m4s",
    )
    if os.path.exists(path):
        return FileResponse(path, media_type="video/mp4")
    raise HTTPException(status_code=404, detail="Segment not found")


@router.get("/{video_id}/{filename:path}")
async def get_dash_file(video_id: int, filename: str):
    """Serve any DASH file (init segments, chunk segments) by exact filename."""
    safe_name = os.path.basename(filename)
    path = os.path.join(VIDEO_STORAGE_PATH, str(video_id), safe_name)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File not found")
    if safe_name.endswith(".m4s"):
        media_type = "video/mp4"
    elif safe_name.endswith(".mpd"):
        media_type = "application/dash+xml"
    else:
        media_type = "application/octet-stream"
    return FileResponse(path, media_type=media_type)


@router.post("/upload")
async def upload_video(
    title: str,
    description: str = "",
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    video = Video(
        title=title,
        description=description,
        available_qualities=["360p", "480p", "720p", "1080p"],
    )
    db.add(video)
    await db.commit()
    await db.refresh(video)

    raw_path = os.path.join(VIDEO_STORAGE_PATH, str(video.id), "raw.mp4")
    os.makedirs(os.path.dirname(raw_path), exist_ok=True)
    async with aiofiles.open(raw_path, "wb") as f:
        await f.write(await file.read())

    return {
        "video_id": video.id,
        "status":   "uploaded",
        "message":  "Run scripts/encode_video.sh <video_id> to process",
    }
