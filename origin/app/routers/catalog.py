import os
import asyncio
import shutil
import uuid
from typing import Optional
from datetime import datetime

import aiofiles
from fastapi.concurrency import run_in_threadpool
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, BackgroundTasks
from fastapi.responses import FileResponse, RedirectResponse, Response
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel

from ..auth import get_current_user, require_admin
from ..database import get_db, AsyncSessionLocal
from ..models import Series, Season, Episode, MediaTrack, User, Video, WatchProgress
from ..services.s3_media import S3MediaService, join_key, parse_s3_uri
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

upload_job_status = {}


def _now_iso() -> str:
    return datetime.utcnow().isoformat()


def _set_upload_job(episode_id: int, **fields):
    current = upload_job_status.get(episode_id, {})
    current.update(fields)
    current["updated_at"] = _now_iso()
    upload_job_status[episode_id] = current
    return current


def _find_active_upload_job(*, exclude_episode_id: int | None = None):
    for active_episode_id, job in upload_job_status.items():
        if exclude_episode_id is not None and active_episode_id == exclude_episode_id:
            continue
        if (job or {}).get("status") in {"queued", "processing"}:
            return active_episode_id, job
    return None, None


class SeedCatalogRequest(BaseModel):
    movie_limit: int = 100
    series_limit: int = 40
    max_seasons_per_series: int = 2
    max_episodes_per_season: int = 10
    reset_movies: bool = True
    reset_series: bool = True


class SeriesCreateRequest(BaseModel):
    title: str
    synopsis: str = ""
    content_type: str = "series"
    year: int | None = None
    maturity: str = "TV-14"


class SeriesUpdateRequest(BaseModel):
    title: str | None = None
    synopsis: str | None = None
    year: int | None = None
    maturity: str | None = None
    poster_url: str | None = None
    backdrop_url: str | None = None
    featured: bool | None = None


class EpisodeCreateRequest(BaseModel):
    season_id: int
    title: str
    episode_number: int
    synopsis: str = ""
    duration_sec: int = 0


class EpisodeUpdateRequest(BaseModel):
    title: str | None = None
    synopsis: str | None = None
    duration_sec: int | None = None
    playable: bool | None = None
    video_id: int | None = None


def _series_thumbnail_api_url(series_id: int) -> str:
    return f"/api/catalog/series/{series_id}/thumbnail"


def _fallback_svg(label: str = "NETFLIX") -> str:
    return (
        "<svg xmlns='http://www.w3.org/2000/svg' width='1280' height='720'>"
        "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>"
        "<stop offset='0%' stop-color='#2b2b2b'/><stop offset='100%' stop-color='#101010'/></linearGradient></defs>"
        "<rect width='100%' height='100%' fill='url(#g)'/>"
        f"<text x='50%' y='52%' dominant-baseline='middle' text-anchor='middle' fill='#e5e5e5' font-family='Arial' font-size='56' font-weight='700'>{label}</text>"
        "</svg>"
    )


