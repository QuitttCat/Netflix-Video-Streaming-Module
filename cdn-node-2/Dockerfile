# CDN Edge Node 2 — Chittagong
FROM python:3.11-slim

ENV NODE_ID=cdn-node-2
ENV NODE_NAME=edge-chittagong
ENV NODE_LOCATION=chittagong
ENV NODE_PORT=3002
ENV CACHE_PATH=/cache

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

EXPOSE 3002

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${NODE_PORT}"]
