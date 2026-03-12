from sqlalchemy import Column, Integer, String, Float, DateTime, ARRAY, ForeignKey, Text
from datetime import datetime
from .database import Base


class Video(Base):
    __tablename__ = "videos"
    id                  = Column(Integer, primary_key=True)
    title               = Column(String(255))
    description         = Column(Text)
    duration_seconds    = Column(Integer, default=0)
    total_segments      = Column(Integer, default=0)
    available_qualities = Column(ARRAY(String))
    storage_path        = Column(String(512))
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
