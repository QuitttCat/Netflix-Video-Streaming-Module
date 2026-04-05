import os
import json
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update, delete
import redis.asyncio as aioredis

from urllib.parse import urlparse

from ..database import get_db
from ..models import CDNNode
from ..schemas import CDNNodeRegister, CDNHeartbeat

router = APIRouter()
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
PUBLIC_URL = os.getenv("PUBLIC_URL", "").rstrip("/")  # e.g. https://netflix.devomatic.dev


async def get_redis():
    r = aioredis.from_url(REDIS_URL)
    try:
        yield r
    finally:
        await r.aclose()


@router.post("/register")
async def register_node(data: CDNNodeRegister, db: AsyncSession = Depends(get_db)):
    node = CDNNode(
        id=data.node_id,
        name=data.name,
        location=data.location,
        url=data.url,
        status="active",
        last_heartbeat=datetime.utcnow(),
    )
    await db.merge(node)
    await db.commit()
    return {"message": "registered", "node_id": data.node_id}


@router.put("/heartbeat/{node_id}")
async def heartbeat(
    node_id: str,
    data: CDNHeartbeat,
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
):
    result = await db.execute(select(CDNNode).where(CDNNode.id == node_id))
    node = result.scalar_one_or_none()
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")

    await db.execute(
        update(CDNNode).where(CDNNode.id == node_id).values(
            latency_ms=data.latency_ms,
            load_percent=data.load_percent,
            cache_hit_count=data.cache_hit_count,
            cache_miss_count=data.cache_miss_count,
            last_heartbeat=datetime.utcnow(),
            status="active",
        )
    )
    await db.commit()
    await redis.setex(f"cdn:health:{node_id}", 30, json.dumps(data.model_dump()))
    return {"ok": True}


@router.get("/best-node")
async def best_node(
    videoId: int,
    clientRegion: str = "dhaka",
    db: AsyncSession = Depends(get_db),
):
    # Only consider nodes that are active AND have sent a heartbeat within the last 15s
    stale_cutoff = datetime.utcnow() - timedelta(seconds=15)
    result = await db.execute(
        select(CDNNode).where(
            CDNNode.status == "active",
            CDNNode.last_heartbeat >= stale_cutoff,
        )
    )
    nodes = result.scalars().all()
    if not nodes:
        raise HTTPException(status_code=503, detail="No CDN nodes available")

    def score(n: CDNNode):
        region_bonus = 0 if (n.location or "").lower() == (clientRegion or "").lower() else 100
        return region_bonus + float(n.load_percent or 0) + float(n.latency_ms or 0) / 10

    best = min(nodes, key=score)

    # If PUBLIC_URL is set, route browser traffic through nginx CDN proxy paths
    # to avoid mixed content (HTTPS page → HTTP CDN node)
    node_num = best.id.replace("cdn-node-", "") if best.id else ""
    if PUBLIC_URL and node_num.isdigit():
        client_url = f"{PUBLIC_URL}/cdn{node_num}"
    else:
        # Fallback: direct CDN IP (works for HTTP-only deployments)
        raw_url = best.url or ""
        parsed = urlparse(raw_url)
        host = parsed.hostname or ""
        if host in {"cdn-node-1", "cdn-node-2", "cdn-node-3", "origin"}:
            host = "localhost"
        client_url = f"{parsed.scheme}://{host}:{parsed.port}" if parsed.port else f"{parsed.scheme}://{host}"

    return {
        "node_id":      best.id,
        "name":         best.name,
        "url":          client_url,
        "internal_url": best.url,
        "location":     best.location,
        "latency_ms":   best.latency_ms,
        "load_percent": best.load_percent,
    }


@router.get("/stats")
async def stats(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(CDNNode))
    nodes = result.scalars().all()
    return {
        "nodes": [
            {
                "id":               n.id,
                "name":             n.name,
                "location":         n.location,
                "status":           n.status,
                "latency_ms":       n.latency_ms,
                "load_percent":     n.load_percent,
                "cache_hit_count":  n.cache_hit_count,
                "cache_miss_count": n.cache_miss_count,
                "cache_hit_ratio":  round(
                    n.cache_hit_count / max(1, n.cache_hit_count + n.cache_miss_count) * 100, 1
                ),
                "last_heartbeat": n.last_heartbeat.isoformat() if n.last_heartbeat else None,
            }
            for n in nodes
        ]
    }


@router.delete("/nodes/{node_id}")
async def remove_node(node_id: str, db: AsyncSession = Depends(get_db)):
    await db.execute(delete(CDNNode).where(CDNNode.id == node_id))
    await db.commit()
    return {"message": "removed"}
