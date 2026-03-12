#!/bin/bash
# encode_video.sh — Encode a raw video into DASH segments at 4 quality levels.
# Usage: ./scripts/encode_video.sh <video_id> [input_file]
#
# Example (inside the origin container):
#   docker exec netflix_origin bash /app/scripts/encode_video.sh 1 /videos/1/raw.mp4
#
# Requires: ffmpeg

set -e

VIDEO_ID="${1:?Usage: encode_video.sh <video_id> [input_file]}"
INPUT="${2:-/videos/${VIDEO_ID}/raw.mp4}"
OUTPUT_DIR="/videos/${VIDEO_ID}"

if [ ! -f "$INPUT" ]; then
  echo "ERROR: Input file not found: $INPUT"
  exit 1
fi

echo "Encoding video_id=${VIDEO_ID} from ${INPUT} ..."
mkdir -p "$OUTPUT_DIR"

ffmpeg -y -i "$INPUT" \
  -filter_complex \
    "[0:v]split=4[v1][v2][v3][v4]; \
     [v1]scale=640:360[v360]; \
     [v2]scale=854:480[v480]; \
     [v3]scale=1280:720[v720]; \
     [v4]scale=1920:1080[v1080]" \
  -map "[v360]"  -b:v:0 400k  -maxrate:v:0 428k  -bufsize:v:0 600k \
  -map "[v480]"  -b:v:1 800k  -maxrate:v:1 856k  -bufsize:v:1 1200k \
  -map "[v720]"  -b:v:2 1500k -maxrate:v:2 1605k -bufsize:v:2 2250k \
  -map "[v1080]" -b:v:3 3000k -maxrate:v:3 3210k -bufsize:v:3 4500k \
  -map 0:a \
  -c:v libx264 -preset fast -g 48 -keyint_min 48 -sc_threshold 0 \
  -c:a aac -b:a 128k -ac 2 \
  -use_timeline 1 -use_template 1 -seg_duration 4 \
  -adaptation_sets "id=0,streams=v id=1,streams=a" \
  -f dash "${OUTPUT_DIR}/manifest.mpd"

echo "Done. Manifest: ${OUTPUT_DIR}/manifest.mpd"

# Count segments and print summary
TOTAL=$(find "$OUTPUT_DIR" -name "*.m4s" | wc -l)
echo "Total segments: ${TOTAL}"
echo ""
echo "Update the database with segment count:"
echo "  docker exec netflix_postgres psql -U netflix -d netflix_streaming \\"
echo "    -c \"UPDATE videos SET total_segments=${TOTAL}, duration_seconds=\$(ffprobe -v error -show_entries format=duration -of csv=p=0 ${INPUT} | cut -d. -f1) WHERE id=${VIDEO_ID};\""
