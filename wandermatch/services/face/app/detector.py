"""
Face detection and embedding.

Model choice: InsightFace `buffalo_l` (RetinaFace detector + ArcFace
w600k_r50 recogniser, 512-d embeddings). Reasons this over the
alternatives, since the choice drives the whole clustering quality:

  * ArcFace embeddings are angularly separable by construction, so cosine
    similarity is the *native* metric — no learned threshold per dataset.
  * RetinaFace handles the case that actually matters for trip photos:
    small, off-angle, partially occluded faces in group shots. A frontal
    detector like Haar or even MTCNN drops the people at the edge of the
    frame, which is exactly who you want the collage to find.
  * It runs on CPU in ~200-400ms/photo, so a hackathon deploy does not
    need a GPU box.

Everything here is stateless. Trip scoping, consent and persistence are
the API's job, not this module's — this file just turns pixels into
vectors.
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass, field
from typing import Optional

import cv2
import numpy as np
from PIL import Image, ImageOps

log = logging.getLogger("face.detector")

# Faces smaller than this in the source image carry too little signal to
# embed reliably — including them is the main source of junk clusters.
MIN_FACE_PX = 40

# RetinaFace confidence floor. Below this we are usually looking at a
# face-shaped pattern in foliage or fabric, not a person.
MIN_DET_SCORE = 0.62

# Very oblique faces embed poorly and pull centroids around. We keep them
# for *display* but flag them so clustering can down-weight.
MAX_YAW_DEGREES = 55.0


@dataclass
class DetectedFace:
    bbox: tuple[int, int, int, int]      # x, y, w, h in source pixels
    det_score: float
    embedding: np.ndarray                # L2-normalised, 512-d
    landmarks: Optional[np.ndarray] = None
    yaw: Optional[float] = None
    blur_score: Optional[float] = None
    reliable: bool = True
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        x, y, w, h = self.bbox
        return {
            "bbox": {"x": int(x), "y": int(y), "w": int(w), "h": int(h)},
            "det_score": float(self.det_score),
            "embedding": [float(v) for v in self.embedding],
            "yaw": None if self.yaw is None else float(self.yaw),
            "blur_score": None if self.blur_score is None else float(self.blur_score),
            "reliable": bool(self.reliable),
            "reasons": self.reasons,
        }


class FaceEngine:
    """Lazily-loaded singleton around the InsightFace app."""

    _instance: Optional["FaceEngine"] = None

    def __init__(self, model_name: str = "buffalo_l", det_size: int = 640, ctx_id: int = -1):
        from insightface.app import FaceAnalysis

        log.info("loading insightface model=%s det_size=%d ctx=%d", model_name, det_size, ctx_id)
        self.app = FaceAnalysis(
            name=model_name,
            allowed_modules=["detection", "recognition", "landmark_3d_68"],
        )
        # ctx_id=-1 forces CPU. Set to 0 when a GPU is actually present.
        self.app.prepare(ctx_id=ctx_id, det_size=(det_size, det_size))
        self.dim = 512

    @classmethod
    def instance(cls) -> "FaceEngine":
        if cls._instance is None:
            cls._instance = FaceEngine()
        return cls._instance

    # ------------------------------------------------------------------
    def _load_image(self, data: bytes) -> np.ndarray:
        """
        Decode to BGR, honouring EXIF orientation.

        The EXIF step is not cosmetic: phone photos are routinely stored
        rotated with an orientation tag, and a detector fed a sideways
        image finds roughly nothing. This one call is the difference
        between "clustering is broken" and "clustering works".
        """
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")

        # Cap the long edge. Detection quality plateaus well before full
        # phone resolution, and the memory cost is quadratic.
        max_edge = 1600
        if max(img.size) > max_edge:
            scale = max_edge / max(img.size)
            img = img.resize(
                (int(img.width * scale), int(img.height * scale)),
                Image.LANCZOS,
            )

        rgb = np.asarray(img)
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)

    @staticmethod
    def _blur_score(bgr: np.ndarray, bbox) -> float:
        """Variance of Laplacian over the face crop; low = motion blurred."""
        x, y, w, h = bbox
        crop = bgr[max(0, y):y + h, max(0, x):x + w]
        if crop.size == 0:
            return 0.0
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        return float(cv2.Laplacian(gray, cv2.CV_64F).var())

    @staticmethod
    def _yaw_from_landmarks(face) -> Optional[float]:
        """
        Rough yaw from InsightFace's pose estimate when available.
        Used only to flag unreliable embeddings, never to reject a face
        outright — a profile shot is still that person.
        """
        pose = getattr(face, "pose", None)
        if pose is None:
            return None
        try:
            return float(pose[1])  # (pitch, yaw, roll)
        except Exception:
            return None

    # ------------------------------------------------------------------
    def detect(self, data: bytes) -> tuple[list[DetectedFace], dict]:
        bgr = self._load_image(data)
        height, width = bgr.shape[:2]

        faces = self.app.get(bgr)
        results: list[DetectedFace] = []

        for f in faces:
            x1, y1, x2, y2 = [int(v) for v in f.bbox]
            x, y = max(0, x1), max(0, y1)
            w, h = max(0, x2 - x1), max(0, y2 - y1)

            reasons: list[str] = []
            reliable = True

            if min(w, h) < MIN_FACE_PX:
                # Too small to embed meaningfully. Dropped entirely rather
                # than clustered badly — a wrong grouping is worse than a
                # missing one, because the user has to undo it.
                continue

            if float(f.det_score) < MIN_DET_SCORE:
                continue

            embedding = np.asarray(f.normed_embedding, dtype=np.float32)
            # InsightFace already normalises, but we do not want to depend
            # on that silently: cosine clustering breaks if it ever changes.
            norm = np.linalg.norm(embedding)
            if norm > 0:
                embedding = embedding / norm

            yaw = self._yaw_from_landmarks(f)
            if yaw is not None and abs(yaw) > MAX_YAW_DEGREES:
                reliable = False
                reasons.append("steep_yaw")

            blur = self._blur_score(bgr, (x, y, w, h))
            if blur < 25.0:
                reliable = False
                reasons.append("blurred")

            results.append(
                DetectedFace(
                    bbox=(x, y, w, h),
                    det_score=float(f.det_score),
                    embedding=embedding,
                    yaw=yaw,
                    blur_score=blur,
                    reliable=reliable,
                    reasons=reasons,
                )
            )

        meta = {
            "width": width,
            "height": height,
            "faces_found": len(results),
            "faces_rejected": len(faces) - len(results),
        }
        return results, meta
