from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime


class LoginRequest(BaseModel):
    username: str
    password: str


class RegisterRequest(BaseModel):
    username: str
    email: str
    password: str


class UserOut(BaseModel):
    id: int
    username: str
    email: str
    role: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str
    user: UserOut


class CDNNodeRegister(BaseModel):
    node_id:  str
    name:     str
    location: str
    url:      str


class CDNHeartbeat(BaseModel):
    latency_ms:       int
    load_percent:     float
    cache_hit_count:  int
    cache_miss_count: int


class BufferingReport(BaseModel):
    session_id:             str
    video_id:               int
    current_buffer_seconds: float
    current_quality:        str
    playhead_position:      float
    segments_buffered:      List[int]
    download_speed_kbps:    int


class BufferingRecommendation(BaseModel):
    recommended_quality:        str
    buffer_zone:                str
    prefetch_segments:          List[int]
    should_prefetch_next_episode: bool
    priority:                   str
