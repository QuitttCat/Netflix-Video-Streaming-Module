"""
CDN Edge Node - FastAPI server
Serves video segments with local cache.
On cache miss, fetches from origin and caches locally.
Registers with origin on startup and sends periodic heartbeats.
Config via environment variables: NODE_ID, NODE_NAME, NODE_LOCATION, NODE_PORT, ORIGIN_URL, CACHE_PATH.
"""
import asyncio
import os
import random

import aiofiles
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from contextlib import asynccontextmanager

NODE_ID       = os.getenv("NODE_ID",       "cdn-node-3")
NODE_NAME     = os.getenv("NODE_NAME",     "edge-sylhet")
NODE_LOCATION = os.getenv("NODE_LOCATION", "sylhet")
NODE_PORT     = int(os.getenv("NODE_PORT", "3003"))
ORIGIN_URL    = os.getenv("ORIGIN_URL",    "http://origin:8000")
CACHE_PATH    = os.getenv("CACHE_PATH",    "/cache")

# In-memory counters (also sent to origin via heartbeat)
_cache_hits   = 0
_cache_misses = 0
_active_reqs  = 0


async def _register():
    """Register this CDN node with the origin server on startup."""
    await asyncio.sleep(5)
    node_url = os.getenv("NODE_PUBLIC_URL") or f"http://{NODE_ID}:{NODE_PORT}"
    async with httpx.AsyncClient() as client:
        for attempt in range(15):
            try:
                r = await client.post(
                    f"{ORIGIN_URL}/api/cdn/register",
                    json={
                        "node_id":  NODE_ID,
                        "name":     NODE_NAME,
                        "location": NODE_LOCATION,
                        "url":      node_url,
                    },
                    timeout=5.0,
                )
                if r.status_code == 200:
                    print(f"[{NODE_NAME}] Registered with origin.")
                    return
            except Exception as exc:
                print(f"[{NODE_NAME}] Register attempt {attempt + 1}: {exc}")
            await asyncio.sleep(3)


async def _heartbeat_loop():
    """Send periodic health metrics to origin every 5 seconds."""
    global _cache_hits, _cache_misses, _active_reqs
    async with httpx.AsyncClient() as client:
        while True:
            try:
                await client.put(
                    f"{ORIGIN_URL}/api/cdn/heartbeat/{NODE_ID}",
                    json={
                        "latency_ms":       random.randint(5, 40),
                        "load_percent":     min(100.0, _active_reqs * 8.0),
                        "cache_hit_count":  _cache_hits,
                        "cache_miss_count": _cache_misses,
                    },
                    timeout=3.0,
                )
            except Exception:
                pass
            await asyncio.sleep(5)


@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.create_task(_register())
    asyncio.create_task(_heartbeat_loop())
    yield


app = FastAPI(title=f"CDN Node — {NODE_NAME}", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── helpers ──────────────────────────────────────────────────────────────────

def _manifest_cache(video_id: int) -> str:
    return os.path.join(CACHE_PATH, str(video_id), "manifest.mpd")


def _segment_cache(video_id: int, quality: str, segment: int) -> str:
    return os.path.join(CACHE_PATH, str(video_id), quality, f"segment_{segment:04d}.m4s")


def _trailer_cache(series_id: int, filename: str) -> str:
    return os.path.join(CACHE_PATH, "trailers", str(series_id), filename)


def _media_type_for_path(path: str) -> str:
    lower = path.lower()
    if lower.endswith(".m4s"):
        return "video/mp4"
    if lower.endswith(".mpd"):
        return "application/dash+xml"
    if lower.endswith(".vtt"):
        return "text/vtt"
    return "application/octet-stream"


# ── endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "node_id":      NODE_ID,
        "name":         NODE_NAME,
        "location":     NODE_LOCATION,
        "cache_hits":   _cache_hits,
        "cache_misses": _cache_misses,
    }


