#!/bin/bash
# Production deploy script — run on your EC2 server
set -e

echo "==> Pulling latest code..."
git pull origin main

echo "==> Checking .env.prod exists..."
if [ ! -f .env.prod ]; then
  echo "ERROR: .env.prod not found. Copy .env.prod.example and fill in values."
  exit 1
fi

echo "==> Building and starting services..."
docker compose -f docker-compose.prod.yml --env-file .env.prod up --build -d

echo "==> Waiting for origin to be healthy..."
until docker exec netflix_origin curl -sf http://localhost:8000/health > /dev/null; do
  echo "  ...waiting"
  sleep 3
done

echo "==> All services up!"
docker compose -f docker-compose.prod.yml ps
