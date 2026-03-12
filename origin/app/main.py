from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from .database import engine, Base
from .routers import cdn, playback, buffering, prefetch, monitor, videos


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
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
app.include_router(monitor.ws_router)


@app.get("/health")
async def health():
    return {"status": "ok"}
