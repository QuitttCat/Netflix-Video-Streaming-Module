import os
import asyncio
from pathlib import Path
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
        select(Episode, Series)
        .join(Series, Series.id == Episode.series_id)
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
                        "poster_url": s.poster_url,
                        "backdrop_url": s.backdrop_url,
                        "playable": e.playable,
                    }
                    for e, s in continue_items
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

    raw_path = os.path.join(VIDEO_STORAGE_PATH, str(video.id), "raw.mp4")
    os.makedirs(os.path.dirname(raw_path), exist_ok=True)
    async with aiofiles.open(raw_path, "wb") as f:
        await f.write(await file.read())

    try:
        encode_result = await encode_video_to_dash(video.id, raw_path)
    except Exception as e:
        episode.video_id = video.id
        episode.playable = False
        await db.commit()
        raise HTTPException(status_code=400, detail=f"Upload saved but encoding failed: {str(e)}")

    video.duration_seconds = encode_result["duration_seconds"]
    video.total_segments = encode_result["total_segments"]
    video.storage_path = f"/videos/{video.id}"
    video.available_qualities = ["360p", "480p", "720p", "1080p"]

    episode.video_id = video.id
    episode.playable = True
    episode.duration_sec = max(episode.duration_sec, encode_result["duration_seconds"])

    await db.commit()

    return {
        "ok": True,
        "episode_id": episode.id,
        "video_id": video.id,
        "raw_path": raw_path,
        "duration_seconds": video.duration_seconds,
        "total_segments": video.total_segments,
        "message": "Uploaded and encoded successfully.",
    }


async def encode_video_to_dash(video_id: int, raw_path: str) -> dict:
    out_dir = Path(VIDEO_STORAGE_PATH) / str(video_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "manifest.mpd"
    has_audio = await detect_audio_stream(raw_path)

    ffmpeg_cmd = [
        "ffmpeg", "-y", "-i", raw_path,
        "-filter_complex",
        "[0:v]split=4[v1][v2][v3][v4];"
        "[v1]scale=640:360[v360];"
        "[v2]scale=854:480[v480];"
        "[v3]scale=1280:720[v720];"
        "[v4]scale=1920:1080[v1080]",
        "-map", "[v360]", "-b:v:0", "400k", "-maxrate:v:0", "428k", "-bufsize:v:0", "600k",
        "-map", "[v480]", "-b:v:1", "800k", "-maxrate:v:1", "856k", "-bufsize:v:1", "1200k",
        "-map", "[v720]", "-b:v:2", "1500k", "-maxrate:v:2", "1605k", "-bufsize:v:2", "2250k",
        "-map", "[v1080]", "-b:v:3", "3000k", "-maxrate:v:3", "3210k", "-bufsize:v:3", "4500k",
        "-c:v", "libx264", "-preset", "fast", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
        "-use_timeline", "1", "-use_template", "1", "-seg_duration", "4",
    ]

    if has_audio:
        ffmpeg_cmd += [
            "-map", "0:a",
            "-c:a", "aac", "-b:a", "128k", "-ac", "2",
            "-adaptation_sets", "id=0,streams=v id=1,streams=a",
        ]
    else:
        ffmpeg_cmd += [
            "-an",
            "-adaptation_sets", "id=0,streams=v",
        ]

    ffmpeg_cmd += ["-f", "dash", str(manifest_path)]

    proc = await asyncio.create_subprocess_exec(
        *ffmpeg_cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(stderr.decode("utf-8", errors="ignore")[-600:])

    ffprobe_cmd = [
        "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", raw_path,
    ]
    probe = await asyncio.create_subprocess_exec(
        *ffprobe_cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await probe.communicate()
    duration_raw = (stdout.decode("utf-8", errors="ignore") or "0").strip()
    duration_seconds = int(float(duration_raw)) if duration_raw else 0

    total_segments = len(list(out_dir.glob("*.m4s")))
    return {
        "duration_seconds": max(1, duration_seconds),
        "total_segments": total_segments,
    }


async def detect_audio_stream(raw_path: str) -> bool:
    probe = await asyncio.create_subprocess_exec(
        "ffprobe",
        "-v", "error",
        "-select_streams", "a",
        "-show_entries", "stream=index",
        "-of", "csv=p=0",
        raw_path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await probe.communicate()
    text = stdout.decode("utf-8", errors="ignore").strip()
    return bool(text)


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
