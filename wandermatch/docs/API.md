# WanderMatch API

Base: `/api/v1` · Auth: `Authorization: Bearer <jwt>` on everything except
routes marked **public**.

Every error has the same shape, so the client branches on `code`:

```json
{ "error": { "code": "VERSION_CONFLICT", "message": "…", "details": { … } } }
```

| Code | Status | Meaning |
|---|---|---|
| `UNAUTHORIZED` | 401 | missing/expired token |
| `FORBIDDEN` | 403 | not a member, or role lacks the permission |
| `NOT_FOUND` | 404 | |
| `CONFLICT` | 409 | generic write conflict |
| `VERSION_CONFLICT` | 409 | **someone else edited — reload** |
| `PROPOSAL_CLOSED` | 409 | voted on a closed proposal |
| `CONSENT_REQUIRED` | 451 | face grouping without opt-in |
| `VALIDATION_FAILED` | 422 | includes `details[].path` |

---

## Auth

| | |
|---|---|
| `POST /auth/signup` **public** | `{email, password, displayName, locale}` → `{token, user}` |
| `POST /auth/login` **public** | `{email, password}` → `{token, user}` |
| `GET /auth/me` | current user + preferences |

Password minimum is 10 characters, hashed with Argon2id (19 MiB memory
cost). Login does equal work on the miss path so response timing does not
reveal whether an email is registered.

---

## Trips & members

| | |
|---|---|
| `POST /trips` | create; caller becomes `owner`, itinerary auto-created |
| `GET /trips` | trips you are a member of |
| `GET /trips/:tripId` | trip + members + `yourRole` |
| `POST /trips/:tripId/members` | invite (owner) |
| `PUT /trips/:tripId/members/:userId/role` | change role (owner) |
| `POST /trips/:tripId/archive` | completes trip, **deletes photos + face index** |

Roles → permissions (`plugins/rbac.js`):

| | read | edit items | propose | vote | invite | decide joins |
|---|---|---|---|---|---|---|
| owner | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| editor | ✓ | ✓ | ✓ | ✓ | | |
| viewer | ✓ | | ✓ | ✓ | | |

A viewer can propose and vote. Voting is voice; editing is authority.

---

## Itinerary — the version contract

`GET /trips/:tripId/itinerary` returns `version`. **Echo it on every write.**

```jsonc
// POST /trips/:id/itinerary/items
{ "itineraryId": "…", "expectedVersion": 7, "dayIndex": 2,
  "title": "Ganga Aarti", "itemType": "poi", "cost": 0, "currency": "INR" }
```

| | |
|---|---|
| `GET /trips/:tripId/itinerary` | days[], items grouped, openProposals, version |
| `POST …/itinerary/items` | create → `{item, version}` |
| `PATCH …/itinerary/items/:itemId` | partial update → `{item, version}` |
| `DELETE …/itinerary/items/:itemId?expectedVersion=N` | soft delete |
| `POST …/itinerary/reorder` | `{moves:[{itemId,dayIndex,sortOrder}]}` — **one** version bump |

On `409 VERSION_CONFLICT` the response carries `expectedVersion` and
`currentVersion`. Refetch; do not retry blindly.

---

## Proposals, votes, consensus

| | |
|---|---|
| `POST /trips/:tripId/proposals` | `action: add\|remove\|replace\|reschedule`; proposer auto-votes yes |
| `GET /trips/:tripId/proposals?status=open\|all` | with live tallies |
| `POST …/proposals/:proposalId/vote` | `{value: yes\|no\|abstain, weight, comment}` |
| `GET …/proposals/:proposalId/consensus` | recommendation history |
| `POST /trips/:tripId/consensus/:recId/decide` | `{decision: accept\|override, chosenProposalId?}` |

The vote response tells you what happened:

```jsonc
{ "outcome": "accepted" }                    // clear majority, already applied
{ "outcome": "rejected" }
{ "outcome": "pending", "reason": "quorum_not_met" }
{ "outcome": "tied", "consensus": {           // planner ran
    "strategy": "synthesise",
    "recommendation": "Keep the Chhatri Complex, add Ridge Lookout as optional.",
    "rationale": "…",
    "cites": [{ "user_id": "usr_2", "reason": "wanted the shorter walk" }],
    "groundingPassed": true,
    "isFallback": false
}}
```

