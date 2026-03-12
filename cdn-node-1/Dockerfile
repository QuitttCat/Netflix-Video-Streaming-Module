# CDN Edge Node 1 — Dhaka
FROM python:3.11-slim

ENV NODE_ID=cdn-node-1
ENV NODE_NAME=edge-dhaka
ENV NODE_LOCATION=dhaka
ENV NODE_PORT=3001
ENV CACHE_PATH=/cache

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

EXPOSE 3001

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${NODE_PORT}"]
