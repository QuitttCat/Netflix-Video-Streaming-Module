import argparse
import os
import sys
from math import ceil

import httpx
import psycopg2

TMDB_BASE = "https://api.themoviedb.org/3"
IMG_W500 = "https://image.tmdb.org/t/p/w500"
IMG_W1280 = "https://image.tmdb.org/t/p/w1280"


def main():
    parser = argparse.ArgumentParser(description="Seed popular TMDB movies and TV series into local catalog tables")
    parser.add_argument("--limit", type=int, default=100, help="How many popular movies to import (default: 100)")
    parser.add_argument("--series-limit", type=int, default=40, help="How many popular TV series to import (default: 40)")
    parser.add_argument("--max-seasons-per-series", type=int, default=2, help="Max seasons imported per TV series (default: 2)")
    parser.add_argument("--max-episodes-per-season", type=int, default=10, help="Max episodes imported per season (default: 10)")
    parser.add_argument("--reset-movies", action="store_true", help="Delete existing movie-type catalog rows before import")
    parser.add_argument("--reset-series", action="store_true", help="Delete existing TMDB series-type catalog rows before import")
    args = parser.parse_args()

    api_key = os.getenv("TMDB_API_KEY")
    if not api_key:
        print("ERROR: TMDB_API_KEY is missing")
        sys.exit(1)

    db_url = os.getenv("DATABASE_URL", "postgresql://netflix:netflix123@postgres:5432/netflix_streaming")

    movie_genres = fetch_genres(api_key, "movie")
    tv_genres = fetch_genres(api_key, "tv")
    movies = fetch_popular_movies(api_key, args.limit)
    series_list = fetch_popular_series(api_key, args.series_limit)
    if not movies and not series_list:
        print("No movies or series fetched from TMDB")
        return

    conn = psycopg2.connect(db_url)
    conn.autocommit = False

    try:
        with conn.cursor() as cur:
            sync_sequences(cur)
            ensure_demo_video_exists(cur)
            remove_demo_catalog_rows(cur)

            if args.reset_movies:
                reset_movie_rows(cur)
            if args.reset_series:
                reset_series_rows(cur)

            movies_imported = 0
            movies_skipped = 0
            series_imported = 0
            episodes_imported = 0
            series_skipped = 0

            for rank, movie in enumerate(movies, start=1):
                tmdb_id = movie.get("id")
                if tmdb_id is None:
                    movies_skipped += 1
                    continue

                series_id = upsert_movie_as_series(cur, movie, movie_genres, rank)
                ensure_movie_episode_shell(cur, series_id, movie)
                movies_imported += 1

            for rank, tv in enumerate(series_list, start=1):
                tmdb_id = tv.get("id")
                if tmdb_id is None:
                    series_skipped += 1
                    continue
                try:
                    series_id = upsert_tv_as_series(cur, tv, tv_genres, rank)
                    added_eps = import_series_seasons_and_episodes(
                        cur,
                        api_key=api_key,
                        series_id=series_id,
                        tmdb_tv_id=tmdb_id,
                        max_seasons=args.max_seasons_per_series,
                        max_episodes_per_season=args.max_episodes_per_season,
                    )
                    episodes_imported += added_eps
                    series_imported += 1
                except Exception:
                    series_skipped += 1

            ensure_featured(cur)
            conn.commit()
            print(
                f"Movies imported/updated: {movies_imported}, skipped: {movies_skipped} | "
                f"Series imported/updated: {series_imported}, skipped: {series_skipped} | "
                f"Episodes imported/updated: {episodes_imported}"
            )
    except Exception as e:
        conn.rollback()
        raise
    finally:
        conn.close()


def fetch_genres(api_key: str, media: str) -> dict:
    with httpx.Client(timeout=30) as client:
        r = client.get(f"{TMDB_BASE}/genre/{media}/list", params={"api_key": api_key, "language": "en-US"})
        r.raise_for_status()
        payload = r.json()
        return {g["id"]: g["name"] for g in payload.get("genres", [])}


def fetch_popular_movies(api_key: str, limit: int) -> list:
    pages = max(1, ceil(limit / 20))
    out = []
    with httpx.Client(timeout=30) as client:
        for page in range(1, pages + 1):
            r = client.get(
                f"{TMDB_BASE}/movie/popular",
                params={"api_key": api_key, "language": "en-US", "page": page},
            )
            r.raise_for_status()
            payload = r.json()
            out.extend(payload.get("results", []))
            if len(out) >= limit:
                break
    return out[:limit]


