FROM python:3.11-slim

# InsightFace needs these at runtime; the slim image ships none of them.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libglib2.0-0 libgl1 libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Warm the model into the image so the first request isn't a 40s download.
RUN python -c "from insightface.app import FaceAnalysis; \
    a=FaceAnalysis(name='buffalo_l'); a.prepare(ctx_id=-1, det_size=(640,640))" || true

COPY app ./app
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD curl -fsS http://localhost:8001/health || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "2"]
