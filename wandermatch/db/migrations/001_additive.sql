-- WanderMatch · PS-11 · additive migration
--
-- Rule R1 compliance: this file ONLY adds. No provided column is renamed,
-- dropped, retyped or reused for different semantics. Every table below is
-- new and points AT the provided tables via FK, never the other way round.
--
-- Run order:  schema.sql (provided)  ->  this file  ->  seed/*.sql
--
-- Design-doc reference: Section 7 "What we add — additive, not a rename".

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. consensus_recommendations
--    Output of the AI consensus planner for a tied/contested proposal.
--    One row per (proposal, generation attempt) so an override or a re-run is
--    an append, never a destructive update — we keep the audit trail because
--    "the AI said X and the owner chose Y" is exactly what a judge asks about.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consensus_recommendations (
  recommendation_id   TEXT PRIMARY KEY,
  proposal_id         TEXT NOT NULL,
  -- 'pick_one'    -> adopt exactly one candidate
  -- 'synthesise'  -> keep primary, attach secondary as optional add-on
  -- 'defer'       -> model declined / ungrounded; UI shows deterministic fallback
  strategy            TEXT NOT NULL CHECK (strategy IN ('pick_one', 'synthesise', 'defer')),
  primary_proposal_id TEXT,
  secondary_proposal_id TEXT,
  recommendation      TEXT NOT NULL,
  rationale           TEXT NOT NULL,
  -- cites: [{user_id, reason}] — every entry is validated against real votes
  -- on this proposal before the row is ever written. See domain/consensus.js.
  cites               JSONB NOT NULL DEFAULT '[]'::jsonb,
  model               TEXT,
  prompt_tokens       INTEGER,
  completion_tokens   INTEGER,
  latency_ms          INTEGER,
  -- grounding_passed = false rows are KEPT deliberately: they are the evidence
  -- that the validator rejected an ungrounded answer instead of rendering it.
  grounding_passed    BOOLEAN NOT NULL,
  grounding_errors    JSONB NOT NULL DEFAULT '[]'::jsonb,
  outcome             TEXT NOT NULL DEFAULT 'pending'
                        CHECK (outcome IN ('pending', 'accepted', 'overridden', 'superseded')),
  decided_by_user_id  TEXT,
  decided_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE consensus_recommendations
  ADD CONSTRAINT fk_consrec_proposal
  FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id) ON DELETE CASCADE;
ALTER TABLE consensus_recommendations
  ADD CONSTRAINT fk_consrec_primary
  FOREIGN KEY (primary_proposal_id) REFERENCES proposals(proposal_id);
ALTER TABLE consensus_recommendations
  ADD CONSTRAINT fk_consrec_secondary
  FOREIGN KEY (secondary_proposal_id) REFERENCES proposals(proposal_id);
ALTER TABLE consensus_recommendations
  ADD CONSTRAINT fk_consrec_decided_by
  FOREIGN KEY (decided_by_user_id) REFERENCES users(user_id);

CREATE INDEX idx_consrec_proposal ON consensus_recommendations(proposal_id);
CREATE INDEX idx_consrec_outcome  ON consensus_recommendations(outcome);

-- ---------------------------------------------------------------------------
-- 2. match_scores
--    Cache of the solo-to-group heuristic per (solo user x candidate trip).
--    Components are stored individually, not just the total, because the UI
--    reveals the four-part breakdown on tap — and because a cached total with
--    no components would be unexplainable, defeating the point of the heuristic.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS match_scores (
  match_score_id   TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  trip_id          TEXT NOT NULL,
  total_score      NUMERIC(5,4) NOT NULL CHECK (total_score BETWEEN 0 AND 1),
  interest_score   NUMERIC(5,4) NOT NULL,
  date_score       NUMERIC(5,4) NOT NULL,
  pace_score       NUMERIC(5,4) NOT NULL,
  budget_score     NUMERIC(5,4) NOT NULL,
  -- The exact weights used, persisted with the row. If we ever retune the
  -- heuristic, old cached rows stay interpretable instead of silently
  -- meaning something different.
  weights          JSONB NOT NULL,
  -- Snapshot of the solo inputs this score was computed from, so a stale
  -- cache hit can be detected rather than served blindly.
  inputs_digest    TEXT NOT NULL,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, trip_id, inputs_digest)
);

ALTER TABLE match_scores
  ADD CONSTRAINT fk_match_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;
ALTER TABLE match_scores
  ADD CONSTRAINT fk_match_trip FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON DELETE CASCADE;

CREATE INDEX idx_match_user_score ON match_scores(user_id, total_score DESC);
CREATE INDEX idx_match_expires    ON match_scores(expires_at);

-- ---------------------------------------------------------------------------
-- 3. join_requests
--    The request-to-join flow. The design doc says approval "creates a
--    trip_members row" — this table is the request that precedes it, so a
--    pending request isn't misrepresented as membership.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS join_requests (
  request_id        TEXT PRIMARY KEY,
  trip_id           TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  message           TEXT,
  match_score_id    TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  decided_by_user_id TEXT,
  decided_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trip_id, user_id)
);

ALTER TABLE join_requests
  ADD CONSTRAINT fk_join_trip FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON DELETE CASCADE;
ALTER TABLE join_requests
  ADD CONSTRAINT fk_join_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;
ALTER TABLE join_requests
  ADD CONSTRAINT fk_join_score FOREIGN KEY (match_score_id) REFERENCES match_scores(match_score_id);
ALTER TABLE join_requests
  ADD CONSTRAINT fk_join_decided_by FOREIGN KEY (decided_by_user_id) REFERENCES users(user_id);

CREATE INDEX idx_join_trip_status ON join_requests(trip_id, status);

-- ---------------------------------------------------------------------------
-- 4. trip_photos
--    Photo metadata + object-storage pointer. The binary never touches
--    Postgres. perceptual_hash supports duplicate suppression on re-upload.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_photos (
  photo_id          TEXT PRIMARY KEY,
  trip_id           TEXT NOT NULL,
  uploaded_by_user_id TEXT NOT NULL,
  storage_key       TEXT NOT NULL,
  thumb_key         TEXT,
  content_type      TEXT NOT NULL,
  byte_size         INTEGER NOT NULL,
  width             INTEGER,
  height            INTEGER,
  captured_at       TIMESTAMPTZ,
  perceptual_hash   TEXT,
  faces_detected    SMALLINT NOT NULL DEFAULT 0,
  processing_status TEXT NOT NULL DEFAULT 'pending'
                      CHECK (processing_status IN ('pending', 'processing', 'done', 'failed', 'skipped')),
  processing_error  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trip_id, storage_key)
);

ALTER TABLE trip_photos
  ADD CONSTRAINT fk_photo_trip FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON DELETE CASCADE;
ALTER TABLE trip_photos
  ADD CONSTRAINT fk_photo_uploader FOREIGN KEY (uploaded_by_user_id) REFERENCES users(user_id);

CREATE INDEX idx_photo_trip   ON trip_photos(trip_id);
CREATE INDEX idx_photo_status ON trip_photos(processing_status) WHERE processing_status IN ('pending','processing');
CREATE INDEX idx_photo_phash  ON trip_photos(trip_id, perceptual_hash);

-- ---------------------------------------------------------------------------
-- 5. face_consents
--    Per-member, per-trip opt-in. Face processing MUST check this table
--    before any embedding is computed — not after. Revoking is a row update
--    plus a cascade delete of that member's contributions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS face_consents (
  consent_id   TEXT PRIMARY KEY,
  trip_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  granted      BOOLEAN NOT NULL DEFAULT false,
  granted_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trip_id, user_id)
);

ALTER TABLE face_consents
  ADD CONSTRAINT fk_consent_trip FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON DELETE CASCADE;
ALTER TABLE face_consents
  ADD CONSTRAINT fk_consent_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 6. face_groups  /  face_group_photos
--    One row per detected cluster within ONE trip. member_user_id is NULL
--    until a human manually labels it — never auto-filled (design doc §8.3).
--
--    NOTE ON EMBEDDINGS: the centroid lives here only to let new faces be
--    matched to an existing cluster without a full re-cluster. It is scoped
--    to the trip and deleted with it. Per-face vectors stay in the per-trip
--    object-storage index, never in Postgres.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS face_groups (
  face_group_id    TEXT PRIMARY KEY,
  trip_id          TEXT NOT NULL,
  member_user_id   TEXT,                       -- NULL = unlabelled, by design
  label            TEXT,                       -- free-text label if not a member
  face_count       INTEGER NOT NULL DEFAULT 0,
  photo_count      INTEGER NOT NULL DEFAULT 0,
  cover_photo_id   TEXT,
  cover_bbox       JSONB,
  centroid         REAL[],                     -- L2-normalised, trip-scoped
  centroid_dim     SMALLINT,
  labelled_by_user_id TEXT,
  labelled_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE face_groups
  ADD CONSTRAINT fk_fg_trip FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON DELETE CASCADE;
ALTER TABLE face_groups
  ADD CONSTRAINT fk_fg_member FOREIGN KEY (member_user_id) REFERENCES users(user_id);
ALTER TABLE face_groups
  ADD CONSTRAINT fk_fg_cover FOREIGN KEY (cover_photo_id) REFERENCES trip_photos(photo_id) ON DELETE SET NULL;
ALTER TABLE face_groups
  ADD CONSTRAINT fk_fg_labeller FOREIGN KEY (labelled_by_user_id) REFERENCES users(user_id);

CREATE INDEX idx_fg_trip ON face_groups(trip_id);

CREATE TABLE IF NOT EXISTS face_group_photos (
  face_group_id  TEXT NOT NULL,
  photo_id       TEXT NOT NULL,
  bbox           JSONB NOT NULL,          -- {x,y,w,h} in source pixels
  det_score      REAL,                    -- detector confidence
  similarity     REAL,                    -- cosine to cluster centroid at assign time
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (face_group_id, photo_id, bbox)
);

ALTER TABLE face_group_photos
  ADD CONSTRAINT fk_fgp_group FOREIGN KEY (face_group_id) REFERENCES face_groups(face_group_id) ON DELETE CASCADE;
ALTER TABLE face_group_photos
  ADD CONSTRAINT fk_fgp_photo FOREIGN KEY (photo_id) REFERENCES trip_photos(photo_id) ON DELETE CASCADE;

CREATE INDEX idx_fgp_photo ON face_group_photos(photo_id);

-- ---------------------------------------------------------------------------
-- 7. Hot-path indexes the provided schema does not ship.
--    These are pure additions; no provided index is altered.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_trip_members_user        ON trip_members(user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_trip_members_trip_active ON trip_members(trip_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_itineraries_trip_active  ON itineraries(trip_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_items_itinerary_day      ON itinerary_items(itinerary_id, day_index, sort_order)
                                                           WHERE status <> 'removed';
CREATE INDEX IF NOT EXISTS idx_proposals_open           ON proposals(itinerary_id, closes_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_votes_proposal           ON votes(proposal_id);
CREATE INDEX IF NOT EXISTS idx_trips_open_group         ON trips(destination_city_id, start_date)
                                                           WHERE is_group_trip AND status IN ('planning','draft');

COMMIT;
