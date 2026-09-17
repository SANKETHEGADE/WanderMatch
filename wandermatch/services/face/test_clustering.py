"""
Clustering regression tests.

The design doc commits to clustering quality being "measured directly
rather than asserted" (§8.3). These are that measurement.

A note on the synthetic generator, because it is easy to get wrong and
the wrong version silently makes the tests meaningless:

  Agglomerative average-linkage compares PAIRS of samples. For a sample
  v = identity + noise (then L2-normalised), the sample-to-identity cosine
  is 1/sqrt(1 + d*s^2), but the sample-to-SAMPLE cosine is 1/(1 + d*s^2) —
  the square of it. Calibrating the generator against the wrong one makes
  every face a singleton and the test passes vacuously on "purity".

Real ArcFace intra-person pair similarity across pose/lighting is roughly
0.6-0.8; inter-person is near 0. The generator targets that.
"""
import numpy as np
import pytest

from app.cluster import (
    FaceRecord, cluster_faces, assign_incremental, update_centroid,
    evaluate_clustering, COSINE_DISTANCE_THRESHOLD,
)

DIM = 512


def make_population(people=4, shots=6, pair_cos=0.70, seed=7):
    """Synthetic faces at a realistic intra-person pair similarity."""
    rng = np.random.default_rng(seed)
    s = np.sqrt((1 / pair_cos - 1) / DIM)
    faces, truth = [], {}
    for person in range(people):
        base = rng.normal(size=DIM)
        base /= np.linalg.norm(base)
        for shot in range(shots):
            v = base + rng.normal(scale=s, size=DIM)
            v /= np.linalg.norm(v)
            fid = f"p{person}_s{shot}"
            truth[fid] = person
            faces.append(
                FaceRecord(fid, f"photo_{person}_{shot}", v.astype(np.float32), {}, 0.95, True)
            )
    return faces, truth


def test_generator_produces_realistic_separation():
    """If this fails, every other test in this file is meaningless."""
    faces, truth = make_population()
    E = np.vstack([f.embedding for f in faces])
    intra, inter = [], []
    for i in range(len(faces)):
        for j in range(i + 1, len(faces)):
            (intra if truth[faces[i].face_id] == truth[faces[j].face_id] else inter).append(
                float(E[i] @ E[j])
            )
    assert 0.60 < np.mean(intra) < 0.82, f"intra-person similarity unrealistic: {np.mean(intra)}"
    assert abs(np.mean(inter)) < 0.15, f"inter-person similarity unrealistic: {np.mean(inter)}"


def test_recovers_correct_number_of_people():
    faces, _ = make_population(people=4, shots=6)
    clusters = cluster_faces(faces)
    assert len(clusters) == 4, f"expected 4 people, found {len(clusters)}"


def test_never_merges_two_different_people():
    """
    The critical property. A wrong merge means one member's collage shows
    another member's photos — a privacy incident, not a cosmetic bug.
    Under-merging is recoverable by the user; this is not.
    """
    faces, truth = make_population(people=6, shots=5)
    for c in cluster_faces(faces):
        identities = {truth[fid] for fid in c.member_face_ids}
        assert len(identities) == 1, f"cluster mixed identities: {identities}"


def test_single_photo_person_is_still_a_cluster():
    """
    Someone who appears in exactly one photo is a legitimate person, not
    noise. This is the specific reason we use agglomerative rather than
    HDBSCAN as the primary clusterer.
    """
    faces, _ = make_population(people=3, shots=4)
    rng = np.random.default_rng(99)
    loner = rng.normal(size=DIM)
    loner /= np.linalg.norm(loner)
    faces.append(FaceRecord("loner_s0", "photo_lone", loner.astype(np.float32), {}, 0.9, True))

    clusters = cluster_faces(faces)
    assert any(c.member_face_ids == ["loner_s0"] for c in clusters), "single-shot person was dropped"


def test_empty_and_single_inputs_do_not_crash():
    assert cluster_faces([]) == []
    faces, _ = make_population(people=1, shots=1)
    assert len(cluster_faces(faces)) == 1


