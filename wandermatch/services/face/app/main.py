"""
Face Grouping Service.

A plain request/response job, deliberately off the realtime path (design
doc §5: "never touches the realtime path at all"). The API service calls
it, stores the result, and broadcasts — this service holds no session
state and knows nothing about WebSockets.

Consent is enforced by the CALLER, before this is ever invoked. This
service will happily embed any image handed to it, which is precisely why
the API must not hand it one without a consent row. That boundary is
documented in routes/photos.js.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Optional

import numpy as np
from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel, Field

from .detector import FaceEngine
from .cluster import (
    FaceRecord,
    cluster_faces,
    assign_incremental,
    update_centroid,
    evaluate_clustering,
    COSINE_DISTANCE_THRESHOLD,
)
from .store import EmbeddingStore

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("face.api")

SERVICE_TOKEN = os.getenv("FACE_SERVICE_TOKEN", "")

app = FastAPI(title="WanderMatch Face Grouping", version="1.0.0")
store = EmbeddingStore()


def _auth(token: Optional[str]) -> None:
    """
    Shared-secret auth. This service must never be internet-reachable —
    it takes raw photos and returns biometric vectors. In deployment it
    sits on the private network; the token is defence in depth, not the
    primary control.
    """
    if not SERVICE_TOKEN:
        return
    if token != SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="bad service token")


class DetectRequest(BaseModel):
    trip_id: str
    photo_id: str
    image_base64: Optional[str] = None
    image_url: Optional[str] = None


class ClusterRequest(BaseModel):
    trip_id: str
    threshold: float = Field(default=COSINE_DISTANCE_THRESHOLD, ge=0.1, le=0.9)


class DeleteRequest(BaseModel):
    trip_id: str


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model_loaded": FaceEngine._instance is not None}


@app.post("/v1/photos/analyse")
def analyse(req: DetectRequest, x_service_token: str = Header(default="")) -> dict:
    """
    Detect + embed one photo, then incrementally assign each face to this
    trip's existing clusters.

    Incremental rather than full re-cluster per upload: a 200-photo trip
    would otherwise re-run O(n^2) clustering on every single upload, and
    the user would watch their collage reshuffle after each one.
    """
    _auth(x_service_token)
    started = time.time()

    if not req.image_base64 and not req.image_url:
        raise HTTPException(status_code=422, detail="image_base64 or image_url required")

    try:
        data = store.fetch_image(base64_data=req.image_base64, url=req.image_url)
    except Exception as exc:
        log.exception("image fetch failed")
        raise HTTPException(status_code=400, detail=f"could not read image: {exc}") from exc

    engine = FaceEngine.instance()
    try:
        faces, meta = engine.detect(data)
    except Exception as exc:
        log.exception("detection failed")
        raise HTTPException(status_code=500, detail=f"detection failed: {exc}") from exc

    index = store.load_index(req.trip_id)
    assignments = []

    for i, face in enumerate(faces):
        face_id = f"{req.photo_id}:{i}"
        record = FaceRecord(
            face_id=face_id,
            photo_id=req.photo_id,
            embedding=face.embedding,
            bbox={"x": face.bbox[0], "y": face.bbox[1], "w": face.bbox[2], "h": face.bbox[3]},
            det_score=face.det_score,
            reliable=face.reliable,
        )

        existing = [
            (cid, np.asarray(c["centroid"], dtype=np.float32), c["count"])
            for cid, c in index["clusters"].items()
        ]
        cluster_id, similarity = assign_incremental(record, existing)

        if cluster_id is None:
            cluster_id = f"fg_{req.trip_id}_{len(index['clusters'])}_{int(time.time()*1000)%100000}"
            index["clusters"][cluster_id] = {
                "centroid": record.embedding.tolist(),
                "count": 1,
                "faces": [face_id],
                "photos": [req.photo_id],
            }
            similarity = 1.0
            is_new = True
        else:
            c = index["clusters"][cluster_id]
            updated = update_centroid(
                np.asarray(c["centroid"], dtype=np.float32),
                c["count"],
                record.embedding,
                record.reliable,
            )
            c["centroid"] = updated.tolist()
            c["count"] += 1
            c["faces"].append(face_id)
            if req.photo_id not in c["photos"]:
                c["photos"].append(req.photo_id)
            is_new = False

        index["faces"][face_id] = {
            "photo_id": req.photo_id,
            "embedding": record.embedding.tolist(),
            "bbox": record.bbox,
            "det_score": record.det_score,
            "reliable": record.reliable,
            "cluster_id": cluster_id,
        }

        assignments.append({
            "face_id": face_id,
            "cluster_id": cluster_id,
            "is_new_cluster": is_new,
            "similarity": float(similarity),
            "bbox": record.bbox,
            "det_score": record.det_score,
            "reliable": record.reliable,
            "reasons": face.reasons,
        })

    store.save_index(req.trip_id, index)

    return {
        "trip_id": req.trip_id,
        "photo_id": req.photo_id,
        "faces_detected": len(faces),
        "assignments": assignments,
        "clusters_total": len(index["clusters"]),
        "meta": meta,
        "elapsed_ms": int((time.time() - started) * 1000),
    }


@app.post("/v1/trips/recluster")
def recluster(req: ClusterRequest, x_service_token: str = Header(default="")) -> dict:
    """
    Full re-cluster of a trip.

    Worth exposing separately because incremental assignment accumulates
    drift: after many uploads, two clusters may have converged on the same
    person. A periodic (or user-triggered "regroup") full pass fixes that,
    and returns quality metrics so the fix is verifiable rather than
    assumed.
    """
    _auth(x_service_token)
    started = time.time()

    index = store.load_index(req.trip_id)
    if not index["faces"]:
        return {"trip_id": req.trip_id, "clusters": [], "metrics": {"n_clusters": 0}}

    records = [
        FaceRecord(
            face_id=fid,
            photo_id=f["photo_id"],
            embedding=np.asarray(f["embedding"], dtype=np.float32),
            bbox=f["bbox"],
            det_score=f["det_score"],
            reliable=f.get("reliable", True),
        )
        for fid, f in index["faces"].items()
    ]

    clusters = cluster_faces(records, threshold=req.threshold)

    label_of = {}
    for label, c in enumerate(clusters):
        for fid in c.member_face_ids:
            label_of[fid] = label
    labels = np.array([label_of[r.face_id] for r in records])
    metrics = evaluate_clustering(records, labels)

    new_index = {"faces": {}, "clusters": {}}
    payload = []

    for i, c in enumerate(clusters):
        cid = f"fg_{req.trip_id}_{i}"
        new_index["clusters"][cid] = {
            "centroid": c.centroid.tolist(),
            "count": len(c.member_face_ids),
            "faces": c.member_face_ids,
            "photos": c.photo_ids,
        }
        for fid in c.member_face_ids:
            src = index["faces"][fid]
            new_index["faces"][fid] = {**src, "cluster_id": cid}

        rep = index["faces"][c.representative_face_id]
        payload.append({
            "cluster_id": cid,
            "face_count": len(c.member_face_ids),
            "photo_ids": c.photo_ids,
            "cohesion": c.cohesion,
            "centroid": c.centroid.tolist(),
            "cover": {
                "photo_id": rep["photo_id"],
                "bbox": rep["bbox"],
                "face_id": c.representative_face_id,
            },
        })

    store.save_index(req.trip_id, new_index)

    return {
        "trip_id": req.trip_id,
        "clusters": payload,
        "metrics": metrics,
        "threshold": req.threshold,
        "elapsed_ms": int((time.time() - started) * 1000),
    }


@app.post("/v1/trips/purge")
def purge(req: DeleteRequest, x_service_token: str = Header(default="")) -> dict:
    """
    Delete a trip's entire embedding index.

    Called when a trip is archived or a member revokes consent. The design
    doc commits to "nothing about a member's face persists past that trip",
    and this endpoint is the mechanism that has to make that true.
    """
    _auth(x_service_token)
    deleted = store.purge(req.trip_id)
    log.info("purged embedding index trip=%s deleted=%s", req.trip_id, deleted)
    return {"trip_id": req.trip_id, "purged": deleted}
