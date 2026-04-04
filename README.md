# Netflix Video Streaming Module

CSE 326 - Information System Design | Group 1

Intelligent Buffering & Preloading with CDN Simulation.

## Teammate Quick Start (Clone -> Run -> See Everything)

### 1) Clone

```bash
git clone https://github.com/QuitttCat/Netflix-Video-Streaming-Module.git
cd Netflix-Video-Streaming-Module
```

### 2) Provide shared `.env` values (required for seeded uploaded media)


Copy the template and fill values:

```bash
cp .env.example .env
```

Required keys in `.env`:

- `AWS_REGION`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `S3_BUCKET_NAME`

Why this is required:

- The seeded DB includes uploaded videos/audio/subtitles whose `storage_path` is `s3://...`.
- Without the shared S3 credentials/bucket access, metadata will be visible but media files will not play.

### 3) One-command bootstrap

On Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\team_bootstrap.ps1
```

On macOS/Linux:

```bash
bash ./scripts/team_bootstrap.sh
```

This does:

- `docker compose down -v` (fresh DB volume so `seed_data.sql` is applied)
- `docker compose up --build -d`

Then open **http://localhost**.

### 4) What teammates will see after quick start

- Seeded users, videos, series, seasons, episodes, media tracks (audio/subtitle metadata)
- Existing uploaded episodes (including Milky Subway)
- Multi-audio selection and subtitle selection in player
- Subtitle rendering, buffering metrics, and prefetch flow

Note:

- If they want to keep existing local DB data and skip wiping volumes, use:
  - PowerShell: `-SkipVolumeReset`
  - Bash: `--skip-volume-reset`

## How to Run

Make sure Docker is installed, then:

```bash
cd Netflix-Video-Streaming-Module
docker compose up --build -d
```

This starts 7 services: PostgreSQL, Redis, Origin Server (FastAPI), 3 CDN Edge Nodes, and a React Frontend.

Open **http://localhost** in your browser.

pgAdmin is available at **http://localhost:5050**.

Default login values:

- `PGADMIN_DEFAULT_EMAIL` from `.env` (default `admin@netflix.com`)
- `PGADMIN_DEFAULT_PASSWORD` from `.env` (default `admin123`)

## Team Seed Snapshot (No Manual Reseed Needed)

This repo now includes `seed_data.sql` generated from a real working database (series, seasons, episodes, tracks, users, videos).

To apply that snapshot on another machine, your friend should initialize Postgres from scratch once:

```bash
docker compose down -v
docker compose up --build -d
```

Important notes:

- `seed_data.sql` is executed by `init.sql` during first database initialization.
- Docker init scripts run only on a fresh Postgres volume. If data already exists, the seed will not re-run.
- Metadata is fully seeded, but actual playable media still depends on where `videos.storage_path` points:
  - local paths like `/videos/...` require local media files in the volume,
  - `s3://...` paths require valid AWS credentials + bucket access.

## Seed 100 Popular Movies (TMDB)

Set your TMDB API key in your shell, restart origin, then run the seed script:

```bash
export TMDB_API_KEY=your_tmdb_api_key
docker compose up -d --build origin

# import top 100 popular movies into series/seasons/episodes/media_tracks
docker exec netflix_origin python -m app.scripts.seed_tmdb_movies --limit 100

# import movies + popular TV series (recommended)
docker exec netflix_origin python -m app.scripts.seed_tmdb_movies \
  --limit 100 \
  --series-limit 40 \
  --max-seasons-per-series 2 \
  --max-episodes-per-season 10
```

Optional (clear old movie rows first):

```bash
docker exec netflix_origin python -m app.scripts.seed_tmdb_movies --limit 100 --reset-movies

# optional: also reset old imported series rows before re-import
docker exec netflix_origin python -m app.scripts.seed_tmdb_movies \
  --limit 100 --series-limit 40 --reset-movies --reset-series
```

### One-click from Admin Dashboard

Login as admin and open Dashboard. In **Episode Asset Manager**, click **Seed Catalog**.

That one click starts a background seed job (movies + series + episodes) and shows live status/result.

## How We Tested Video Streaming

We grabbed a sample video (Big Buck Bunny, Creative Commons) and loaded it into the system:

```bash
# download a sample video into the origin container
docker exec netflix_origin curl -L -o /videos/1/raw.mp4 \
  'https://sample-videos.com/video321/mp4/720/big_buck_bunny_720p_5mb.mp4'

# encode it into DASH segments (multiple quality levels + audio, 4 sec chunks)
docker exec netflix_origin ffmpeg -y -i /videos/1/raw.mp4 \
  -filter_complex "[0:v]split=2[v1][v2]; [v1]scale=320:180[v180]; [v2]scale=640:360[v360]" \
  -map "[v180]" -b:v:0 200k -maxrate:v:0 250k -bufsize:v:0 400k \
  -map "[v360]" -b:v:1 400k -maxrate:v:1 500k -bufsize:v:1 800k \
  -map 0:a -c:v libx264 -preset fast -g 48 -keyint_min 48 -sc_threshold 0 \
  -c:a aac -b:a 128k -ac 2 \
  -use_timeline 1 -use_template 1 -seg_duration 4 \
  -adaptation_sets "id=0,streams=v id=1,streams=a" \
  -f dash /videos/1/manifest.mpd

# update the DB with the actual video duration
docker exec netflix_postgres psql -U netflix -d netflix_streaming \
  -c "UPDATE videos SET duration_seconds=596, total_segments=150 WHERE id=1;"
```

