import asyncio
import json
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


def _normalize_track_language(value: str | None) -> str:
    text = (value or "und").strip().lower()
    return text or "und"


def _build_track_payload(stream: dict, track_type: str) -> dict:
    tags = stream.get("tags") or {}
    disposition = stream.get("disposition") or {}
    return {
        "track_type": track_type,
        "language": _normalize_track_language(tags.get("language")),
        "label": (tags.get("title") or "").strip() or None,
        "codec": stream.get("codec_name"),
        "is_default": bool(disposition.get("default")),
    }


async def probe_media_tracks(raw_path: str) -> dict[str, list[dict]]:
    probe = await asyncio.create_subprocess_exec(
        "ffprobe",
        "-v", "error",
        "-show_entries", "stream=index,codec_type,codec_name:stream_tags=language,title:stream_disposition=default",
        "-of", "json",
        raw_path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await probe.communicate()
    if probe.returncode != 0:
        err = stderr.decode("utf-8", errors="ignore").strip()
        raise RuntimeError(err or "ffprobe failed while reading media tracks")

    payload = json.loads(stdout.decode("utf-8", errors="ignore") or "{}")
    streams = payload.get("streams") or []
    return {
        "audio": [_build_track_payload(stream, "audio") for stream in streams if stream.get("codec_type") == "audio"],
        "subtitle": [_build_track_payload(stream, "subtitle") for stream in streams if stream.get("codec_type") == "subtitle"],
    }


async def extract_subtitle_sidecars(raw_path: str, output_dir: str, subtitle_tracks: list[dict]) -> list[dict]:
    extracted_tracks = []
    for subtitle_index, track in enumerate(subtitle_tracks):
        subtitle_path = Path(output_dir) / f"subtitle_{subtitle_index}.vtt"
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-y",
            "-i", raw_path,
            "-map", f"0:s:{subtitle_index}",
            "-c:s", "webvtt",
            str(subtitle_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, _ = await proc.communicate()
        if proc.returncode == 0 and subtitle_path.exists():
            extracted_tracks.append({
                **track,
                "subtitle_index": subtitle_index,
            })

    return extracted_tracks


async def encode_video_to_dash(raw_path: str, output_dir: str) -> dict:
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "manifest.mpd"
    track_probe = await probe_media_tracks(raw_path)
    audio_tracks = track_probe["audio"]
    subtitle_tracks = track_probe["subtitle"]
    has_audio = bool(audio_tracks)

    ffmpeg_cmd = [
        "ffmpeg", "-y", "-i", raw_path,
        "-map", "0:v", "-map", "0:v", "-map", "0:v", "-map", "0:v",
        "-filter:v:0", "scale=640:360",
        "-filter:v:1", "scale=854:480",
        "-filter:v:2", "scale=1280:720",
        "-filter:v:3", "scale=1920:1080",
        "-b:v:0", "400k", "-maxrate:v:0", "450k", "-bufsize:v:0", "600k",
        "-b:v:1", "800k", "-maxrate:v:1", "856k", "-bufsize:v:1", "1200k",
        "-b:v:2", "1500k", "-maxrate:v:2", "1605k", "-bufsize:v:2", "2250k",
        "-b:v:3", "3000k", "-maxrate:v:3", "3300k", "-bufsize:v:3", "4500k",
        "-c:v", "libx264", "-preset", "fast", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
        "-use_timeline", "1", "-use_template", "1", "-seg_duration", "4",
    ]

    if has_audio:
        for audio_index, _ in enumerate(audio_tracks):
            ffmpeg_cmd += ["-map", f"0:a:{audio_index}"]
        for audio_index, _ in enumerate(audio_tracks):
            ffmpeg_cmd += [
                f"-c:a:{audio_index}", "aac",
                f"-b:a:{audio_index}", "128k",
                f"-ac:a:{audio_index}", "2",
            ]
        ffmpeg_cmd += ["-adaptation_sets", "id=0,streams=v id=1,streams=a"]
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

    extracted_subtitles = await extract_subtitle_sidecars(raw_path, output_dir, subtitle_tracks)

    files = [p for p in out_dir.glob("*") if p.is_file() and p.suffix in {".mpd", ".m4s", ".vtt"}]
    total_segments = len([p for p in files if p.suffix == ".m4s"])

    return {
        "duration_seconds": max(1, duration_seconds),
        "total_segments": total_segments,
        "manifest_path": str(manifest_path),
        "files": [str(p) for p in files],
        "tracks": [*audio_tracks, *extracted_subtitles],
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
