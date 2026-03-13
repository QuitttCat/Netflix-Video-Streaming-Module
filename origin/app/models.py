from sqlalchemy import Column, Integer, String, Float, DateTime, ARRAY, ForeignKey, Text, Boolean
from datetime import datetime
from .database import Base


class User(Base):
    __tablename__ = "users"
    id            = Column(Integer, primary_key=True, autoincrement=True)
    username      = Column(String(64), unique=True, nullable=False)
    email         = Column(String(256), unique=True, nullable=False)
    password_hash = Column(String(256), nullable=False)
    role          = Column(String(16), default="user")  # "user" | "admin"
    created_at    = Column(DateTime, default=datetime.utcnow)


class Series(Base):
    __tablename__ = "series"
    id            = Column(Integer, primary_key=True, autoincrement=True)
    tmdb_id       = Column(Integer, nullable=True)
    title         = Column(String(255), nullable=False)
    synopsis      = Column(Text, default="")
    content_type  = Column(String(16), default="series")  # series | movie
    year          = Column(Integer, nullable=True)
    maturity      = Column(String(16), default="TV-14")
    genres        = Column(ARRAY(String), default=[])
    poster_url    = Column(String(512), nullable=True)
    backdrop_url  = Column(String(512), nullable=True)
    logo_url      = Column(String(512), nullable=True)
    popularity    = Column(Float, default=0.0)
    featured      = Column(Boolean, default=False)
    created_at    = Column(DateTime, default=datetime.utcnow)


class Season(Base):
    __tablename__ = "seasons"
    id            = Column(Integer, primary_key=True, autoincrement=True)
    series_id     = Column(Integer, ForeignKey("series.id"), nullable=False)
    season_number = Column(Integer, nullable=False)
    title         = Column(String(255), nullable=True)
    created_at    = Column(DateTime, default=datetime.utcnow)


class Episode(Base):
    __tablename__ = "episodes"
    id             = Column(Integer, primary_key=True, autoincrement=True)
    series_id      = Column(Integer, ForeignKey("series.id"), nullable=False)
    season_id      = Column(Integer, ForeignKey("seasons.id"), nullable=False)
    episode_number = Column(Integer, nullable=False)
    title          = Column(String(255), nullable=False)
    synopsis       = Column(Text, default="")
    duration_sec   = Column(Integer, default=0)
    video_id       = Column(Integer, ForeignKey("videos.id"), nullable=True)
    playable       = Column(Boolean, default=False)
    demo_fallback_video_id = Column(Integer, ForeignKey("videos.id"), nullable=True)
    created_at     = Column(DateTime, default=datetime.utcnow)


class MediaTrack(Base):
    __tablename__ = "media_tracks"
    id          = Column(Integer, primary_key=True, autoincrement=True)
    episode_id  = Column(Integer, ForeignKey("episodes.id"), nullable=False)
    track_type  = Column(String(16), nullable=False)  # audio | subtitle
    language    = Column(String(32), nullable=False)
    label       = Column(String(64), nullable=True)
    codec       = Column(String(32), nullable=True)
    is_default  = Column(Boolean, default=False)
    created_at  = Column(DateTime, default=datetime.utcnow)


class WatchProgress(Base):
    __tablename__ = "watch_progress"
    id               = Column(Integer, primary_key=True, autoincrement=True)
    user_id          = Column(Integer, ForeignKey("users.id"), nullable=False)
    episode_id       = Column(Integer, ForeignKey("episodes.id"), nullable=False)
    playhead_seconds = Column(Float, default=0.0)
    completed        = Column(Boolean, default=False)
    updated_at       = Column(DateTime, default=datetime.utcnow)


class Video(Base):
    __tablename__ = "videos"
    id                  = Column(Integer, primary_key=True)
    title               = Column(String(255))
    description         = Column(Text)
    duration_seconds    = Column(Integer, default=0)
    total_segments      = Column(Integer, default=0)
    available_qualities = Column(ARRAY(String))
    storage_path        = Column(String(512))
    thumbnail_path      = Column(String(1024), nullable=True)
    next_episode_id     = Column(Integer, ForeignKey("videos.id"), nullable=True)
    created_at          = Column(DateTime, default=datetime.utcnow)


class CDNNode(Base):
    __tablename__ = "cdn_nodes"
    id               = Column(String(64), primary_key=True)
    name             = Column(String(128))
    location         = Column(String(64))
    url              = Column(String(256))
    status           = Column(String(16), default="active")
    latency_ms       = Column(Integer, default=0)
    load_percent     = Column(Float, default=0.0)
    cache_hit_count  = Column(Integer, default=0)
    cache_miss_count = Column(Integer, default=0)
    last_heartbeat   = Column(DateTime, default=datetime.utcnow)
    created_at       = Column(DateTime, default=datetime.utcnow)


class Session(Base):
    __tablename__ = "sessions"
    id                = Column(String(64), primary_key=True)
    user_id           = Column(String(64))
    video_id          = Column(Integer, ForeignKey("videos.id"))
    cdn_node_id       = Column(String(64), ForeignKey("cdn_nodes.id"), nullable=True)
    status            = Column(String(16), default="active")
    quality           = Column(String(8), default="360p")
    playhead_position = Column(Float, default=0.0)
    created_at        = Column(DateTime, default=datetime.utcnow)
    ended_at          = Column(DateTime, nullable=True)


class BufferEvent(Base):
    __tablename__ = "buffer_events"
    id                  = Column(Integer, primary_key=True, autoincrement=True)
    session_id          = Column(String(64), ForeignKey("sessions.id"))
    video_id            = Column(Integer)
    buffer_seconds      = Column(Float)
    quality             = Column(String(8))
    recommended_quality = Column(String(8))
    playhead_position   = Column(Float)
    download_speed_kbps = Column(Integer)
    buffer_zone         = Column(String(16))
    timestamp           = Column(DateTime, default=datetime.utcnow)