**`groundingPassed: false` or `isFallback: true` means render it as an
unverified fallback, not as the planner's answer.** With no
`ANTHROPIC_API_KEY`, it is always the deterministic fallback (earliest
proposal wins) and the rationale says so.

Weighted tally: `votes.weight × trip_members.share_weight`. Abstentions
count toward quorum but neither side — which is what makes a 3–3 with two
abstentions a real tie rather than an under-attended vote.

---

## Matching

```jsonc
// POST /matching/search
{ "destinationCityId": "city_manali", "startDate": "2027-03-10",
  "endDate": "2027-03-15", "interests": ["hiking"], "limit": 10 }
```

Omitted fields fall back to the user's stored `user_preferences`. Returns
each match with the four components, so the UI's breakdown drawer is the
real arithmetic:

```jsonc
{ "weights": { "interests": 0.4, "dates": 0.25, "pace": 0.2, "budget": 0.15 },
  "matches": [{ "tripId": "…", "score": 0.78,
    "components": { "interestScore": 0.67, "dateScore": 1.0,
                    "paceScore": 1.0, "budgetScore": 0.75 },
    "matchedOn": { "sharedInterests": ["hiking"] },
    "seatsLeft": 2 }] }
```

`total` is exactly the weighted sum of the components shown — asserted in
`test/matching.test.js`.

| | |
|---|---|
| `POST /trips/:tripId/join-requests` | request to join |
| `GET /trips/:tripId/join-requests` | pending, ranked by match score (owner) |
| `POST …/join-requests/:requestId/decide` | `{decision, role}` → creates `trip_members` |

Capacity is re-checked inside the approval transaction, so two owners
approving simultaneously cannot overfill a trip.

---

## Photos & face grouping

Upload is presigned-direct-to-S3 — 15 MB photos never pass through Node.

```
1. POST /trips/:id/photos/presign   → { photoId, uploadUrl }
2. PUT  <uploadUrl>                  (browser → object storage)
3. POST /trips/:id/photos/:photoId/complete
```

| | |
|---|---|
| `PUT /trips/:tripId/face-consent` | `{granted: bool}` — **required before any embedding** |
| `GET /trips/:tripId/face-consent` | your consent state |
| `POST …/photos/presign` | `{contentType, byteSize, perceptualHash?}`; returns `{duplicate:true}` on phash hit |
| `POST …/photos/:photoId/complete` | queues analysis, or `{faceGrouping:"skipped", reason:"no_consent"}` |
| `GET /trips/:tripId/face-groups` | one card per person, signed photo URLs (10 min TTL) |
| `PUT …/face-groups/:id/label` | `{memberUserId}` — **manual only, never automatic** |
| `POST …/face-groups/recluster` | full re-cluster, returns quality metrics |
| `DELETE …/photos/:photoId` | |

Without consent the photo is still stored and shown — just never analysed.
Revoking consent, when it is the last consent on the trip, deletes the
whole embedding index.

---

## Realtime

```js
const socket = io(API_ORIGIN, { auth: { token } });
socket.emit('trip:subscribe', tripId, ({ ok, role }) => { /* … */ });
```

The socket is **output only** — all writes go through HTTP so permission,
version and transaction checks live in one path. Every event carries
`actorUserId`, so ignore your own echo rather than re-rendering over the
user's cursor.

| Event | Payload |
|---|---|
| `item:created` `item:updated` `item:deleted` | `{item?, itemId?, version}` |
| `itinerary:version` | `{moves, version}` |
| `proposal:created` `proposal:updated` `proposal:resolved` | `{proposal?, tally?, resolution?}` |
| `vote:cast` | `{proposalId, userId, value, tally}` |
| `consensus:ready` | `{recommendation}` — render the card |
| `consensus:decided` | `{decision, winningProposalId, version}` |
| `member:joined` `member:role_changed` | |
| `photo:uploaded` `photo:processed` | `{photoId, facesDetected?}` |
| `face_groups:updated` | `{reclustered?, metrics?}` |
| `presence:update` | `{userIds}` — live only, never persisted |

---

## Reference (public)

`GET /reference/cities?q=` · `/languages` · `/currencies` · `/guides?cityId=&language=&specialisation=&maxDayRate=`

Guides return `"bookable": false`. Listing and filtering only — booking is
PS-04's territory.