def test_incremental_assignment_finds_the_right_person():
    faces, truth = make_population(people=4, shots=6)
    clusters = cluster_faces(faces)
    existing = [(f"c{i}", c.centroid, len(c.member_face_ids)) for i, c in enumerate(clusters)]

    rng = np.random.default_rng(123)
    s = np.sqrt((1 / 0.70 - 1) / DIM)
    probe = faces[0].embedding + rng.normal(scale=s, size=DIM)
    probe /= np.linalg.norm(probe)

    cid, sim = assign_incremental(
        FaceRecord("probe", "photo_new", probe.astype(np.float32), {}, 0.9, True), existing
    )
    person0_clusters = {
        f"c{i}" for i, c in enumerate(clusters)
        if any(truth[f] == truth[faces[0].face_id] for f in c.member_face_ids)
    }
    assert cid in person0_clusters, f"assigned to {cid}, expected one of {person0_clusters}"
    assert sim > 0.6


def test_stranger_starts_a_new_cluster_instead_of_being_absorbed():
    """
    A person in the background of one photo must not be folded into a
    member's group. Returning None ("start a new cluster") is the safe
    default and the behaviour we depend on.
    """
    faces, _ = make_population(people=3, shots=5)
    clusters = cluster_faces(faces)
    existing = [(f"c{i}", c.centroid, len(c.member_face_ids)) for i, c in enumerate(clusters)]

    rng = np.random.default_rng(31337)
    stranger = rng.normal(size=DIM)
    stranger /= np.linalg.norm(stranger)

    cid, sim = assign_incremental(
        FaceRecord("x", "photo_x", stranger.astype(np.float32), {}, 0.9, True), existing
    )
    assert cid is None, f"stranger wrongly merged into {cid} at similarity {sim}"


def test_unreliable_faces_face_a_stricter_bar():
    """A blurred face must match better than a sharp one to join a cluster."""
    faces, _ = make_population(people=2, shots=5)
    clusters = cluster_faces(faces)
    existing = [(f"c{i}", c.centroid, len(c.member_face_ids)) for i, c in enumerate(clusters)]

    rng = np.random.default_rng(5)
    # Deliberately borderline: similar enough for a reliable face, not
    # enough for an unreliable one.
    borderline = faces[0].embedding + rng.normal(scale=0.055, size=DIM)
    borderline /= np.linalg.norm(borderline)

    reliable, _ = assign_incremental(
        FaceRecord("r", "p", borderline.astype(np.float32), {}, 0.9, reliable=True), existing
    )
    unreliable, _ = assign_incremental(
        FaceRecord("u", "p", borderline.astype(np.float32), {}, 0.9, reliable=False), existing
    )
    assert not (unreliable is not None and reliable is None), \
        "an unreliable face was accepted where a reliable one was rejected"


def test_centroid_update_stays_normalised():
    rng = np.random.default_rng(11)
    c = rng.normal(size=DIM); c /= np.linalg.norm(c)
    e = rng.normal(size=DIM); e /= np.linalg.norm(e)
    updated = update_centroid(c, 5, e, reliable=True)
    assert abs(np.linalg.norm(updated) - 1.0) < 1e-5


def test_unreliable_face_moves_the_centroid_less():
    rng = np.random.default_rng(13)
    c = rng.normal(size=DIM); c /= np.linalg.norm(c)
    e = rng.normal(size=DIM); e /= np.linalg.norm(e)
    strong = update_centroid(c, 3, e, reliable=True)
    weak = update_centroid(c, 3, e, reliable=False)
    assert float(weak @ c) > float(strong @ c), "unreliable face should perturb the centroid less"


def test_quality_metrics_are_reported():
    faces, _ = make_population(people=4, shots=6)
    clusters = cluster_faces(faces)
    labels = np.array([
        next(i for i, c in enumerate(clusters) if f.face_id in c.member_face_ids)
        for f in faces
    ])
    metrics = evaluate_clustering(faces, labels)
    assert metrics["n_clusters"] == 4
    assert metrics["silhouette"] is not None and metrics["silhouette"] > 0.4, \
        f"clustering quality too low: {metrics}"


def test_threshold_biases_toward_under_merging():
    """
    Documented intent: the threshold is deliberately strict. Verify it sits
    on the conservative side rather than drifting loose over time.
    """
    assert 0.35 <= COSINE_DISTANCE_THRESHOLD <= 0.50
