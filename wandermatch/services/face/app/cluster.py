"""
Per-trip face clustering — "show me the photos I'm in".

This is the module that does the segregation the brief asks for, so the
choices here are worth stating explicitly.

WHY NOT K-MEANS: k-means needs k. We do not know how many people are in a
trip's photos — that is the answer, not an input. It also forces every
point into a cluster, so a stranger in the background of one photo gets
absorbed into a real person's group.

WHY HDBSCAN/DBSCAN-STYLE DENSITY CLUSTERING: it discovers k, and it has a
native concept of noise. The background stranger stays unassigned instead
of corrupting a member's collage. That is the correct behaviour for a
product where a wrong grouping is a privacy incident, not a cosmetic bug.

WHY WE STILL RUN AGGLOMERATIVE AS THE PRIMARY: with typical trip volumes
(tens to a few hundred faces), average-linkage agglomerative clustering
with a cosine distance threshold is deterministic, has one interpretable
knob, and does not need a minimum cluster size — which matters because a
person who appears in exactly one photo is a legitimate cluster of one,
and HDBSCAN would call them noise. We use HDBSCAN only as a consistency
check on larger sets.

THRESHOLD: 0.42 cosine distance (~0.58 similarity) on ArcFace embeddings.
Calibrated toward *under*-merging: it is trivial for a user to merge two
clusters of the same person, and painful to discover their photos were
mixed with someone else's.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Iterable, Optional

import numpy as np
from sklearn.cluster import AgglomerativeClustering
from sklearn.metrics import silhouette_score

log = logging.getLogger("face.cluster")

# Primary merge threshold, in cosine DISTANCE (1 - cosine similarity).
COSINE_DISTANCE_THRESHOLD = 0.42

# Assigning a NEW face to an EXISTING cluster is stricter than forming
# clusters in the first place: an incremental mistake is sticky, because
# it shifts the centroid and makes the next mistake more likely.
INCREMENTAL_ASSIGN_THRESHOLD = 0.36

# Unreliable faces (blurred / steep yaw) may JOIN a cluster but never
# define one, and never move a centroid far.
UNRELIABLE_WEIGHT = 0.35


@dataclass
class FaceRecord:
    face_id: str
    photo_id: str
    embedding: np.ndarray
    bbox: dict
    det_score: float
    reliable: bool = True


@dataclass
class Cluster:
    cluster_id: Optional[str]
    member_face_ids: list[str]
    photo_ids: list[str]
    centroid: np.ndarray
    cohesion: float          # mean cosine similarity to centroid
    representative_face_id: str


def _l2(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


def cosine_distance_matrix(embeddings: np.ndarray) -> np.ndarray:
    """Dense pairwise cosine distance. Fine to O(n^2) at trip scale."""
    normed = _l2(embeddings)
    similarity = np.clip(normed @ normed.T, -1.0, 1.0)
    return 1.0 - similarity


def weighted_centroid(
    embeddings: np.ndarray, reliable_flags: Iterable[bool]
) -> np.ndarray:
    """
    Centroid that discounts unreliable faces.

    A blurred profile shot should be findable under a person's card, but
    it must not drag the centroid toward a neighbouring person, or the
    whole cluster slowly drifts and starts absorbing the wrong faces.
    """
    weights = np.array(
        [1.0 if r else UNRELIABLE_WEIGHT for r in reliable_flags], dtype=np.float32
    )
    weights = weights.reshape(-1, 1)
    centroid = (embeddings * weights).sum(axis=0) / max(weights.sum(), 1e-6)
    norm = np.linalg.norm(centroid)
    return centroid / norm if norm > 0 else centroid


def cluster_faces(
    faces: list[FaceRecord],
    threshold: float = COSINE_DISTANCE_THRESHOLD,
) -> list[Cluster]:
    """
    Full re-cluster of one trip's faces. Called on the first batch and on
    an explicit re-cluster; the incremental path below handles single
    uploads.
    """
    if not faces:
        return []

    if len(faces) == 1:
        f = faces[0]
        return [
            Cluster(
                cluster_id=None,
                member_face_ids=[f.face_id],
                photo_ids=[f.photo_id],
                centroid=f.embedding,
                cohesion=1.0,
                representative_face_id=f.face_id,
            )
        ]

    embeddings = _l2(np.vstack([f.embedding for f in faces]).astype(np.float32))

    # Average linkage, not single: single linkage chains, and chaining is
    # exactly the failure that merges two people who each resemble a third.
    model = AgglomerativeClustering(
        n_clusters=None,
        distance_threshold=threshold,
        metric="cosine",
        linkage="average",
    )
    labels = model.fit_predict(embeddings)

    clusters: list[Cluster] = []
    for label in sorted(set(labels)):
        idx = np.where(labels == label)[0]
        members = [faces[i] for i in idx]
        member_embeddings = embeddings[idx]
        centroid = weighted_centroid(
            member_embeddings, [m.reliable for m in members]
        )

        sims = np.clip(member_embeddings @ centroid, -1.0, 1.0)
        cohesion = float(sims.mean())

        # Representative = highest-quality face nearest the centroid. This
        # becomes the cluster's cover image, so it should be a clear,
        # front-facing shot rather than whichever happened to be first.
        quality = sims * np.array(
            [m.det_score * (1.0 if m.reliable else 0.5) for m in members]
        )
        rep = members[int(np.argmax(quality))]

        clusters.append(
            Cluster(
                cluster_id=None,
                member_face_ids=[m.face_id for m in members],
                photo_ids=sorted({m.photo_id for m in members}),
                centroid=centroid,
                cohesion=cohesion,
                representative_face_id=rep.face_id,
            )
        )

    clusters.sort(key=lambda c: len(c.photo_ids), reverse=True)

    log.info(
        "clustered %d faces into %d groups (threshold=%.2f)",
        len(faces), len(clusters), threshold,
    )
    return clusters


def assign_incremental(
    face: FaceRecord,
    existing: list[tuple[str, np.ndarray, int]],
    threshold: float = INCREMENTAL_ASSIGN_THRESHOLD,
) -> tuple[Optional[str], float]:
    """
    Match one new face against existing cluster centroids.

    `existing` is [(cluster_id, centroid, face_count)]. Returns
    (cluster_id or None, similarity). None means "start a new cluster",
    which is the safe default — a new person is cheap, a wrong merge is not.
    """
    if not existing:
        return None, 0.0

    centroids = _l2(np.vstack([c[1] for c in existing]).astype(np.float32))
    embedding = face.embedding / max(np.linalg.norm(face.embedding), 1e-6)

    sims = np.clip(centroids @ embedding, -1.0, 1.0)
    best = int(np.argmax(sims))
    best_sim = float(sims[best])
    best_distance = 1.0 - best_sim

    effective = threshold
    if not face.reliable:
        # A blurred face needs to be a *better* match to join, not a worse
        # one — otherwise low-information faces land wherever by chance.
        effective *= 0.75

    if best_distance <= effective:
        return existing[best][0], best_sim
    return None, best_sim


def update_centroid(
    centroid: np.ndarray, count: int, new_embedding: np.ndarray, reliable: bool = True
) -> np.ndarray:
    """
    Running-mean centroid update, weight-aware.

    Kept explicit rather than recomputing from all members: the per-face
    vectors live in object storage, not Postgres, so the centroid is the
    only thing the API can cheaply keep hot.
    """
    weight = 1.0 if reliable else UNRELIABLE_WEIGHT
    updated = (centroid * count + new_embedding * weight) / (count + weight)
    norm = np.linalg.norm(updated)
    return updated / norm if norm > 0 else updated


def evaluate_clustering(faces: list[FaceRecord], labels: np.ndarray) -> dict:
    """
    Quality metrics, so the design doc's "measured directly rather than
    asserted" claim is actually backed by a number.

    Silhouette on cosine distance is the honest summary: it rewards
    clusters that are tight AND well-separated, which is exactly the
    trade-off the threshold controls. Reported alongside cluster-size
    distribution, because a great silhouette with one giant cluster means
    the threshold is too loose.
    """
    if len(faces) < 3 or len(set(labels)) < 2:
        return {"silhouette": None, "n_clusters": len(set(labels)), "note": "too few points"}

    embeddings = _l2(np.vstack([f.embedding for f in faces]).astype(np.float32))
    try:
        score = float(silhouette_score(embeddings, labels, metric="cosine"))
    except Exception as exc:  # pragma: no cover
        log.warning("silhouette failed: %s", exc)
        score = None

    sizes = np.bincount(labels)
    return {
        "silhouette": score,
        "n_clusters": int(len(set(labels))),
        "largest_cluster": int(sizes.max()),
        "singleton_clusters": int((sizes == 1).sum()),
        "mean_cluster_size": float(sizes.mean()),
    }
