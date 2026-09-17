# WanderMatch — Backend

PS-11 · Social & Group Travel Planning · Kognivera Hackathon 2026
Team: Gatorade Quadruples

Backend for the existing `index3.html` frontend. Every endpoint, table and
model choice below traces to a specific commitment in
`WanderMatch_PS-11_Design_v2.docx`.

---

## File structure

```
wandermatch/
├── docker-compose.yml           Postgres + Redis + MinIO + API + face service
├── db/
│   ├── provided/
│   │   └── schema.sql           ← COPY the hackathon's schema.sql here
│   ├── migrations/
│   │   ├── 001_additive.sql     5 new tables (Rule R1: additive only)
│   │   └── 002_auth.sql         credentials, kept out of `users`
│   └── seed/
│       └── demo.sql             a deliberately-tied proposal for the demo
│
├── services/
│   ├── api/                     Node 20 · Fastify · Socket.io
│   │   ├── src/
│   │   │   ├── server.js        bootstrap, auth gate, error shape
│   │   │   ├── config.js
│   │   │   ├── db/
│   │   │   │   ├── pool.js      pg pool + withTransaction()
│   │   │   │   └── migrate.js   forward-only migrator
│   │   │   ├── plugins/
│   │   │   │   └── rbac.js      owner/editor/viewer → permissions
│   │   │   ├── realtime/
│   │   │   │   └── io.js        room-per-trip, Redis adapter
│   │   │   ├── domain/          ← the parts that are actually hard
│   │   │   │   ├── concurrency.js  compare-and-bump on itineraries.version
│   │   │   │   ├── tally.js        weighted tally + tie detection
│   │   │   │   ├── consensus.js    AI planner + grounding validator
│   │   │   │   └── matching.js     solo→group heuristic
│   │   │   ├── routes/
│   │   │   │   ├── auth.js  trips.js  itinerary.js
│   │   │   │   ├── proposals.js  matching.js  photos.js  reference.js
│   │   │   └── lib/
│   │   │       ├── s3.js  faceClient.js  errors.js  logger.js
│   │   └── test/
│   │       ├── matching.test.js    11 tests
│   │       └── consensus.test.js    9 tests — hallucination rejection
│   │
│   └── face/                    Python 3.11 · FastAPI · InsightFace
│       ├── app/
│       │   ├── main.py          /analyse, /recluster, /purge
│       │   ├── detector.py      RetinaFace + ArcFace 512-d embeddings
│       │   ├── cluster.py       ← the image segregation logic
│       │   └── store.py         per-trip embedding index in object storage
│       └── test_clustering.py   12 tests
│
└── docs/API.md                  endpoint reference
```

---

## Quick start

```bash
# 1. Drop the hackathon schema in place
mkdir -p db/provided
cp /path/to/WanderMatch/data/schema.sql db/provided/schema.sql

# 2. Configure
cp services/api/.env.example services/api/.env
# set JWT_SECRET (openssl rand -base64 48) and ANTHROPIC_API_KEY

# 3. Bring it up
docker compose up -d postgres redis minio minio-init
docker compose up -d face            # first build pulls the face model (~300MB)

cd services/api
npm install
npm run migrate                       # applies 001 + 002
psql "$DATABASE_URL" -f ../../db/seed/demo.sql
npm run dev
```

Tests:

```bash
cd services/api && npm test           # 20 tests
cd services/face && python -m pytest  # 12 tests
```

---

## The three decisions worth defending

### 1. Conflict safety is one version field, not a merge engine

`itineraries.version` (provided, used as named) is the single concurrency
token. Every mutation sends the version the client last saw; the write is
refused if it moved. See `domain/concurrency.js`.

Two things make this actually correct rather than merely plausible:

- The check and the write happen inside **one transaction**, with
  `SELECT … FOR UPDATE` on the itinerary row. Split across two statements,
  two writers can both pass the check before either bumps.
- The broadcast happens **after commit**. Emitting inside the transaction
  would show every other client a change that could still roll back.

A rejected write returns `409 VERSION_CONFLICT` with both versions, so the
UI can say "someone changed this, reload" — which is the doc's stated
choice of honest-and-simple over clever-and-unverified.

One version per *itinerary*, not per item, because the board is reasoned
about as one object: per-item versions would let ordering and day
assignment drift while each item looked individually consistent.

### 2. The AI's output is validated, not trusted

`domain/consensus.js` fires server-side off a tied tally — the client never
calls the model. The response then passes field-by-field checks against
the rows we actually retrieved:

| Check | Catches |
|---|---|
| `primary_proposal_id ∈ candidates` | recommending something nobody proposed |
| `cites[].user_id ∈ actual voters` | **attributing an opinion to someone who never voted** |
| figures ∈ retrieved costs/durations | "it's only ₹120 extra" when that number exists nowhere |
| non-defer must cite ≥1 voter | confident-sounding ungrounded answers |

A violation is recorded with `grounding_passed = false` (kept as evidence
that the validator worked) and the UI shows a deterministic fallback:
earliest proposal wins, **labelled as arbitrary**. `consensus.test.js`
tests each rejection case.

`defer` is a legitimate model output. A planner allowed to say "I can't
ground this" is more useful than one that always produces something.

### 3. Face clustering under-merges on purpose

`services/face/app/cluster.py`. Agglomerative **average** linkage over
cosine distance at threshold 0.42.

- **Not k-means**: k is the answer, not an input, and k-means forces the
  background stranger into somebody's collage.
- **Not single linkage**: it chains, which is exactly how two people who
  each resemble a third get merged.
- **Not HDBSCAN as primary**: it calls a one-photo person "noise". Someone
  who appears once is a real person.

The threshold leans strict because the two failure modes are not
symmetric: under-merging is a click for the user to fix; over-merging puts
one member's photos in another member's collage. Verified in
`test_clustering.py` — 24 faces of 4 people recover as exactly 4 pure
clusters, silhouette 0.70, and a stranger correctly starts a new cluster.

Consent is enforced in `routes/photos.js` **before** any embedding is
computed, never after. The face service will embed anything handed to it —
that is deliberate separation, and it is why exactly one file decides.

---

## Data model

Nine provided tables used as named; nothing renamed or repurposed (R1).

**Added** (`001_additive.sql`), all pointing *at* provided tables:

| Table | Why |
|---|---|
| `consensus_recommendations` | AI output + grounding audit trail |
| `match_scores` | cached heuristic, components stored individually so the breakdown stays explainable |
| `join_requests` | the request that *precedes* a `trip_members` row |
| `trip_photos` | photo metadata; binaries live in object storage |
| `face_consents` | per-member, per-trip opt-in |
| `face_groups` / `face_group_photos` | clusters; `member_user_id` NULL until a human labels it |
| `auth_credentials` | password hash kept out of `users` |

---

## Known gaps

Stated plainly rather than discovered during judging:

- **No background job queue.** Face analysis is `queueMicrotask` in-process.
  Fine for a demo; an API restart mid-upload loses that photo's analysis
  (the row stays `processing`). A real deployment needs BullMQ.
- **`match_scores` cache has no invalidation on trip change.** A trip whose
  dates move mid-session can serve a stale score for up to an hour.
- **Presence is in-memory per socket.** Correct within one API instance;
  across replicas it needs the Redis adapter's room introspection.
- **Face service is CPU-only** at ~300-400ms/photo. A 200-photo batch takes
  minutes. Acceptable because it is off the realtime path and reports
  progress over the socket.
- **`trip_photos.perceptual_hash` is computed client-side** and therefore
  trusted. Fine for dedupe; not a security control.
