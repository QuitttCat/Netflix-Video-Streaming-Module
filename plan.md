# Trailer Preview + Admin CDN Visualization Plan

## Scope Lock
- Do not modify existing implemented features beyond targeted trailer and admin visualization additions.
- No inline code comments in new or edited code.
- Implement minimal, focused changes.
- Execute this plan only after manual approval.

## Inputs Confirmed
- Trailer behavior rules from `preview_trailer.txt` will be used as the source of truth for hover-state preview flow.
- Existing data model and bootstrap pattern from `init.sql` and `seed_data.sql` will be extended for trailer automation similar to current video seeding behavior.
- Current stack: FastAPI origin, React frontend, PostgreSQL, Redis, CDN nodes, Docker Compose.

## Milestone 1: Discovery and Metadata Confirmation
1. Query PostgreSQL for series metadata of `Milky Subway: The Galactic Limited Express` and capture:
   - `series.id`, `title`, `content_type`, `logo_url`, `poster_url`, `backdrop_url`, and related season/episode rows.
2. Trace existing DB relationships between `series`, `seasons`, `episodes`, `videos`, and media paths.
3. Confirm how S3 paths are currently modeled and returned by APIs.
4. Present exact DB keys/rows back for your reconfirmation before data linking.

## Milestone 2: Infrastructure Update
1. Add pgAdmin service to `docker-compose.yml` with persistent volume, default credentials via env vars, and exposed host port.
2. Ensure pgAdmin can connect to `postgres` service container network name.
3. Keep all existing services untouched unless required for compatibility.

## Milestone 3: Backend Data Model for Trailers
1. Add robust trailer linkage that supports current and future content:
   - Preferred: new `series_trailers` table with nullable `series_id`, S3 key/path, metadata fields, and active/default flags.
   - Include indexes and uniqueness constraints needed for deterministic trailer selection.
2. Update `init.sql` to create trailer table and constraints.
3. Update seed strategy so trailer linkage can bootstrap automatically for fresh clones.
4. Add ORM model(s), schema(s), and API payload support in origin backend.

## Milestone 4: Trailer Storage + Upload APIs
1. Add backend endpoints to support:
   - Admin trailer upload to S3.
   - Trailer metadata create/update/link to series.
   - Fetch trailer metadata for catalog cards.
2. Reuse existing S3 service patterns for consistent key generation and presign/upload behavior.
3. Add server-side validation for file type, size guardrails, and link target existence.
4. Return normalized trailer URL payloads for frontend preview player.

## Milestone 5: Admin Content UI Enhancements
1. Add a new trailer management section in admin content mode:
   - Select series.
   - Upload trailer file.
   - Save/replace active trailer mapping.
   - Display current linked trailer metadata and status.
2. Keep current episode/video upload flows unchanged.
3. Provide clear success/error states and refresh behavior after updates.

## Milestone 6: User Preview Player and Hover State Machine
1. Implement hover-triggered trailer preview using the specified state machine from `preview_trailer.txt`:
   - Idle -> Hovering -> TrailerIdLookup -> TrailerLoadRequested -> CacheDecision.
   - Cache hit path to muted loop playback.
   - Cache miss path via CDN request then origin fallback.
   - Cancellation on hover end.
   - Transition to full playback on play action.
2. Add trailer preview container/player on series cards without disrupting existing playback page.
3. Enforce muted-loop preview behavior and clean teardown on unhover/navigation.
4. Ensure robust behavior for no-trailer cases.

## Milestone 7: Seed and Bootstrap Automation for Teammates
1. Extend DB bootstrap to include trailer linkage records for fresh `docker compose down -v && up` runs.
2. Add deterministic seed SQL for trailer metadata tied to the Milky Subway series key.
3. Document required env and bootstrap expectations in existing docs.
4. Verify clone-and-run path reproduces trailer linkage without manual DB edits.

## Milestone 8: CDN Visual Stats in Admin Dashboard
1. Add visual components for CDN metrics:
   - Latency trend view.
   - Load distribution view.
   - Cache hit ratio visualization.
2. Use existing monitor/CDN endpoints and websocket feed where possible.
3. Keep layout/style consistent with existing admin dashboard theme.

## Milestone 9: End-to-End Validation Loop
1. Backend validation:
   - Health checks.
   - Trailer upload API tests.
   - Trailer fetch/link tests.
   - Existing playback/buffering/prefetch smoke checks.
2. Frontend validation:
   - Admin trailer upload/link flow.
   - User hover preview state transitions.
   - Play-click transition to full player.
   - CDN chart rendering with live data.
3. Data validation:
   - Confirm trailer rows and foreign keys in DB.
   - Confirm S3 object exists and path correctness.
4. Regression checks:
   - Existing login, catalog browsing, episode playback, and admin existing tools still work.
5. Repeat fix-test loop until all scoped checks pass.

## Planned File Touch List
- `docker-compose.yml`
- `init.sql`
- `seed_data.sql`
- `origin/app/models.py`
- `origin/app/schemas.py`
- `origin/app/routers/catalog.py`
- `origin/app/routers/media_storage.py`
- `origin/app/main.py`
- `frontend/src/components/AdminDashboard.jsx`
- `frontend/src/components/CatalogHome.jsx`
- `frontend/src/components/VideoPlayer.jsx` only if transition hook extension is strictly needed
- `README.md` for teammate bootstrap/update notes

## Execution Order
1. Metadata confirmation query output to user.
2. Compose + DB schema updates.
3. Backend trailer APIs.
4. Admin UI trailer management.
5. User hover preview integration.
6. CDN charts.
7. Seed automation and docs.
8. Full validation loop.

## Deliverables
- Working trailer upload-to-S3 flow linked to Milky Subway series.
- Automatic trailer linkage on fresh clone bootstrap.
- User hover trailer preview following provided state machine behavior.
- Enhanced admin dashboard with CDN visual metrics.
- Verified no breakage of existing core features.