def fetch_popular_series(api_key: str, limit: int) -> list:
    pages = max(1, ceil(limit / 20))
    out = []
    with httpx.Client(timeout=30) as client:
        for page in range(1, pages + 1):
            r = client.get(
                f"{TMDB_BASE}/tv/popular",
                params={"api_key": api_key, "language": "en-US", "page": page},
            )
            r.raise_for_status()
            payload = r.json()
            out.extend(payload.get("results", []))
            if len(out) >= limit:
                break
    return out[:limit]


def ensure_demo_video_exists(cur):
    cur.execute("SELECT id FROM videos WHERE id = 1")
    row = cur.fetchone()
    if row:
        return

    cur.execute(
        """
        INSERT INTO videos (id, title, description, duration_seconds, total_segments, available_qualities, storage_path)
        VALUES (1, %s, %s, 900, 150, %s, '/videos/1')
        """,
        (
            "Demo Episode 1",
            "Autocreated demo video entry",
            ["360p", "480p", "720p", "1080p"],
        ),
    )


def sync_sequences(cur):
    tables = ["series", "seasons", "episodes", "media_tracks", "videos"]
    for table in tables:
        cur.execute(
            """
            SELECT setval(
              pg_get_serial_sequence(%s, 'id'),
              COALESCE((SELECT MAX(id) FROM {}), 1),
              true
            )
            """.format(table),
            (table,),
        )


def reset_movie_rows(cur):
    cur.execute(
        """
        DELETE FROM media_tracks
        WHERE episode_id IN (
            SELECT e.id
            FROM episodes e
            JOIN series s ON s.id = e.series_id
            WHERE s.content_type = 'movie'
        )
        """
    )
    cur.execute(
        """
        DELETE FROM episodes
        WHERE series_id IN (
            SELECT id FROM series WHERE content_type = 'movie'
        )
        """
    )
    cur.execute(
        """
        DELETE FROM seasons
        WHERE series_id IN (
            SELECT id FROM series WHERE content_type = 'movie'
        )
        """
    )
    cur.execute("DELETE FROM series WHERE content_type = 'movie'")


def reset_series_rows(cur):
    cur.execute(
        """
        DELETE FROM media_tracks
        WHERE episode_id IN (
            SELECT e.id
            FROM episodes e
            JOIN series s ON s.id = e.series_id
            WHERE s.content_type = 'series' AND s.tmdb_id IS NOT NULL
        )
        """
    )
    cur.execute(
        """
        DELETE FROM episodes
        WHERE series_id IN (
            SELECT id FROM series WHERE content_type = 'series' AND tmdb_id IS NOT NULL
        )
        """
    )
    cur.execute(
        """
        DELETE FROM seasons
        WHERE series_id IN (
            SELECT id FROM series WHERE content_type = 'series' AND tmdb_id IS NOT NULL
        )
        """
    )
    cur.execute("DELETE FROM series WHERE content_type = 'series' AND tmdb_id IS NOT NULL")


def upsert_movie_as_series(cur, movie: dict, genre_map: dict, rank: int) -> int:
    tmdb_id = movie["id"]
    title = movie.get("title") or movie.get("original_title") or f"TMDB #{tmdb_id}"
    synopsis = movie.get("overview") or ""
    year = parse_year(movie.get("release_date"))
    maturity = "R" if movie.get("adult") else "PG-13"
    genre_names = [genre_map[g] for g in movie.get("genre_ids", []) if g in genre_map]

    poster_path = movie.get("poster_path")
    backdrop_path = movie.get("backdrop_path")
    poster_url = f"{IMG_W500}{poster_path}" if poster_path else None
    backdrop_url = f"{IMG_W1280}{backdrop_path}" if backdrop_path else None

    popularity = float(movie.get("popularity") or 0.0)
    if popularity <= 0:
        popularity = max(1.0, 1000 - rank)

    cur.execute(
        """
        SELECT id FROM series
        WHERE tmdb_id = %s AND content_type = 'movie'
        """,
        (tmdb_id,),
    )
    existing = cur.fetchone()

    if existing:
        series_id = existing[0]
        cur.execute(
            """
            UPDATE series
            SET title=%s,
                synopsis=%s,
                year=%s,
                maturity=%s,
                genres=%s,
                poster_url=%s,
                backdrop_url=%s,
                popularity=%s
            WHERE id=%s
            """,
            (title, synopsis, year, maturity, genre_names, poster_url, backdrop_url, popularity, series_id),
        )
        return series_id

    cur.execute(
        """
        INSERT INTO series (tmdb_id, title, synopsis, content_type, year, maturity, genres, poster_url, backdrop_url, popularity, featured)
        VALUES (%s, %s, %s, 'movie', %s, %s, %s, %s, %s, %s, FALSE)
        RETURNING id
        """,
        (tmdb_id, title, synopsis, year, maturity, genre_names, poster_url, backdrop_url, popularity),
    )
    return cur.fetchone()[0]


