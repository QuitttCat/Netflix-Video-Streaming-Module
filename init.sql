-- Netflix Streaming Demo - Database Init

CREATE TABLE IF NOT EXISTS videos (
    id          SERIAL PRIMARY KEY,
    title       VARCHAR(255) NOT NULL,
    description TEXT,
    duration_seconds  INTEGER DEFAULT 0,
    total_segments    INTEGER DEFAULT 0,
    available_qualities TEXT[] DEFAULT '{}',
    storage_path VARCHAR(512),
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
    quality         VARCHAR(8)  DEFAULT '360p',
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

-- Sample videos
INSERT INTO videos (title, description, duration_seconds, total_segments, available_qualities, storage_path)
VALUES
    ('Demo Episode 1', 'First episode - Intelligent Buffering Demo', 900, 150,
     ARRAY['360p','480p','720p','1080p'], '/videos/1'),
    ('Demo Episode 2', 'Second episode - CDN Failover Demo', 900, 150,
     ARRAY['360p','480p','720p','1080p'], '/videos/2')
ON CONFLICT DO NOTHING;

-- Link episode 1 -> episode 2 for next-episode preload demo
UPDATE videos SET next_episode_id = 2 WHERE id = 1;
