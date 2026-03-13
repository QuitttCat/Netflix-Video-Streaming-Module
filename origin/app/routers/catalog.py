import os
import asyncio
from typing import Optional
from datetime import datetime

import aiofiles
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, BackgroundTasks
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel

from ..auth import get_current_user, require_admin
from ..database import get_db
from ..models import Series, Season, Episode, MediaTrack, User, Video
from ..services.s3_media import S3MediaService
from ..services.video_packaging import (
    build_video_hierarchy_prefix,
    encode_and_upload_dash_to_s3,
    encode_video_to_dash,
)

router = APIRouter()
VIDEO_STORAGE_PATH = os.getenv("VIDEO_STORAGE_PATH", "/videos")

seed_catalog_status = {
    "running": False,
    "started_at": None,
    "finished_at": None,
    "success": None,
    "output": "",
    "error": "",
}


class SeedCatalogRequest(BaseModel):
    movie_limit: int = 100
    series_limit: int = 40
    max_seasons_per_series: int = 2
    max_episodes_per_season: int = 10
    reset_movies: bool = True
    reset_series: bool = True


@router.get("/home")
async def get_home_catalog(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    featured_result = await db.execute(select(Series).where(Series.featured == True).limit(1))
    featured = featured_result.scalar_one_or_none()

    trending_result = await db.execute(select(Series).order_by(Series.popularity.desc()).limit(20))
    trending = trending_result.scalars().all()

    series_result = await db.execute(select(Series).where(Series.content_type == "series").order_by(Series.popularity.desc()).limit(20))
    series_items = series_result.scalars().all()

    movie_result = await db.execute(select(Series).where(Series.content_type == "movie").order_by(Series.popularity.desc()).limit(20))
    movie_items = movie_result.scalars().all()

    continue_result = await db.execute(
        select(Episode, Series, Video)
        .join(Series, Series.id == Episode.series_id)
        .outerjoin(Video, Video.id == Episode.video_id)
        .where(Episode.playable == True)
        .limit(10)
    )
    continue_items = continue_result.all()

    return {
        "user": {"id": user.id, "username": user.username, "role": user.role},
        "hero": serialize_series(featured) if featured else None,
        "rows": [
            {
                "id": "continue",
                "title": "Continue Watching",
                "type": "episode",
                "items": [
                    {
                        "episode_id": e.id,
                        "title": e.title,
                        "subtitle": f"{s.title} • S1:E{e.episode_number}",
                        "thumbnail_url": f"/api/videos/{e.video_id}/thumbnail" if e.video_id else None,
                        "poster_url": s.poster_url,
                        "backdrop_url": s.backdrop_url,
                        "playable": e.playable,
                    }
                    for e, s, v in continue_items
                ],
            },
            {"id": "trending", "title": "Trending Now", "type": "series", "items": [serialize_series(x) for x in trending]},
            {"id": "series", "title": "Popular Series", "type": "series", "items": [serialize_series(x) for x in series_items]},
            {"id": "movies", "title": "Top Movies", "type": "series", "items": [serialize_series(x) for x in movie_items]},
        ],
    }


@router.get("/admin/series-overview")
async def admin_series_overview(db: AsyncSession = Depends(get_db), admin: User = Depends(require_admin)):
    series_result = await db.execute(select(Series).order_by(Series.popularity.desc(), Series.title.asc()))
    season_result = await db.execute(select(Season).order_by(Season.series_id.asc(), Season.season_number.asc()))
    episode_result = await db.execute(
        select(Episode).order_by(Episode.series_id.asc(), Episode.season_id.asc(), Episode.episode_number.asc())
    )

    seasons = season_result.scalars().all()
    episodes = episode_result.scalars().all()

    seasons_by_series = {}
    for s in seasons:
        seasons_by_series.setdefault(s.series_id, []).append(s)

    episodes_by_season = {}
    for e in episodes:
        episodes_by_season.setdefault(e.season_id, []).append(e)

    items = []
    for sr in series_result.scalars().all():
        series_seasons = seasons_by_series.get(sr.id, [])
        total_count = 0
        missing_count = 0
        season_items = []

        for ss in series_seasons:
            season_episodes = episodes_by_season.get(ss.id, [])
            ep_items = []
            for ep in season_episodes:
                total_count += 1
                is_missing = not (ep.playable and ep.video_id is not None)
                if is_missing:
                    missing_count += 1
                ep_items.append(
                    {
                        "episode_id": ep.id,
                        "episode_number": ep.episode_number,
                        "title": ep.title,
                        "playable": ep.playable,
                        "video_id": ep.video_id,
                        "thumbnail_url": f"/api/videos/{ep.video_id}/thumbnail" if ep.video_id else None,
                        "missing_video": is_missing,
                    }
                )
            season_items.append(
                {
                    "season_id": ss.id,
                    "season_number": ss.season_number,
                    "title": ss.title,
                    "episodes": ep_items,
                }
            )

        items.append(
            {
                "series_id": sr.id,
                "title": sr.title,
                "content_type": sr.content_type,
                "is_movie": sr.content_type == "movie",
                "poster_url": sr.poster_url,
                "popularity": sr.popularity,
                "total_episodes": total_count,
                "missing_episodes": missing_count,
                "seasons": season_items,
            }
        )

    return {"items": items}


@router.get("/series/{series_id}/episodes")
async def list_series_episodes(series_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    result = await db.execute(
        select(Episode, Season)
        .join(Season, Season.id == Episode.season_id)
        .where(Episode.series_id == series_id)
        .order_by(Season.season_number.asc(), Episode.episode_number.asc())
    )
    rows = result.all()

    tracks_result = await db.execute(select(MediaTrack))
    all_tracks = tracks_result.scalars().all()
    track_map = {}
    for t in all_tracks:
        track_map.setdefault(t.episode_id, []).append(
            {
                "id": t.id,
                "type": t.track_type,
                "language": t.language,
                "label": t.label,
                "default": t.is_default,
            }
        )

    return {
        "series_id": series_id,
        "episodes": [
            {
                "episode_id": e.id,
                "season_number": s.season_number,
                "episode_number": e.episode_number,
                "title": e.title,
                "synopsis": e.synopsis,
                "duration_sec": e.duration_sec,
                "playable": e.playable,
                "video_id": e.video_id,
                "tracks": track_map.get(e.id, []),
            }
            for e, s in rows
        ],
    }


@router.get("/episodes/{episode_id}/playback")
async def resolve_episode_playback(episode_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    result = await db.execute(select(Episode).where(Episode.id == episode_id))
    episode = result.scalar_one_or_none()
    if not episode:
        raise HTTPException(status_code=404, detail="Episode not found")

    if episode.playable and episode.video_id:
        return {
            "episode_id": episode.id,
            "video_id": episode.video_id,
            "available": True,
            "fallback": False,
            "message": "Playing selected episode",
        }

    demo_video_id = episode.demo_fallback_video_id or 1
    return {
        "episode_id": episode.id,
        "video_id": demo_video_id,
        "available": False,
        "fallback": True,
        "message": "This title is not uploaded yet. Playing demo episode instead.",
    }


@router.get("/admin/missing-videos")
async def admin_missing_videos(db: AsyncSession = Depends(get_db), admin: User = Depends(require_admin)):
    result = await db.execute(
        select(Episode, Series, Season)
        .join(Series, Series.id == Episode.series_id)
        .join(Season, Season.id == Episode.season_id)
        .where((Episode.video_id.is_(None)) | (Episode.playable == False))
        .order_by(Series.popularity.desc(), Season.season_number.asc(), Episode.episode_number.asc())
        .limit(50)
    )
    items = result.all()
    return {
        "items": [
            {
                "episode_id": e.id,
                "series_title": s.title,
                "season_number": se.season_number,
                "episode_number": e.episode_number,
                "episode_title": e.title,
                "playable": e.playable,
            }
            for e, s, se in items
        ]
    }


@router.post("/admin/upload-episode-video")
async def admin_upload_episode_video(
    episode_id: int = Form(...),
    title: str = Form(""),
    description: str = Form(""),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    return await _upload_episode_video_impl(
        episode_id=episode_id,
        title=title,
        description=description,
        file=file,
        db=db,
    )


@router.post("/admin/episodes/{episode_id}/upload")
async def admin_upload_episode_video_by_id(
    episode_id: int,
    title: str = Form(""),
    description: str = Form(""),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    return await _upload_episode_video_impl(
        episode_id=episode_id,
        title=title,
        description=description,
        file=file,
        db=db,
    )


async def _upload_episode_video_impl(
    episode_id: int,
    title: str,
    description: str,
    file: UploadFile,
    db: AsyncSession,
):
    episode_result = await db.execute(select(Episode).where(Episode.id == episode_id))
    episode = episode_result.scalar_one_or_none()
    if not episode:
        raise HTTPException(status_code=404, detail="Episode not found")

    video = None
    if episode.video_id:
        video_result = await db.execute(select(Video).where(Video.id == episode.video_id))
        video = video_result.scalar_one_or_none()

    if video is None:
        video = Video(
            title=title or f"Episode {episode.episode_number}",
            description=description,
            available_qualities=["360p", "480p", "720p", "1080p"],
            storage_path="",
        )
        db.add(video)
        await db.flush()

    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    storage_backend = (os.getenv("VIDEO_STORAGE_BACKEND", "s3") or "s3").lower()

    season_result = await db.execute(select(Season).where(Season.id == episode.season_id))
    season = season_result.scalar_one_or_none()
    series_result = await db.execute(select(Series).where(Series.id == episode.series_id))
    series = series_result.scalar_one_or_none()

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
            episode=episode,
            season_number=season.season_number if season else None,
            series_content_type=series.content_type if series else "series",
        )

        try:
            encode_result = await encode_and_upload_dash_to_s3(
                raw_bytes=file_bytes,
                raw_filename=file.filename or "raw.mp4",
                video_id=video.id,
                s3_prefix=s3_prefix,
                s3_service=s3,
            )
        except Exception as e:
            episode.video_id = video.id
            episode.playable = False
            await db.commit()
            raise HTTPException(status_code=400, detail=f"Upload saved but S3 chunking/encoding failed: {str(e)}")

        video.storage_path = f"s3://{s3.bucket_name}/{encode_result['s3_prefix']}"
        output_meta = {
            "storage_backend": "s3",
            "s3_prefix": encode_result["s3_prefix"],
            "manifest_key": encode_result["manifest_key"],
            "uploaded_files": len(encode_result["uploaded_files"]),
        }
    else:
        raw_path = os.path.join(VIDEO_STORAGE_PATH, str(video.id), "raw.mp4")
        os.makedirs(os.path.dirname(raw_path), exist_ok=True)
        async with aiofiles.open(raw_path, "wb") as f:
            await f.write(file_bytes)

        out_dir = os.path.join(VIDEO_STORAGE_PATH, str(video.id))
        try:
            encode_result = await encode_video_to_dash(raw_path, out_dir)
        except Exception as e:
            episode.video_id = video.id
            episode.playable = False
            await db.commit()
            raise HTTPException(status_code=400, detail=f"Upload saved but encoding failed: {str(e)}")

        video.storage_path = f"/videos/{video.id}"
        output_meta = {
            "storage_backend": "local",
            "raw_path": raw_path,
        }

    video.duration_seconds = encode_result["duration_seconds"]
    video.total_segments = encode_result["total_segments"]
    video.available_qualities = ["360p", "480p", "720p", "1080p"]

    episode.video_id = video.id
    episode.playable = True
    episode.duration_sec = max(episode.duration_sec, encode_result["duration_seconds"])

    await db.commit()

    return {
        "ok": True,
        "episode_id": episode.id,
        "video_id": video.id,
        "duration_seconds": video.duration_seconds,
        "total_segments": video.total_segments,
        "message": "Uploaded and encoded successfully.",
        **output_meta,
    }


def serialize_series(item: Optional[Series]):
    if not item:
        return None
    return {
        "series_id": item.id,
        "title": item.title,
        "synopsis": item.synopsis,
        "year": item.year,
        "maturity": item.maturity,
        "genres": item.genres or [],
        "poster_url": item.poster_url,
        "backdrop_url": item.backdrop_url,
        "logo_url": item.logo_url,
        "popularity": item.popularity,
        "content_type": item.content_type,
        "is_movie": item.content_type == "movie",
    }


@router.post("/admin/seed-catalog")
async def admin_seed_catalog(
    payload: SeedCatalogRequest,
    background_tasks: BackgroundTasks,
    admin: User = Depends(require_admin),
):
    if not os.getenv("TMDB_API_KEY"):
        raise HTTPException(status_code=400, detail="TMDB_API_KEY is not configured in origin service")

    if seed_catalog_status["running"]:
        raise HTTPException(status_code=409, detail="A seed job is already running")

    seed_catalog_status["running"] = True
    seed_catalog_status["started_at"] = datetime.utcnow().isoformat()
    seed_catalog_status["finished_at"] = None
    seed_catalog_status["success"] = None
    seed_catalog_status["output"] = ""
    seed_catalog_status["error"] = ""

    background_tasks.add_task(run_seed_catalog_job, payload)
    return {"ok": True, "message": "Seed job started"}


@router.get("/admin/seed-catalog-status")
async def admin_seed_catalog_status(admin: User = Depends(require_admin)):
    return seed_catalog_status


async def run_seed_catalog_job(payload: SeedCatalogRequest):
    cmd = [
        "python",
        "-m",
        "app.scripts.seed_tmdb_movies",
        "--limit",
        str(payload.movie_limit),
        "--series-limit",
        str(payload.series_limit),
        "--max-seasons-per-series",
        str(payload.max_seasons_per_series),
        "--max-episodes-per-season",
        str(payload.max_episodes_per_season),
    ]
    if payload.reset_movies:
        cmd.append("--reset-movies")
    if payload.reset_series:
        cmd.append("--reset-series")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=os.environ.copy(),
        )
        stdout, stderr = await proc.communicate()
        out_text = stdout.decode("utf-8", errors="ignore").strip()
        err_text = stderr.decode("utf-8", errors="ignore").strip()

        seed_catalog_status["output"] = out_text
        seed_catalog_status["error"] = err_text
        seed_catalog_status["success"] = proc.returncode == 0
    except Exception as e:
        seed_catalog_status["success"] = False
        seed_catalog_status["error"] = str(e)
    finally:
        seed_catalog_status["running"] = False
        seed_catalog_status["finished_at"] = datetime.utcnow().isoformat()
