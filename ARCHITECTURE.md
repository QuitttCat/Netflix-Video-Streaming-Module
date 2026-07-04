# Architecture

What we actually built, engineered, and deployed — the CDN simulation, streaming pipeline, and the DevOps around it.

## System Overview

Seven services, all containerized:

| Service      | Role                                           | Tech                          |
|--------------|------------------------------------------------|--------------------------------|
| `postgres`   | Source of truth (catalog, sessions, CDN state)  | PostgreSQL 16                  |
| `redis`      | Manifest cache, CDN health cache                | Redis 7                        |
| `origin`     | API, auth, video packaging, CDN orchestration   | FastAPI (Python), SQLAlchemy async |
| `cdn-node-1/2/3` | Edge cache nodes                            | FastAPI, on-disk segment cache  |
| `frontend`   | Player, admin dashboard                         | React, dash.js                 |

Origin is the only service that talks to Postgres/Redis. CDN nodes are dumb, stateless caches that only know how to talk to the origin and to disk.

## CDN Simulation

This is the core of the project: a real (not mocked) edge-caching layer with node registration, health tracking, region-aware routing, and mid-session failover.

### Node lifecycle ([cdn-node-1/app/main.py](cdn-node-1/app/main.py))

Each CDN node is an independent FastAPI process (`cdn-node-1`, `cdn-node-2`, `cdn-node-3`, mapped to `edge-dhaka` / `edge-chittagong` / `edge-sylhet` locally, and to `bangalore` / `san-francisco` / `frankfurt` in the production topology).

On startup, a node:
1. Waits 5s, then `POST /api/cdn/register`s itself with the origin (retries up to 15 times, 3s apart) — id, name, location, and a reachable URL.
2. Starts an infinite heartbeat loop: every 5s, `PUT /api/cdn/heartbeat/{node_id}` with `latency_ms` (simulated, random 5-40ms), `load_percent`, and cumulative cache hit/miss counts.

Load isn't just instantaneous request count — it's smoothed with an EMA (`smoothed = smoothed*0.6 + instant*0.4`) so it doesn't spike/collapse to zero between heartbeats and reads believably on the dashboard.

### Origin-side registry ([origin/app/routers/cdn.py](origin/app/routers/cdn.py))

- `POST /register` — upserts the node row (`db.merge`) with `status="active"`.
- `PUT /heartbeat/{node_id}` — updates latency/load/cache counters and `last_heartbeat`, and also writes a 30s-TTL snapshot into Redis (`cdn:health:{node_id}`) so health reads don't have to hit Postgres.
- `GET /best-node` / the scoring logic reused in `playback.py` — only considers nodes whose last heartbeat is within 15s (stale nodes are silently excluded, not just down-ranked). Scores by `region_bonus + load_percent + latency_ms/10`, where `region_bonus` is `0` if the node's location matches the client's region, else `+100`. This means region match dominates the score, and load/latency only break ties within a region or when nothing matches.
- `GET /stats` — full fleet status + cache hit ratio (`hits / (hits + misses)`), used by both the frontend polling loop and the admin dashboard.

### Edge caching behavior

Every CDN node endpoint (`/videos/{id}/manifest.mpd`, `/videos/{id}/segments/{q}/{n}`, generic DASH file passthrough, trailers) follows the same pattern:
1. Check local disk cache (`/cache/{video_id}/...`).
2. On hit, serve directly (`_cache_hits++`).
3. On miss, pull from origin (`ORIGIN_URL`), write through to disk, then serve (`_cache_misses++`).

Path traversal is explicitly guarded (`os.path.normpath` + rejecting `../`) since filenames come straight from the URL. Trailer responses also emit `X-Cache: HIT/MISS` headers, so cache behavior is directly observable from the browser network tab — used to demo cold vs warm trailer playback.

### Region-aware routing + client-side failover

- On playback start, the **frontend** maps the browser timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) to a region (`bangalore` / `frankfurt` / `san-francisco`), sanity-checks that region's node is alive via `/api/cdn/stats` (heartbeat within 20s), and only then requests `/api/playback/start?clientRegion=...`.
- The **origin** picks the actual node using the same scoring function described above, independent of what the frontend guessed — the frontend's check is just to avoid requesting a dead region up front.
- While playing, the frontend polls `/api/cdn/stats` every 15s. If the current node's heartbeat is >20s old, it's dead — the frontend switches to the freshest/lowest-latency alternative and repoints the player at the new node's manifest URL. It does **not** fail over just because another node is marginally faster — only on actual death, to avoid interrupting playback for no reason.

### Server-side next-episode prefetch ([origin/app/routers/prefetch.py](origin/app/routers/prefetch.py))

When playhead crosses 90% of an episode, the origin doesn't just tell the client to prefetch — it actively warms the CDN itself:
1. Resolves the next episode via season/episode ordering.
2. Fetches that episode's DASH manifest from the *currently assigned* CDN node.
3. Parses the MPD's `SegmentTemplate` (`$RepresentationID$` / `$Number$` substitution) to compute concrete segment URLs for the first 5 segments of every representation.
4. Issues real GETs against the CDN node for each, forcing cache population before the client ever asks — so the actual segment fetch when episode 2 starts is a cache hit, not a cold origin round-trip.