def upsert_tv_as_series(cur, tv: dict, genre_map: dict, rank: int) -> int:
    tmdb_id = tv["id"]
    title = tv.get("name") or tv.get("original_name") or f"TMDB TV #{tmdb_id}"
    synopsis = tv.get("overview") or ""
    year = parse_year(tv.get("first_air_date"))
    maturity = "TV-14"
    genre_names = [genre_map[g] for g in tv.get("genre_ids", []) if g in genre_map]

    poster_path = tv.get("poster_path")
    backdrop_path = tv.get("backdrop_path")
    poster_url = f"{IMG_W500}{poster_path}" if poster_path else None
    backdrop_url = f"{IMG_W1280}{backdrop_path}" if backdrop_path else None

    popularity = float(tv.get("popularity") or 0.0)
    if popularity <= 0:
        popularity = max(1.0, 1000 - rank)

    cur.execute(
        """
        SELECT id FROM series
        WHERE tmdb_id = %s AND content_type = 'series'
        """,
        (tmdb_id,),
    )
    existing = cur.fetchone()

    if existing:
        series_id = existing[0]
        cur.execute(
            """
            UPDATE series
            SET title=%s,
                synopsis=%s,
                year=%s,
                maturity=%s,
                genres=%s,
                poster_url=%s,
                backdrop_url=%s,
                popularity=%s
            WHERE id=%s
            """,
            (title, synopsis, year, maturity, genre_names, poster_url, backdrop_url, popularity, series_id),
        )
        return series_id

    cur.execute(
        """
        INSERT INTO series (tmdb_id, title, synopsis, content_type, year, maturity, genres, poster_url, backdrop_url, popularity, featured)
        VALUES (%s, %s, %s, 'series', %s, %s, %s, %s, %s, %s, FALSE)
        RETURNING id
        """,
        (tmdb_id, title, synopsis, year, maturity, genre_names, poster_url, backdrop_url, popularity),
    )
    return cur.fetchone()[0]


def import_series_seasons_and_episodes(cur, api_key: str, series_id: int, tmdb_tv_id: int, max_seasons: int, max_episodes_per_season: int) -> int:
    details = fetch_tv_details(api_key, tmdb_tv_id)
    seasons = [s for s in details.get("seasons", []) if (s.get("season_number") or 0) > 0]
    seasons = seasons[:max_seasons]
    updated_episode_count = 0

    for s in seasons:
        season_number = s.get("season_number")
        if season_number is None:
            continue
        season_title = s.get("name") or f"Season {season_number}"

        cur.execute(
            "SELECT id FROM seasons WHERE series_id = %s AND season_number = %s",
            (series_id, season_number),
        )
        row = cur.fetchone()
        if row:
            season_id = row[0]
            cur.execute("UPDATE seasons SET title = %s WHERE id = %s", (season_title, season_id))
        else:
            cur.execute(
                "INSERT INTO seasons (series_id, season_number, title) VALUES (%s, %s, %s) RETURNING id",
                (series_id, season_number, season_title),
            )
            season_id = cur.fetchone()[0]

        season_payload = fetch_tv_season(api_key, tmdb_tv_id, season_number)
        episodes = (season_payload.get("episodes") or [])[:max_episodes_per_season]
        for ep in episodes:
            ep_num = ep.get("episode_number")
            if ep_num is None:
                continue
            ep_title = ep.get("name") or f"Episode {ep_num}"
            ep_synopsis = ep.get("overview") or ""
            runtime = ep.get("runtime")
            duration_sec = int(runtime * 60) if runtime else 2700

            cur.execute(
                """
                SELECT id FROM episodes
                WHERE series_id = %s AND season_id = %s AND episode_number = %s
                """,
                (series_id, season_id, ep_num),
            )
            ep_row = cur.fetchone()
            if ep_row:
                episode_id = ep_row[0]
                cur.execute(
                    """
                    UPDATE episodes
                    SET title = %s,
                        synopsis = %s,
                        duration_sec = %s,
                        demo_fallback_video_id = COALESCE(demo_fallback_video_id, 1)
                    WHERE id = %s
                    """,
                    (ep_title, ep_synopsis, duration_sec, episode_id),
                )
            else:
                cur.execute(
                    """
                    INSERT INTO episodes (series_id, season_id, episode_number, title, synopsis, duration_sec, playable, demo_fallback_video_id)
                    VALUES (%s, %s, %s, %s, %s, %s, FALSE, 1)
                    RETURNING id
                    """,
                    (series_id, season_id, ep_num, ep_title, ep_synopsis, duration_sec),
                )
                episode_id = cur.fetchone()[0]

            ensure_default_tracks(cur, episode_id)
            updated_episode_count += 1

    return updated_episode_count