Then we opened the app, clicked play, and the video started streaming through DASH. We checked the origin logs and could see the manifest and individual chunks being served one by one:

```
GET /api/videos/1/manifest.mpd              200 OK
GET /api/videos/1/init-stream0.m4s          200 OK
GET /api/videos/1/chunk-stream0-00001.m4s   200 OK
GET /api/videos/1/chunk-stream1-00001.m4s   200 OK
...
```

All 3 CDN nodes registered themselves and kept sending heartbeats every 5 seconds.

**CDN Region Selection**

When a playback session starts, the frontend detects the user's timezone using `Intl.DateTimeFormat().resolvedOptions().timeZone` and maps it to a region:

- Kolkata / Calcutta / Dhaka timezone → `bangalore`
- Frankfurt / Berlin / any Europe timezone → `frankfurt`
- America timezones → `san-francisco`

Before actually using that region, the frontend first calls `/api/cdn/stats` to check if that region's node has sent a heartbeat in the last 20 seconds. If it's healthy, the request goes to that node. If it's down or stale, the frontend picks the healthiest available node instead (sorted by latency). This means changing your timezone in browser devtools will always affect which node you get routed to, but you won't get sent to a dead node.

This region is then passed to `/api/playback/start?videoId=X&clientRegion=Y`. The backend scores all active nodes -- nodes in the matching region get a 0 penalty, others get +100 -- and picks the best one by latency and load.

**CDN Failover Mid-Session**

While a video is playing, the frontend checks CDN health every 15 seconds by polling `/api/cdn/stats`. If the current node's last heartbeat is older than 20 seconds, it's considered dead. The frontend then looks for any other node with a fresh heartbeat, picks the one with the lowest latency, and switches the player to the new node's manifest URL.

When a switch happens, a green banner shows at the top of the player ("CDN failover: edge-bangalore → edge-frankfurt") for 5 seconds.

The failover only triggers if the current node is actually dead. It won't switch just because another node has slightly better latency -- that would cause unnecessary interruptions during a session.

One problem we ran into was that since everything runs on localhost, the bandwidth between services is essentially infinite. That means dash.js fills its buffer to the max almost instantly, so the BBA algorithm never gets a chance to adapt -- the buffer just sits at 60 seconds and quality stays locked at 1080p. To fix this, we added a network simulator on the frontend that runs a simulated buffer alongside the real player. Every 500ms, the simulated buffer gains `(networkCap / currentQualityBitrate) × 0.5` seconds and loses `0.5` seconds to playback. So if the simulated network speed can't keep up with the current quality's bitrate, the buffer drains and BBA kicks in to drop quality -- exactly like it would on a real network.

The network simulator buttons don't actually throttle the network -- the real video still streams at full localhost speed. What they do is change the `capKbps` value that the simulated buffer uses in its math. So when you click "Poor (200 kbps)", the simulation models what would happen at that bandwidth, and the BBA display reacts accordingly -- buffer draining, quality dropping, zone changes -- even though the actual video plays fine. It's a visualization tool for demoing the algorithm, not real bandwidth throttling. In a real deployment, you wouldn't need these buttons because actual network conditions would drive the real dash.js buffer naturally.

We used the network simulator buttons in the player to switch between Good (3 Mbps), Medium (800 kbps), Poor (200 kbps), and Offline. When we dropped to "Poor", the buffer drained from green (upper reservoir) down through orange (cushion) to red (reservoir), and the quality dropped from 1080p to 360p. When we switched back to "Good", the buffer filled back up and quality climbed back. Audio priority kicked in whenever the buffer went below 5 seconds.

The admin dashboard showed all of this live through a WebSocket connection -- active sessions, CDN node health with latency and cache hit ratios, and a feed of buffer events with zone coloring.

When the playhead hit 90% of the episode, the next-episode prefetch triggered and a green banner showed up saying it was preloading Episode 2's first 5 segments.

We also checked the database directly and confirmed 5 playback sessions and 63+ buffer events were recorded with zone and quality data.

Everything worked as planned.

## Trailer Preview (Milky Subway)

This project now supports series trailer linkage with CDN-cached preview playback.

- DB table: `series_trailers`
- Public trailer metadata: `GET /api/catalog/series/{series_id}/trailer`
- Public trailer stream: `GET /api/catalog/series/{series_id}/trailer/stream.mp4`
- CDN trailer stream: `GET http://localhost:3001/trailers/{series_id}/stream.mp4` (and same on ports 3002/3003)

Admin upload/link endpoints:

- `POST /api/catalog/admin/series/{series_id}/trailer`
- `DELETE /api/catalog/admin/series/{series_id}/trailer`

In UI:

- Admin -> Content -> open a series modal -> upload trailer file and link it.
- Home catalog series cards now start muted trailer previews after 2 seconds hover.
- First trailer request is CDN cache miss, repeated requests become cache hits.

## Stopping

```bash
docker compose down        # stop everything
docker compose down -v     # also wipe volumes (DB data, cached segments)
```