@app.get("/videos/{video_id}/manifest.mpd")
async def serve_manifest(video_id: int):
    global _cache_hits, _cache_misses, _active_reqs
    _active_reqs += 1
    try:
        cache_path = _manifest_cache(video_id)
        if os.path.exists(cache_path):
            _cache_hits += 1
            return FileResponse(cache_path, media_type="application/dash+xml")

        # Cache miss → fetch from origin
        _cache_misses += 1
        async with httpx.AsyncClient() as client:
            r = await client.get(
                f"{ORIGIN_URL}/api/videos/{video_id}/manifest.mpd", timeout=10.0
            )
            if r.status_code == 200:
                os.makedirs(os.path.dirname(cache_path), exist_ok=True)
                async with aiofiles.open(cache_path, "wb") as f:
                    await f.write(r.content)
                return Response(content=r.content, media_type="application/dash+xml")

        raise HTTPException(status_code=404, detail="Manifest not found")
    finally:
        _active_reqs -= 1


@app.get("/videos/{video_id}/segments/{quality}/{segment_number}")
async def serve_segment(video_id: int, quality: str, segment_number: int):
    global _cache_hits, _cache_misses, _active_reqs
    _active_reqs += 1
    try:
        cache_path = _segment_cache(video_id, quality, segment_number)
        if os.path.exists(cache_path):
            _cache_hits += 1
            return FileResponse(cache_path, media_type="video/mp4")

        # Cache miss → fetch from origin
        _cache_misses += 1
        async with httpx.AsyncClient() as client:
            r = await client.get(
                f"{ORIGIN_URL}/api/videos/{video_id}/segments/{quality}/{segment_number}",
                timeout=30.0,
            )
            if r.status_code == 200:
                os.makedirs(os.path.dirname(cache_path), exist_ok=True)
                async with aiofiles.open(cache_path, "wb") as f:
                    await f.write(r.content)
                return Response(content=r.content, media_type="video/mp4")

        raise HTTPException(status_code=404, detail="Segment not found")
    finally:
        _active_reqs -= 1


@app.get("/videos/{video_id}/{filename:path}")
async def serve_dash_file(video_id: int, filename: str):
    """Serve any DASH file (init-stream*.m4s, chunk-stream*.m4s) with CDN caching."""
    global _cache_hits, _cache_misses, _active_reqs
    normalized = os.path.normpath(filename).replace("\\", "/").lstrip("/")
    if normalized.startswith("../") or normalized == "..":
        raise HTTPException(status_code=400, detail="Invalid filename")
    _active_reqs += 1
    try:
        cache_path = os.path.join(CACHE_PATH, str(video_id), normalized)
        if os.path.exists(cache_path):
            _cache_hits += 1
            mt = _media_type_for_path(normalized)
            return FileResponse(cache_path, media_type=mt)

        _cache_misses += 1
        async with httpx.AsyncClient() as client:
            r = await client.get(
                f"{ORIGIN_URL}/api/videos/{video_id}/{normalized}", timeout=30.0
            )
            if r.status_code == 200:
                os.makedirs(os.path.dirname(cache_path), exist_ok=True)
                async with aiofiles.open(cache_path, "wb") as f:
                    await f.write(r.content)
                mt = _media_type_for_path(normalized)
                return Response(content=r.content, media_type=mt)

        raise HTTPException(status_code=404, detail="File not found")
    finally:
        _active_reqs -= 1


@app.get("/trailers/{series_id}/{filename:path}")
async def serve_trailer(series_id: int, filename: str):
    global _cache_hits, _cache_misses, _active_reqs
    normalized = os.path.normpath(filename).replace("\\", "/").lstrip("/")
    if normalized.startswith("../") or normalized == "..":
        raise HTTPException(status_code=400, detail="Invalid filename")
    _active_reqs += 1
    try:
        cache_path = _trailer_cache(series_id, normalized)
        mt = _media_type_for_path(normalized)
        if os.path.exists(cache_path):
            _cache_hits += 1
            return FileResponse(cache_path, media_type=mt, headers={"X-Cache": "HIT", "Cache-Control": "public, max-age=300"})

        _cache_misses += 1
        async with httpx.AsyncClient() as client:
            r = await client.get(
                f"{ORIGIN_URL}/api/catalog/series/{series_id}/trailer/{normalized}", timeout=30.0
            )
            if r.status_code == 200:
                os.makedirs(os.path.dirname(cache_path), exist_ok=True)
                async with aiofiles.open(cache_path, "wb") as f:
                    await f.write(r.content)
                return Response(content=r.content, media_type=(r.headers.get("content-type") or mt), headers={"X-Cache": "MISS", "Cache-Control": "public, max-age=300"})

        raise HTTPException(status_code=404, detail="Trailer not found")
    finally:
        _active_reqs -= 1
