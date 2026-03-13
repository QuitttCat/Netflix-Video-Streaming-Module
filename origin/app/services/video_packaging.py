import asyncio
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Optional

from ..models import Episode
from .s3_media import S3MediaService, infer_content_type, join_key


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


async def encode_video_to_dash(raw_path: str, output_dir: str) -> dict:
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "manifest.mpd"
    has_audio = await detect_audio_stream(raw_path)

    ffmpeg_cmd = [
        "ffmpeg", "-y", "-i", raw_path,
        "-map", "0:v", "-map", "0:v", "-map", "0:v",
        "-filter:v:0", "scale=320:180",
        "-filter:v:1", "scale=854:480",
        "-filter:v:2", "scale=1280:720",
        "-b:v:0", "250k", "-maxrate:v:0", "267k", "-bufsize:v:0", "375k",
        "-b:v:1", "800k", "-maxrate:v:1", "856k", "-bufsize:v:1", "1200k",
        "-b:v:2", "1500k", "-maxrate:v:2", "1605k", "-bufsize:v:2", "2250k",
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
        err = stderr.decode("utf-8", errors="ignore")
        raise RuntimeError(f"{err[:1200]}\n...\n{err[-1200:]}")

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

    files = [p for p in out_dir.glob("*") if p.is_file() and p.suffix in {".mpd", ".m4s"}]
    total_segments = len([p for p in files if p.suffix == ".m4s"])

    return {
        "duration_seconds": max(1, duration_seconds),
        "total_segments": total_segments,
        "manifest_path": str(manifest_path),
        "files": [str(p) for p in files],
    }


def build_video_hierarchy_prefix(
    *,
    video_id: int,
    episode: Optional[Episode],
    season_number: Optional[int],
    series_content_type: Optional[str],
    root: Optional[str] = None,
) -> str:
    root_prefix = (root or os.getenv("S3_MEDIA_ROOT", "netflix")).strip("/")

    if episode and season_number is not None and episode.series_id is not None:
        if (series_content_type or "series") == "movie":
            return f"{root_prefix}/movies/series-{episode.series_id}/video-{video_id}/dash"
        return (
            f"{root_prefix}/series/series-{episode.series_id}"
            f"/season-{season_number}/episode-{episode.episode_number}/video-{video_id}/dash"
        )

    return f"{root_prefix}/videos/video-{video_id}/dash"


async def upload_dash_directory_to_s3(local_dir: str, s3_prefix: str, s3_service: S3MediaService) -> dict:
    uploaded = []
    for file_path in sorted(Path(local_dir).glob("*")):
        if not file_path.is_file():
            continue
        key = join_key(s3_prefix, file_path.name)
        s3_service.upload_file(str(file_path), key, infer_content_type(str(file_path)))
        uploaded.append(key)

    return {
        "s3_prefix": s3_prefix,
        "uploaded_files": uploaded,
        "manifest_key": join_key(s3_prefix, "manifest.mpd"),
    }


async def encode_and_upload_dash_to_s3(
    *,
    raw_bytes: bytes,
    raw_filename: str,
    video_id: int,
    s3_prefix: str,
    s3_service: S3MediaService,
) -> dict:
    with TemporaryDirectory(prefix=f"dash-video-{video_id}-") as tmp_dir:
        raw_path = str(Path(tmp_dir) / (raw_filename or "raw.mp4"))
        with open(raw_path, "wb") as f:
            f.write(raw_bytes)

        dash_out_dir = str(Path(tmp_dir) / "dash")
        encoded = await encode_video_to_dash(raw_path, dash_out_dir)
        uploaded = await upload_dash_directory_to_s3(dash_out_dir, s3_prefix, s3_service)

        return {
            **encoded,
            **uploaded,
        }