Progress is tracked in an in-memory `prefetch_status_store` keyed by `session_id:video_id`, polled by the frontend to drive the "preloading Episode 2" banner.

## Adaptive Bitrate — Buffer-Based Adaptation (BBA)

Implemented from scratch in [origin/app/routers/buffering.py](origin/app/routers/buffering.py), not delegated to dash.js's built-in ABR:

- **Reservoir** (0–10s buffered): force lowest quality (360p).
- **Cushion** (10–45s): linear interpolation across `[360p, 480p, 720p, 1080p]` by buffer fill ratio.
- **Upper reservoir** (45–60s): force highest quality (1080p).
- **Audio priority**: if buffer < 5s, prefetch/report priority flips to `audio` over `video` so sound doesn't cut out even if video stalls.

Every buffer report is persisted (`BufferEvent`) with the recommended quality, actual quality, zone, and download speed — this is what backs the admin dashboard's live buffer-event feed and the "63+ buffer events" verification mentioned in testing.

**Why a network simulator exists on the frontend:** on localhost, inter-container bandwidth is effectively infinite, so dash.js's real buffer fills instantly and BBA never has a reason to downgrade quality — the algorithm can't be observed. The fix was a parallel simulated buffer: every 500ms it gains `(networkCap / currentBitrate) × 0.5`s and loses `0.5`s to playback, driven by a `capKbps` value the demo buttons (Good/Medium/Poor/Offline) set. This never throttles the real network — it's a math model that reacts the same way BBA would under real constrained bandwidth, purely for demoing the algorithm honestly.

## Video Pipeline

- Ingested as MP4, transcoded via `ffmpeg` into **MPEG-DASH**: two renditions (180p/360p via `scale` filter, extendable to 1080p) + AAC audio, 4-second segments, `libx264` with `-g 48 -keyint_min 48 -sc_threshold 0` (fixed GOP so segment boundaries always land on keyframes — required for clean adaptive switching).
- Manifest (`manifest.mpd`) and segments are served through `origin/app/routers/videos.py` and `media_storage.py`, backed by either local disk (`VIDEO_STORAGE_PATH`) or S3 (`VIDEO_STORAGE_BACKEND=s3`, via [origin/app/services/s3_media.py](origin/app/services/s3_media.py)) — origin storage is decoupled from the CDN's own edge cache.
- Multi-audio and subtitle tracks are modeled as `MediaTrack` rows per episode and surfaced through `/api/playback/start`.

## Real-Time Observability

`origin/app/routers/monitor.py` exposes a `WebSocket` at `/ws/monitor` that pushes, every 2s: active sessions, full CDN node health (status/load/latency/cache-hit-ratio), and the last 10 buffer events. This is what drives the admin dashboard's live view — no polling REST endpoints for the dashboard itself, just one persistent socket doing a fresh DB read per tick.

## DevOps / Deployment

### Local (`docker-compose.yml`)
One compose file, 7 services, named containers, health-checked dependency ordering (`origin` waits on Postgres+Redis health checks; CDN nodes wait on origin's `/health`). Each CDN node gets its own named volume for cache persistence (`cdn1_cache`, `cdn2_cache`, `cdn3_cache`) plus a shared read-only mount of `video_data` for local-storage fallback.

### Production topology (`docker-compose.prod.yml`, `docker-compose.cdn.yml`, `.github/workflows/deploy.yml`)
This isn't simulated on one box in prod — it's **actually distributed** across separate DigitalOcean droplets:

- One droplet runs origin + Postgres + Redis + frontend (`docker-compose.prod.yml`).
- Three separate droplets, one per region (Bangalore, San Francisco, Frankfurt), each run a single CDN node via `docker-compose.cdn.yml`.

CI/CD is a GitHub Actions workflow (`deploy.yml`) triggered on push to `main`:
- `deploy-origin` runs first — SSHes into the origin droplet, pulls latest, brings up the stack, waits for Postgres readiness, and conditionally seeds the DB only if `series` is empty (idempotent — safe to redeploy without wiping data).
- `deploy-cdn1` / `deploy-cdn2` / `deploy-cdn3` run in parallel afterward (`needs: deploy-origin`), each SSHing into its own droplet with its own secrets (`CDN1_HOST`/`CDN2_HOST`/`CDN3_HOST` + keys) and its own `.env.cdn` file.
- Because origin and each CDN node are genuinely different machines with real network latency between them, `NODE_PUBLIC_URL` lets a CDN node register a browser-reachable address instead of a docker-internal hostname, and `PUBLIC_URL` on origin routes browser traffic through an nginx reverse-proxy path (`/cdn1`, `/cdn2`, `/cdn3`) to avoid mixed-content errors when the origin is HTTPS but edge nodes are plain HTTP.

### Storage
Dev/local uses volume-mounted disk for video; production uses S3 (`VIDEO_STORAGE_BACKEND=s3`), decoupling durable origin storage from the throwaway, per-node edge caches which live only on each CDN droplet's local disk volume.

## What Makes the CDN Simulation "Real"

Worth calling out explicitly since it'd be easy to fake this: nodes are independent OS processes (in prod, independent machines) that register themselves, report real cache hit/miss counts from real disk I/O, and get selected/failed-over by an origin that only trusts heartbeats younger than 15–20 seconds. Killing a node's container measurably changes routing behavior within one heartbeat interval — this isn't a lookup table pretending to be a CDN.
