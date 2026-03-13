-- Netflix Streaming Demo - Database Init

-- Drop everything cleanly so each fresh container starts from scratch
DROP TABLE IF EXISTS watch_progress CASCADE;
DROP TABLE IF EXISTS media_tracks   CASCADE;
DROP TABLE IF EXISTS episodes       CASCADE;
DROP TABLE IF EXISTS seasons        CASCADE;
DROP TABLE IF EXISTS series         CASCADE;
DROP TABLE IF EXISTS buffer_events CASCADE;
DROP TABLE IF EXISTS sessions     CASCADE;
DROP TABLE IF EXISTS cdn_nodes    CASCADE;
DROP TABLE IF EXISTS videos       CASCADE;
DROP TABLE IF EXISTS users        CASCADE;

CREATE TABLE IF NOT EXISTS videos (
    id          SERIAL PRIMARY KEY,
    title       VARCHAR(255) NOT NULL,
    description TEXT,
    duration_seconds  INTEGER DEFAULT 0,
    total_segments    INTEGER DEFAULT 0,
    available_qualities TEXT[] DEFAULT '{}',
    storage_path VARCHAR(512),
    thumbnail_path VARCHAR(1024),
    next_episode_id INTEGER REFERENCES videos(id),
    created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cdn_nodes (
    id               VARCHAR(64) PRIMARY KEY,
    name             VARCHAR(128) NOT NULL,
    location         VARCHAR(64)  NOT NULL,
    url              VARCHAR(256) NOT NULL,
    status           VARCHAR(16)  DEFAULT 'active',
    latency_ms       INTEGER      DEFAULT 0,
    load_percent     FLOAT        DEFAULT 0.0,
    cache_hit_count  INTEGER      DEFAULT 0,
    cache_miss_count INTEGER      DEFAULT 0,
    last_heartbeat   TIMESTAMP    DEFAULT NOW(),
    created_at       TIMESTAMP    DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
    id              VARCHAR(64) PRIMARY KEY,
    user_id         VARCHAR(64),
    video_id        INTEGER REFERENCES videos(id),
    cdn_node_id     VARCHAR(64) REFERENCES cdn_nodes(id),
    status          VARCHAR(16) DEFAULT 'active',
    quality         VARCHAR(8)  DEFAULT '320p',
    playhead_position FLOAT     DEFAULT 0.0,
    created_at      TIMESTAMP   DEFAULT NOW(),
    ended_at        TIMESTAMP
);

CREATE TABLE IF NOT EXISTS buffer_events (
    id                  SERIAL PRIMARY KEY,
    session_id          VARCHAR(64) REFERENCES sessions(id),
    video_id            INTEGER,
    buffer_seconds      FLOAT,
    quality             VARCHAR(8),
    recommended_quality VARCHAR(8),
    playhead_position   FLOAT,
    download_speed_kbps INTEGER,
    buffer_zone         VARCHAR(16),
    timestamp           TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(64)  UNIQUE NOT NULL,
    email         VARCHAR(256) UNIQUE NOT NULL,
    password_hash VARCHAR(256) NOT NULL,
    role          VARCHAR(16)  DEFAULT 'user',
    created_at    TIMESTAMP    DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS series (
    id            SERIAL PRIMARY KEY,
    tmdb_id       INTEGER,
    title         VARCHAR(255) NOT NULL,
    synopsis      TEXT,
    content_type  VARCHAR(16) DEFAULT 'series',
    year          INTEGER,
    maturity      VARCHAR(16) DEFAULT 'TV-14',
    genres        TEXT[] DEFAULT '{}',
    poster_url    VARCHAR(512),
    backdrop_url  VARCHAR(512),
    logo_url      VARCHAR(512),
    popularity    FLOAT DEFAULT 0.0,
    featured      BOOLEAN DEFAULT FALSE,
    created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS seasons (
    id            SERIAL PRIMARY KEY,
    series_id     INTEGER NOT NULL REFERENCES series(id),
    season_number INTEGER NOT NULL,
    title         VARCHAR(255),
    created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS episodes (
    id                     SERIAL PRIMARY KEY,
    series_id              INTEGER NOT NULL REFERENCES series(id),
    season_id              INTEGER NOT NULL REFERENCES seasons(id),
    episode_number         INTEGER NOT NULL,
    title                  VARCHAR(255) NOT NULL,
    synopsis               TEXT,
    duration_sec           INTEGER DEFAULT 0,
    video_id               INTEGER REFERENCES videos(id),
    playable               BOOLEAN DEFAULT FALSE,
    demo_fallback_video_id INTEGER REFERENCES videos(id),
    created_at             TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS media_tracks (
    id         SERIAL PRIMARY KEY,
    episode_id INTEGER NOT NULL REFERENCES episodes(id),
    track_type VARCHAR(16) NOT NULL,
    language   VARCHAR(32) NOT NULL,
    label      VARCHAR(64),
    codec      VARCHAR(32),
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS watch_progress (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id),
    episode_id       INTEGER NOT NULL REFERENCES episodes(id),
    playhead_seconds FLOAT DEFAULT 0.0,
    completed        BOOLEAN DEFAULT FALSE,
    updated_at       TIMESTAMP DEFAULT NOW()
);

-- Sample videos
INSERT INTO videos (title, description, duration_seconds, total_segments, available_qualities, storage_path)
VALUES
    ('Demo Episode 1', 'First episode - Intelligent Buffering Demo', 900, 150,
    ARRAY['320p','480p','720p'], '/videos/1'),
    ('Demo Episode 2', 'Second episode - CDN Failover Demo', 900, 150,
    ARRAY['320p','480p','720p'], '/videos/2')
ON CONFLICT DO NOTHING;

-- Link episode 1 -> episode 2 for next-episode preload demo
UPDATE videos SET next_episode_id = 2 WHERE id = 1;

-- Catalog metadata is now seeded by script:
-- python -m app.scripts.seed_tmdb_movies --limit 100