def fetch_tv_details(api_key: str, tv_id: int) -> dict:
    with httpx.Client(timeout=30) as client:
        r = client.get(f"{TMDB_BASE}/tv/{tv_id}", params={"api_key": api_key, "language": "en-US"})
        r.raise_for_status()
        return r.json()


def fetch_tv_season(api_key: str, tv_id: int, season_number: int) -> dict:
    with httpx.Client(timeout=30) as client:
        r = client.get(
            f"{TMDB_BASE}/tv/{tv_id}/season/{season_number}",
            params={"api_key": api_key, "language": "en-US"},
        )
        r.raise_for_status()
        return r.json()


def ensure_movie_episode_shell(cur, series_id: int, movie: dict):
    title = movie.get("title") or "Movie"
    duration_sec = int((movie.get("runtime") or 0) * 60)
    if duration_sec <= 0:
        duration_sec = 7200

    cur.execute(
        "SELECT id FROM seasons WHERE series_id = %s AND season_number = 1",
        (series_id,),
    )
    row = cur.fetchone()
    if row:
        season_id = row[0]
    else:
        cur.execute(
            "INSERT INTO seasons (series_id, season_number, title) VALUES (%s, 1, 'Movie') RETURNING id",
            (series_id,),
        )
        season_id = cur.fetchone()[0]

    cur.execute(
        "SELECT id FROM episodes WHERE series_id = %s AND season_id = %s AND episode_number = 1",
        (series_id, season_id),
    )
    ep = cur.fetchone()

    if ep:
        episode_id = ep[0]
        cur.execute(
            """
            UPDATE episodes
            SET title = %s,
                synopsis = %s,
                duration_sec = %s,
                demo_fallback_video_id = COALESCE(demo_fallback_video_id, 1)
            WHERE id = %s
            """,
            (title, movie.get("overview") or "", duration_sec, episode_id),
        )
    else:
        cur.execute(
            """
            INSERT INTO episodes (series_id, season_id, episode_number, title, synopsis, duration_sec, playable, demo_fallback_video_id)
            VALUES (%s, %s, 1, %s, %s, %s, FALSE, 1)
            RETURNING id
            """,
            (series_id, season_id, title, movie.get("overview") or "", duration_sec),
        )
        episode_id = cur.fetchone()[0]

    ensure_default_tracks(cur, episode_id)


def ensure_default_tracks(cur, episode_id: int):
    cur.execute(
        "SELECT id FROM media_tracks WHERE episode_id = %s AND track_type='audio' AND language='en'",
        (episode_id,),
    )
    if not cur.fetchone():
        cur.execute(
            "INSERT INTO media_tracks (episode_id, track_type, language, label, codec, is_default) VALUES (%s, 'audio', 'en', 'English', 'aac', TRUE)",
            (episode_id,),
        )

    cur.execute(
        "SELECT id FROM media_tracks WHERE episode_id = %s AND track_type='subtitle' AND language='en'",
        (episode_id,),
    )
    if not cur.fetchone():
        cur.execute(
            "INSERT INTO media_tracks (episode_id, track_type, language, label, codec, is_default) VALUES (%s, 'subtitle', 'en', 'English', 'webvtt', TRUE)",
            (episode_id,),
        )


def ensure_featured(cur):
    # Recompute featured banner every seed run so demo placeholders never stick.
    cur.execute("UPDATE series SET featured = FALSE")
    cur.execute(
        """
        SELECT id
        FROM series
        WHERE title <> 'Demo Series'
        ORDER BY popularity DESC, id ASC
        LIMIT 1
        """
    )
    row = cur.fetchone()
    if row:
        cur.execute("UPDATE series SET featured = TRUE WHERE id = %s", (row[0],))


def remove_demo_catalog_rows(cur):
    cur.execute("SELECT id FROM series WHERE title = 'Demo Series'")
    rows = cur.fetchall()
    if not rows:
        return
    demo_ids = [r[0] for r in rows]

    cur.execute(
        """
        DELETE FROM media_tracks
        WHERE episode_id IN (
            SELECT id FROM episodes WHERE series_id = ANY(%s)
        )
        """,
        (demo_ids,),
    )
    cur.execute("DELETE FROM episodes WHERE series_id = ANY(%s)", (demo_ids,))
    cur.execute("DELETE FROM seasons WHERE series_id = ANY(%s)", (demo_ids,))
    cur.execute("DELETE FROM series WHERE id = ANY(%s)", (demo_ids,))


def parse_year(date_text):
    if not date_text or len(date_text) < 4:
        return None
    try:
        return int(date_text[:4])
    except ValueError:
        return None


if __name__ == "__main__":
    main()
