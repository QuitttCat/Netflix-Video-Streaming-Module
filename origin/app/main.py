from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from .database import engine, Base, AsyncSessionLocal
from .models import User, Series, Season, Episode, MediaTrack, Video
from .auth import hash_password
from .routers import cdn, playback, buffering, prefetch, monitor, videos, catalog, media_storage
from .routers import auth as auth_router
from sqlalchemy import select


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # Seed minimal default data (users + one demo playable episode)
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).where(User.username == "admin"))
        if result.scalar_one_or_none() is None:
            db.add_all([
                User(
                    username="admin",
                    email="admin@netflix.com",
                    password_hash=hash_password("admin"),
                    role="admin",
                ),
                User(
                    username="user",
                    email="user@netflix.com",
                    password_hash=hash_password("user"),
                    role="user",
                ),
            ])
        demo_video = await db.scalar(select(Video).where(Video.id == 1))
        if demo_video is None:
            db.add(
                Video(
                    id=1,
                    title="Demo Episode 1",
                    description="Autocreated demo video entry",
                    duration_seconds=900,
                    total_segments=150,
                    available_qualities=["360p", "480p", "720p", "1080p"],
                    storage_path="/videos/1",
                )
            )

        series_count = await db.scalar(select(Series.id).limit(1))
        if series_count is None:
            demo_series = Series(
                title="Demo Series",
                synopsis="Starter row. Run TMDB seed script to fill catalog.",
                content_type="series",
                year=2026,
                maturity="PG-13",
                genres=["Demo"],
                poster_url=None,
                backdrop_url=None,
                popularity=1.0,
                featured=True,
            )
            db.add(demo_series)
            await db.flush()

            demo_season = Season(series_id=demo_series.id, season_number=1, title="Season 1")
            db.add(demo_season)
            await db.flush()

            demo_episode = Episode(
                series_id=demo_series.id,
                season_id=demo_season.id,
                episode_number=1,
                title="Demo Episode",
                synopsis="This is playable when /videos/1/manifest.mpd exists.",
                duration_sec=900,
                video_id=1,
                playable=True,
                demo_fallback_video_id=1,
            )
            db.add(demo_episode)
            await db.flush()

            db.add_all([
                MediaTrack(episode_id=demo_episode.id, track_type="audio", language="en", label="English", codec="aac", is_default=True),
                MediaTrack(episode_id=demo_episode.id, track_type="subtitle", language="en", label="English CC", codec="webvtt", is_default=True),
            ])

        await db.commit()
    yield


app = FastAPI(title="Netflix Streaming Origin Server", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(cdn.router,       prefix="/api/cdn",       tags=["CDN"])
app.include_router(playback.router,  prefix="/api/playback",  tags=["Playback"])
app.include_router(buffering.router, prefix="/api/buffering", tags=["Buffering"])
app.include_router(prefetch.router,  prefix="/api/prefetch",  tags=["Prefetch"])
app.include_router(monitor.router,   prefix="/api/monitor",   tags=["Monitor"])
app.include_router(videos.router,    prefix="/api/videos",    tags=["Videos"])
app.include_router(catalog.router,   prefix="/api/catalog",   tags=["Catalog"])
app.include_router(media_storage.router, prefix="/api/media", tags=["Media Storage"])
app.include_router(monitor.ws_router)
app.include_router(auth_router.router, prefix="/api/auth", tags=["Auth"])


@app.get("/health")
async def health():
    return {"status": "ok"}
