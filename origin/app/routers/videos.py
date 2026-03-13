import os

import aiofiles
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from ..database import get_db
from ..models import Video
from ..services.s3_media import S3MediaService, join_key, parse_s3_uri
from ..services.video_packaging import build_video_hierarchy_prefix, encode_and_upload_dash_to_s3, encode_video_to_dash

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
async def get_manifest_file(video_id: int, db: AsyncSession = Depends(get_db)):
    path = os.path.join(VIDEO_STORAGE_PATH, str(video_id), "manifest.mpd")
    if os.path.exists(path):
        return FileResponse(path, media_type="application/dash+xml")

    result = await db.execute(select(Video).where(Video.id == video_id))
    video = result.scalar_one_or_none()
    if video and video.storage_path and str(video.storage_path).startswith("s3://"):
        try:
            _, prefix = parse_s3_uri(video.storage_path)
            s3 = S3MediaService()
            body, content_type = await run_in_threadpool(s3.get_object_bytes, join_key(prefix, "manifest.mpd"))
            return Response(content=body, media_type=content_type or "application/dash+xml")
        except Exception:
            pass

    raise HTTPException(status_code=404, detail="Manifest not found")


@router.get("/{video_id}/segments/{quality}/{segment_number}")
async def get_segment(
    video_id: int,
    quality: str,
    segment_number: int,
    db: AsyncSession = Depends(get_db),
):
    path = os.path.join(
        VIDEO_STORAGE_PATH, str(video_id), quality,
        f"segment_{segment_number:04d}.m4s",
    )
    if os.path.exists(path):
        return FileResponse(path, media_type="video/mp4")

    result = await db.execute(select(Video).where(Video.id == video_id))
    video = result.scalar_one_or_none()
    if not video or not video.storage_path or not str(video.storage_path).startswith("s3://"):
        raise HTTPException(status_code=404, detail="Segment not found")

    _, prefix = parse_s3_uri(video.storage_path)
    s3 = S3MediaService()

    keys = [
        join_key(prefix, f"{quality}/segment_{segment_number:04d}.m4s"),
        join_key(prefix, f"segment_{segment_number:04d}.m4s"),
    ]
    for key in keys:
        try:
            body, content_type = await run_in_threadpool(s3.get_object_bytes, key)
            return Response(content=body, media_type=content_type or "video/mp4")
        except Exception:
            continue

    raise HTTPException(status_code=404, detail="Segment not found")


@router.get("/{video_id}/{filename:path}")
async def get_dash_file(video_id: int, filename: str, db: AsyncSession = Depends(get_db)):
    """Serve any DASH file (init segments, chunk segments) by exact filename."""
    normalized = os.path.normpath(filename).replace("\\", "/").lstrip("/")
    if normalized.startswith("../") or normalized == "..":
        raise HTTPException(status_code=400, detail="Invalid filename")

    path = os.path.join(VIDEO_STORAGE_PATH, str(video_id), normalized)
    if not os.path.exists(path):
        result = await db.execute(select(Video).where(Video.id == video_id))
        video = result.scalar_one_or_none()
        if not video or not video.storage_path or not str(video.storage_path).startswith("s3://"):
            raise HTTPException(status_code=404, detail="File not found")

        try:
            _, prefix = parse_s3_uri(video.storage_path)
            s3 = S3MediaService()
            key = join_key(prefix, normalized)
            body, content_type = await run_in_threadpool(s3.get_object_bytes, key)
            return Response(content=body, media_type=content_type)
        except Exception:
            raise HTTPException(status_code=404, detail="File not found")

    if normalized.endswith(".m4s"):
        media_type = "video/mp4"
    elif normalized.endswith(".mpd"):
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
    storage_backend = (os.getenv("VIDEO_STORAGE_BACKEND", "s3") or "s3").lower()

    video = Video(
        title=title,
        description=description,
        available_qualities=["360p", "480p", "720p", "1080p"],
    )
    db.add(video)
    await db.flush()

    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    if storage_backend == "s3":
        s3 = S3MediaService()
        missing = s3.validate_configuration()
        if missing:
            raise HTTPException(
                status_code=500,
                detail=f"S3 storage is selected but missing env vars: {', '.join(missing)}",
            )

        s3_prefix = build_video_hierarchy_prefix(
            video_id=video.id,
            episode=None,
            season_number=None,
            series_content_type=None,
        )
        try:
            out = await encode_and_upload_dash_to_s3(
                raw_bytes=payload,
                raw_filename=file.filename or "raw.mp4",
                video_id=video.id,
                s3_prefix=s3_prefix,
                s3_service=s3,
            )
        except Exception as e:
            await db.rollback()
            raise HTTPException(status_code=400, detail=f"S3 chunking/encoding failed: {str(e)}")

        video.storage_path = f"s3://{s3.bucket_name}/{out['s3_prefix']}"
        video.duration_seconds = out["duration_seconds"]
        video.total_segments = out["total_segments"]
        await db.commit()
        await db.refresh(video)

        return {
            "video_id": video.id,
            "status": "uploaded_and_chunked",
            "storage_backend": "s3",
            "storage_path": video.storage_path,
            "manifest_key": out["manifest_key"],
            "total_segments": video.total_segments,
            "duration_seconds": video.duration_seconds,
        }

    raw_path = os.path.join(VIDEO_STORAGE_PATH, str(video.id), "raw.mp4")
    os.makedirs(os.path.dirname(raw_path), exist_ok=True)
    async with aiofiles.open(raw_path, "wb") as f:
        await f.write(payload)

    out_dir = os.path.join(VIDEO_STORAGE_PATH, str(video.id))
    try:
        out = await encode_video_to_dash(raw_path, out_dir)
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=400, detail=f"Encoding failed: {str(e)}")

    video.storage_path = f"/videos/{video.id}"
    video.duration_seconds = out["duration_seconds"]
    video.total_segments = out["total_segments"]
    await db.commit()
    await db.refresh(video)

    return {
        "video_id": video.id,
        "status": "uploaded_and_chunked",
        "storage_backend": "local",
        "storage_path": video.storage_path,
        "total_segments": video.total_segments,
        "duration_seconds": video.duration_seconds,
    }
