from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..models import BufferEvent
from ..schemas import BufferingReport, BufferingRecommendation

router = APIRouter()

QUALITIES   = ["320p", "480p", "720p"]
MIN_BUFFER  = 10.0
MAX_BUFFER  = 60.0
RESERVOIR   = 10.0   # 0 - 10s  → lowest quality
CUSHION_TOP = 45.0   # 10 - 45s → linear interpolation
                     # 45 - 60s → highest quality


def bba(buffer_seconds: float) -> tuple[str, str]:
    """Buffer-Based Adaptation. Returns (quality, zone)."""
    if buffer_seconds <= RESERVOIR:
        return "320p", "reservoir"
    if buffer_seconds >= CUSHION_TOP:
        return "720p", "upper_reservoir"
    ratio = (buffer_seconds - RESERVOIR) / (CUSHION_TOP - RESERVOIR)
    idx   = min(int(ratio * len(QUALITIES)), len(QUALITIES) - 1)
    return QUALITIES[idx], "cushion"


@router.post("/report", response_model=BufferingRecommendation)
async def report_buffer(data: BufferingReport, db: AsyncSession = Depends(get_db)):
    quality, zone = bba(data.current_buffer_seconds)

    last_seg       = max(data.segments_buffered) if data.segments_buffered else 0
    prefetch_count = 5 if zone != "reservoir" else 2
    prefetch_segs  = list(range(last_seg + 1, last_seg + 1 + prefetch_count))

    priority              = "audio" if data.current_buffer_seconds < 5.0 else "video"
    should_prefetch_next  = data.playhead_position > 0

    event = BufferEvent(
        session_id=data.session_id,
        video_id=data.video_id,
        buffer_seconds=data.current_buffer_seconds,
        quality=data.current_quality,
        recommended_quality=quality,
        playhead_position=data.playhead_position,
        download_speed_kbps=data.download_speed_kbps,
        buffer_zone=zone,
    )
    db.add(event)
    await db.commit()

    return BufferingRecommendation(
        recommended_quality=quality,
        buffer_zone=zone,
        prefetch_segments=prefetch_segs,
        should_prefetch_next_episode=should_prefetch_next,
        priority=priority,
    )


@router.get("/config/{video_id}")
async def buffer_config(video_id: int):
    return {
        "video_id":                  video_id,
        "min_buffer_seconds":        MIN_BUFFER,
        "max_buffer_seconds":        MAX_BUFFER,
        "reservoir_threshold":       RESERVOIR,
        "cushion_threshold":         CUSHION_TOP,
        "available_qualities":       QUALITIES,
        "audio_priority_threshold":  5.0,
    }


@router.get("/session/{session_id}/history")
async def buffer_history(session_id: str, db: AsyncSession = Depends(get_db)):
    from sqlalchemy import select
    result = await db.execute(
        select(BufferEvent)
        .where(BufferEvent.session_id == session_id)
        .order_by(BufferEvent.timestamp)
    )
    events = result.scalars().all()
    return {
        "session_id": session_id,
        "events": [
            {
                "buffer_seconds":      e.buffer_seconds,
                "quality":             e.quality,
                "recommended_quality": e.recommended_quality,
                "buffer_zone":         e.buffer_zone,
                "playhead_position":   e.playhead_position,
                "timestamp":           e.timestamp.isoformat(),
            }
            for e in events
        ],
    }
