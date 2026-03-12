# CDN Edge Node 3 — Sylhet
FROM python:3.11-slim

ENV NODE_ID=cdn-node-3
ENV NODE_NAME=edge-sylhet
ENV NODE_LOCATION=sylhet
ENV NODE_PORT=3003
ENV CACHE_PATH=/cache

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

EXPOSE 3003

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${NODE_PORT}"]