@router.get("/home")
async def get_home_catalog(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    featured_result = await db.execute(select(Series).where(Series.featured == True).limit(1))
    featured = featured_result.scalar_one_or_none()

    trending_result = await db.execute(select(Series).order_by(Series.popularity.desc()).limit(200))
    trending_raw = trending_result.scalars().all()

    uploaded_counts_result = await db.execute(
        select(Episode.series_id)
        .where(Episode.playable == True, Episode.video_id.is_not(None))
    )
    uploaded_counts = {}
    for (sid,) in uploaded_counts_result.all():
        uploaded_counts[sid] = uploaded_counts.get(sid, 0) + 1

    trending = sorted(
        trending_raw,
        key=lambda s: (
            1 if uploaded_counts.get(s.id, 0) > 0 else 0,
            uploaded_counts.get(s.id, 0),
            float(s.popularity or 0.0),
        ),
        reverse=True,
    )[:20]

    series_result = await db.execute(select(Series).where(Series.content_type == "series").order_by(Series.popularity.desc()).limit(20))
    series_items = series_result.scalars().all()

    movie_result = await db.execute(select(Series).where(Series.content_type == "movie").order_by(Series.popularity.desc()).limit(20))
    movie_items = movie_result.scalars().all()

    continue_result = await db.execute(
        select(Episode, Series, Season, Video)
        .join(Series, Series.id == Episode.series_id)
        .join(Season, Season.id == Episode.season_id)
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
                        "subtitle": f"{s.title} • S{se.season_number}:E{e.episode_number}",
                        "thumbnail_url": f"/api/videos/{e.video_id}/thumbnail" if e.video_id else _series_thumbnail_api_url(s.id),
                        "poster_url": s.poster_url,
                        "backdrop_url": s.backdrop_url,
                        "playable": e.playable,
                    }
                    for e, s, se, v in continue_items
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
                job = upload_job_status.get(ep.id)
                processing_active = bool(job and job.get("status") in {"queued", "processing"})
                is_missing = not (ep.playable and ep.video_id is not None)
                if is_missing:
                    missing_count += 1
                ep_items.append(
                    {
                        "episode_id": ep.id,
                        "episode_number": ep.episode_number,
                        "title": ep.title,
                        "synopsis": ep.synopsis or sr.synopsis or "",
                        "playable": ep.playable,
                        "video_id": ep.video_id,
                        "thumbnail_url": f"/api/videos/{ep.video_id}/thumbnail" if ep.video_id else _series_thumbnail_api_url(sr.id),
                        "missing_video": is_missing,
                        "processing_active": processing_active,
                        "processing_status": job.get("status") if job else None,
                        "processing_stage": job.get("stage") if job else None,
                        "processing_progress_percent": int(job.get("progress_percent") or 0) if job else 0,
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
                "thumbnail_url": _series_thumbnail_api_url(sr.id),
                "synopsis": sr.synopsis,
                "popularity": sr.popularity,
                "total_episodes": total_count,
                "missing_episodes": missing_count,
                "seasons": season_items,
            }
        )

    return {"items": items}


@router.get("/series/{series_id}/episodes")
async def list_series_episodes(series_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    series_result = await db.execute(select(Series).where(Series.id == series_id))
    series = series_result.scalar_one_or_none()
    if not series:
        raise HTTPException(status_code=404, detail="Series not found")

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
        "series": serialize_series(series),
        "episodes": [
            {
                "episode_id": e.id,
                "season_number": s.season_number,
                "episode_number": e.episode_number,
                "title": e.title,
                "synopsis": e.synopsis or series.synopsis or "",
                "duration_sec": e.duration_sec,
                "playable": e.playable,
                "video_id": e.video_id,
                "thumbnail_url": f"/api/videos/{e.video_id}/thumbnail" if e.video_id else _series_thumbnail_api_url(series_id),
                "tracks": track_map.get(e.id, []),
            }
            for e, s in rows
        ],
    }


@router.get("/series/{series_id}/thumbnail")
async def get_series_thumbnail(series_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Series).where(Series.id == series_id))
    series = result.scalar_one_or_none()
    if not series:
        raise HTTPException(status_code=404, detail="Series not found")

    thumb_ref = (series.logo_url or "").strip()
    if thumb_ref:
        if thumb_ref.startswith("s3://"):
            try:
                _, key = parse_s3_uri(thumb_ref)
                s3 = S3MediaService()
                body, content_type = await run_in_threadpool(s3.get_object_bytes, key)
                return Response(content=body, media_type=content_type or "image/jpeg")
            except Exception:
                pass
        elif thumb_ref.startswith("http://") or thumb_ref.startswith("https://"):
            return RedirectResponse(url=thumb_ref)
        else:
            local_thumb = thumb_ref if os.path.isabs(thumb_ref) else os.path.join(VIDEO_STORAGE_PATH, "series", str(series_id), thumb_ref)
            if os.path.exists(local_thumb):
                mt = "image/png" if local_thumb.lower().endswith(".png") else "image/jpeg"
                return FileResponse(local_thumb, media_type=mt)

    if series.poster_url:
        return RedirectResponse(url=series.poster_url)
    if series.backdrop_url:
        return RedirectResponse(url=series.backdrop_url)

    return Response(content=_fallback_svg("SERIES"), media_type="image/svg+xml")


