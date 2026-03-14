#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example. Fill AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and S3_BUCKET_NAME, then re-run this script."
  exit 1
fi

required=(AWS_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY S3_BUCKET_NAME)
missing=()
for key in "${required[@]}"; do
  value="$(grep -E "^${key}=" .env | tail -n 1 | cut -d'=' -f2- || true)"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  if [[ -z "${value// }" ]]; then
    missing+=("$key")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing required .env values: ${missing[*]}"
  echo "These are required because seeded videos use S3 storage paths."
  exit 1
fi

if [[ "${1:-}" != "--skip-volume-reset" ]]; then
  docker compose down -v
fi

docker compose up -d --build

echo "Application is up: http://localhost"
echo "Tip: pass --skip-volume-reset to keep existing local DB/volumes."