@router.post("/admin/series/{series_id}/thumbnail")
async def admin_upload_series_thumbnail(
    series_id: int,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    result = await db.execute(select(Series).where(Series.id == series_id))
    series = result.scalar_one_or_none()
    if not series:
        raise HTTPException(status_code=404, detail="Series not found")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Thumbnail file is empty")

    ext = os.path.splitext(file.filename or "thumbnail.jpg")[1].lower() or ".jpg"
    if ext not in {".jpg", ".jpeg", ".png", ".webp"}:
        raise HTTPException(status_code=400, detail="Thumbnail must be jpg/jpeg/png/webp")
    media_type = file.content_type or ("image/png" if ext == ".png" else "image/jpeg")

    storage_backend = (os.getenv("VIDEO_STORAGE_BACKEND", "s3") or "s3").lower()
    if storage_backend == "s3":
        s3 = S3MediaService()
        key = join_key(f"netflix/series/series-{series_id}", f"thumbnail{ext}")
        await run_in_threadpool(s3.upload_bytes, key, data, media_type)
        series.logo_url = f"s3://{s3.bucket_name}/{key}"
    else:
        folder = os.path.join(VIDEO_STORAGE_PATH, "series", str(series_id))
        os.makedirs(folder, exist_ok=True)
        file_name = f"thumbnail{ext}"
        path = os.path.join(folder, file_name)
        async with aiofiles.open(path, "wb") as f:
            await f.write(data)
        series.logo_url = file_name

    await db.commit()
    await db.refresh(series)
    return {"ok": True, "series_id": series_id, "thumbnail_url": _series_thumbnail_api_url(series_id)}


@router.delete("/admin/series/{series_id}/thumbnail")
async def admin_delete_series_thumbnail(
    series_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    result = await db.execute(select(Series).where(Series.id == series_id))
    series = result.scalar_one_or_none()
    if not series:
        raise HTTPException(status_code=404, detail="Series not found")

    thumb_ref = (series.logo_url or "").strip()
    if thumb_ref.startswith("s3://"):
        try:
            _, key = parse_s3_uri(thumb_ref)
            s3 = S3MediaService()
            await run_in_threadpool(s3.delete_object, key)
        except Exception:
            pass
    elif thumb_ref and not thumb_ref.startswith("http://") and not thumb_ref.startswith("https://"):
        local_thumb = thumb_ref if os.path.isabs(thumb_ref) else os.path.join(VIDEO_STORAGE_PATH, "series", str(series_id), thumb_ref)
        if os.path.exists(local_thumb):
            try:
                os.remove(local_thumb)
            except OSError:
                pass

    series.logo_url = None
    await db.commit()
    return {"ok": True, "series_id": series_id, "thumbnail_url": _series_thumbnail_api_url(series_id)}


@router.get("/episodes/{episode_id}/playback")
async def resolve_episode_playback(episode_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    result = await db.execute(
        select(Episode, Series)
        .join(Series, Series.id == Episode.series_id)
        .where(Episode.id == episode_id)
    )
    row = result.first()
    if not row:
        raise HTTPException(status_code=404, detail="Episode not found")
    episode, series = row

    resolved_title = episode.title or f"Episode {episode.id}"
    resolved_description = (episode.synopsis or "").strip() or (series.synopsis or "").strip()

    if episode.playable and episode.video_id:
        return {
            "episode_id": episode.id,
            "video_id": episode.video_id,
            "title": resolved_title,
            "description": resolved_description,
            "available": True,
            "fallback": False,
            "message": "Playing selected episode",
        }

    demo_video_id = episode.demo_fallback_video_id or 1
    return {
        "episode_id": episode.id,
        "video_id": demo_video_id,
        "title": resolved_title,
        "description": resolved_description,
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


@router.post("/admin/series")
async def admin_create_series(
    payload: SeriesCreateRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    series = Series(
        title=payload.title,
        synopsis=payload.synopsis,
        content_type=payload.content_type,
        year=payload.year,
        maturity=payload.maturity,
        featured=False,
        genres=[],
    )
    db.add(series)
    await db.flush()

    season = Season(series_id=series.id, season_number=1, title="Season 1")
    db.add(season)
    await db.commit()
    await db.refresh(series)
    return {"ok": True, "series": serialize_series(series), "default_season_id": season.id}


@router.put("/admin/series/{series_id}")
async def admin_update_series(
    series_id: int,
    payload: SeriesUpdateRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    result = await db.execute(select(Series).where(Series.id == series_id))
    series = result.scalar_one_or_none()
    if not series:
        raise HTTPException(status_code=404, detail="Series not found")

    if payload.title is not None:
        series.title = payload.title
    if payload.synopsis is not None:
        series.synopsis = payload.synopsis
    if payload.year is not None:
        series.year = payload.year
    if payload.maturity is not None:
        series.maturity = payload.maturity
    if payload.poster_url is not None:
        series.poster_url = payload.poster_url
    if payload.backdrop_url is not None:
        series.backdrop_url = payload.backdrop_url
    if payload.featured is not None:
        series.featured = payload.featured

    await db.commit()
    await db.refresh(series)
    return {"ok": True, "series": serialize_series(series)}


@router.delete("/admin/series/{series_id}")
async def admin_delete_series(
    series_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    result = await db.execute(select(Series).where(Series.id == series_id))
    series = result.scalar_one_or_none()
    if not series:
        raise HTTPException(status_code=404, detail="Series not found")

    seasons_result = await db.execute(select(Season).where(Season.series_id == series_id))
    seasons = seasons_result.scalars().all()
    season_ids = [s.id for s in seasons]

    episodes_result = await db.execute(select(Episode).where(Episode.series_id == series_id))
    episodes = episodes_result.scalars().all()
    episode_ids = [e.id for e in episodes]

    if episode_ids:
        await db.execute(delete(WatchProgress).where(WatchProgress.episode_id.in_(episode_ids)))
        await db.execute(delete(MediaTrack).where(MediaTrack.episode_id.in_(episode_ids)))
        await db.execute(delete(Episode).where(Episode.id.in_(episode_ids)))

    if season_ids:
        await db.execute(delete(Season).where(Season.id.in_(season_ids)))

    await db.execute(delete(Series).where(Series.id == series_id))
    await db.commit()

    return {"ok": True, "series_id": series_id, "deleted_episodes": len(episode_ids)}


@router.post("/admin/series/{series_id}/episodes")
async def admin_create_episode(
    series_id: int,
    payload: EpisodeCreateRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    series_result = await db.execute(select(Series).where(Series.id == series_id))
    series = series_result.scalar_one_or_none()
    if not series:
        raise HTTPException(status_code=404, detail="Series not found")

    season_result = await db.execute(
        select(Season).where(Season.id == payload.season_id, Season.series_id == series_id)
    )
    season = season_result.scalar_one_or_none()
    if not season:
        raise HTTPException(status_code=404, detail="Season not found")

    episode = Episode(
        series_id=series_id,
        season_id=payload.season_id,
        episode_number=payload.episode_number,
        title=payload.title,
        synopsis=payload.synopsis,
        duration_sec=payload.duration_sec,
        playable=False,
    )
    db.add(episode)
    await db.commit()
    await db.refresh(episode)

    return {
        "ok": True,
        "episode": {
            "episode_id": episode.id,
            "season_id": episode.season_id,
            "episode_number": episode.episode_number,
            "title": episode.title,
        },
    }


@router.put("/admin/episodes/{episode_id}")
async def admin_update_episode(
    episode_id: int,
    payload: EpisodeUpdateRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    result = await db.execute(select(Episode).where(Episode.id == episode_id))
    episode = result.scalar_one_or_none()
    if not episode:
        raise HTTPException(status_code=404, detail="Episode not found")

    if payload.title is not None:
        episode.title = payload.title
    if payload.synopsis is not None:
        episode.synopsis = payload.synopsis
    if payload.duration_sec is not None:
        episode.duration_sec = payload.duration_sec
    if payload.playable is not None:
        episode.playable = payload.playable
    if payload.video_id is not None:
        episode.video_id = payload.video_id

    await db.commit()
    await db.refresh(episode)
    return {
        "ok": True,
        "episode": {
            "episode_id": episode.id,
            "title": episode.title,
            "playable": episode.playable,
            "video_id": episode.video_id,
        },
    }


@router.delete("/admin/episodes/{episode_id}")
async def admin_delete_episode(
    episode_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    result = await db.execute(select(Episode).where(Episode.id == episode_id))
    episode = result.scalar_one_or_none()
    if not episode:
        raise HTTPException(status_code=404, detail="Episode not found")

    await db.execute(delete(WatchProgress).where(WatchProgress.episode_id == episode_id))
    await db.execute(delete(MediaTrack).where(MediaTrack.episode_id == episode_id))
    await db.execute(delete(Episode).where(Episode.id == episode_id))
    await db.commit()

    return {"ok": True, "episode_id": episode_id}


@router.post("/admin/upload-episode-video")
async def admin_upload_episode_video(
    episode_id: int = Form(...),
    title: str = Form(""),
    description: str = Form(""),
    file: UploadFile = File(...),
    background_tasks: BackgroundTasks = None,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    return await _upload_episode_video_impl(
        episode_id=episode_id,
        title=title,
        description=description,
        file=file,
        background_tasks=background_tasks,
        db=db,
    )


@router.post("/admin/episodes/{episode_id}/upload")
async def admin_upload_episode_video_by_id(
    episode_id: int,
    title: str = Form(""),
    description: str = Form(""),
    file: UploadFile = File(...),
    background_tasks: BackgroundTasks = None,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    return await _upload_episode_video_impl(
        episode_id=episode_id,
        title=title,
        description=description,
        file=file,
        background_tasks=background_tasks,
        db=db,
    )


@router.get("/admin/episodes/{episode_id}/upload-status")
async def admin_get_episode_upload_status(
    episode_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    episode_result = await db.execute(select(Episode).where(Episode.id == episode_id))
    episode = episode_result.scalar_one_or_none()
    if not episode:
        raise HTTPException(status_code=404, detail="Episode not found")

    job = upload_job_status.get(episode_id)
    if job:
        return {
            "ok": True,
            "episode_id": episode_id,
            "status": job.get("status"),
            "stage": job.get("stage"),
            "progress_percent": int(job.get("progress_percent") or 0),
            "message": job.get("message"),
            "error": job.get("error"),
            "job_id": job.get("job_id"),
            "video_id": episode.video_id,
            "playable": bool(episode.playable and episode.video_id is not None),
            "updated_at": job.get("updated_at"),
            "started_at": job.get("started_at"),
            "finished_at": job.get("finished_at"),
            "queued_filename": job.get("filename"),
        }

    if episode.playable and episode.video_id is not None:
        return {
            "ok": True,
            "episode_id": episode_id,
            "status": "ready",
            "stage": "complete",
            "progress_percent": 100,
            "video_id": episode.video_id,
            "playable": True,
        }

    return {
        "ok": True,
        "episode_id": episode_id,
        "status": "missing",
        "stage": "idle",
        "progress_percent": 0,
        "video_id": episode.video_id,
        "playable": False,
    }


async def _upload_episode_video_impl(
    episode_id: int,
    title: str,
    description: str,
    file: UploadFile,
    background_tasks: BackgroundTasks,
    db: AsyncSession,
):
    if background_tasks is None:
        raise HTTPException(status_code=500, detail="Background task manager is unavailable")

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

    if title.strip():
        video.title = title.strip()
    if description.strip():
        video.description = description.strip()

    existing_job = upload_job_status.get(episode_id)
    if existing_job and existing_job.get("status") in {"queued", "processing"}:
        raise HTTPException(status_code=409, detail="An upload job is already running for this episode")

    active_episode_id, _ = _find_active_upload_job(exclude_episode_id=episode_id)
    if active_episode_id is not None:
        raise HTTPException(
            status_code=409,
            detail=f"Episode {active_episode_id} is still uploading or processing. Only one episode video upload can run at a time.",
        )

    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    job_id = str(uuid.uuid4())
    original_name = file.filename or "raw.mp4"
    upload_dir = os.path.join("/tmp", "episode-upload-jobs", str(episode_id), job_id)
    os.makedirs(upload_dir, exist_ok=True)
    input_path = os.path.join(upload_dir, original_name)

    async with aiofiles.open(input_path, "wb") as out:
        await out.write(file_bytes)

    episode.video_id = video.id
    episode.playable = False
    await db.commit()

    _set_upload_job(
        episode_id,
        job_id=job_id,
        video_id=video.id,
        status="queued",
        stage="queued",
        progress_percent=5,
        message="Upload received. Processing in background.",
        error=None,
        started_at=_now_iso(),
        finished_at=None,
        filename=original_name,
    )

    background_tasks.add_task(
        _process_episode_upload_job,
        episode_id,
        video.id,
        input_path,
        original_name,
        job_id,
    )

    return {
        "ok": True,
        "queued": True,
        "episode_id": episode.id,
        "video_id": video.id,
        "job_id": job_id,
        "status": "queued",
        "stage": "queued",
        "message": "Upload accepted. Background processing started.",
    }


async def _process_episode_upload_job(
    episode_id: int,
    video_id: int,
    input_path: str,
    original_name: str,
    job_id: str,
):
    _set_upload_job(
        episode_id,
        status="processing",
        stage="preparing",
        progress_percent=15,
        message="Preparing uploaded file for processing...",
        error=None,
    )

    try:
        async with AsyncSessionLocal() as db:
            episode_result = await db.execute(select(Episode).where(Episode.id == episode_id))
            episode = episode_result.scalar_one_or_none()
            if not episode:
                raise RuntimeError("Episode not found while processing queued upload")

            video_result = await db.execute(select(Video).where(Video.id == video_id))
            video = video_result.scalar_one_or_none()
            if not video:
                raise RuntimeError("Video metadata not found while processing queued upload")

            storage_backend = (os.getenv("VIDEO_STORAGE_BACKEND", "s3") or "s3").lower()

            season_result = await db.execute(select(Season).where(Season.id == episode.season_id))
            season = season_result.scalar_one_or_none()
            series_result = await db.execute(select(Series).where(Series.id == episode.series_id))
            series = series_result.scalar_one_or_none()

            if storage_backend == "s3":
                _set_upload_job(
                    episode_id,
                    status="processing",
                    stage="encoding",
                    progress_percent=35,
                    message="Encoding and uploading DASH assets to S3...",
                    error=None,
                )
                s3 = S3MediaService()
                missing = s3.validate_configuration()
                if missing:
                    raise RuntimeError(f"S3 storage is selected but missing env vars: {', '.join(missing)}")

                s3_prefix = build_video_hierarchy_prefix(
                    video_id=video.id,
                    episode=episode,
                    season_number=season.season_number if season else None,
                    series_content_type=series.content_type if series else "series",
                )

                async with aiofiles.open(input_path, "rb") as f:
                    raw_bytes = await f.read()

                encode_result = await encode_and_upload_dash_to_s3(
                    raw_bytes=raw_bytes,
                    raw_filename=original_name,
                    video_id=video.id,
                    s3_prefix=s3_prefix,
                    s3_service=s3,
                )

                video.storage_path = f"s3://{s3.bucket_name}/{encode_result['s3_prefix']}"
            else:
                _set_upload_job(
                    episode_id,
                    status="processing",
                    stage="encoding",
                    progress_percent=35,
                    message="Encoding local DASH assets...",
                    error=None,
                )
                out_dir = os.path.join(VIDEO_STORAGE_PATH, str(video.id))
                os.makedirs(out_dir, exist_ok=True)
                local_raw_path = os.path.join(out_dir, "raw.mp4")
                shutil.copyfile(input_path, local_raw_path)

                encode_result = await encode_video_to_dash(local_raw_path, out_dir)

                video.storage_path = f"/videos/{video.id}"

            _set_upload_job(
                episode_id,
                status="processing",
                stage="finalizing",
                progress_percent=90,
                message="Finalizing episode metadata...",
                error=None,
            )

            video.duration_seconds = encode_result["duration_seconds"]
            video.total_segments = encode_result["total_segments"]
            video.available_qualities = ["360p", "480p", "720p", "1080p"]

            await db.execute(delete(MediaTrack).where(MediaTrack.episode_id == episode.id))
            for track in encode_result.get("tracks", []):
                db.add(
                    MediaTrack(
                        episode_id=episode.id,
                        track_type=track.get("track_type", "audio"),
                        language=(track.get("language") or "und"),
                        label=track.get("label"),
                        codec=track.get("codec"),
                        is_default=bool(track.get("is_default")),
                    )
                )

            episode.video_id = video.id
            episode.playable = True
            episode.duration_sec = max(episode.duration_sec, encode_result["duration_seconds"])

            await db.commit()

            _set_upload_job(
                episode_id,
                job_id=job_id,
                status="done",
                stage="complete",
                progress_percent=100,
                message="Episode upload processed successfully.",
                error=None,
                finished_at=_now_iso(),
            )

    except Exception as e:
        try:
            async with AsyncSessionLocal() as db:
                episode_result = await db.execute(select(Episode).where(Episode.id == episode_id))
                episode = episode_result.scalar_one_or_none()
                if episode:
                    episode.playable = False
                    await db.commit()
        except Exception:
            pass

        _set_upload_job(
            episode_id,
            job_id=job_id,
            status="failed",
            stage="error",
            message="Episode upload failed during background processing.",
            error=str(e),
            progress_percent=int((upload_job_status.get(episode_id) or {}).get("progress_percent") or 0),
            finished_at=_now_iso(),
        )
    finally:
        try:
            if os.path.exists(input_path):
                os.remove(input_path)
            parent_dir = os.path.dirname(input_path)
            if parent_dir and os.path.isdir(parent_dir):
                os.rmdir(parent_dir)
        except Exception:
            pass


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
        "thumbnail_url": _series_thumbnail_api_url(item.id),
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
