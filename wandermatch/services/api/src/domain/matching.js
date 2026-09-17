/**
 * SOLO-TO-GROUP MATCHING — heuristic, deliberately not a model.
 *
 *   score = 0.40 * interest overlap (Jaccard)
 *         + 0.25 * date-window overlap
 *         + 0.20 * pace / travel_style compatibility
 *         + 0.15 * budget band proximity
 *
 * The design doc is explicit that there is no LLM in this path, so every
 * score is explainable and the four components can be shown to the user.
 * That constraint is also what makes it fast: the whole thing is one
 * indexed query plus arithmetic, so it runs inline on request rather than
 * needing a job queue.
 *
 * Performance shape: candidate generation happens in SQL (destination +
 * date window + open-trip filters, all indexed), so we only ever score
 * tens of trips in JS, not the whole table. The scored result is cached in
 * match_scores keyed by a digest of the solo inputs, so re-opening the
 * screen is a single index hit.
 */

import crypto from 'node:crypto';
import { ulid } from 'ulid';

export const WEIGHTS = Object.freeze({
  interests: 0.40,
  dates: 0.25,
  pace: 0.20,
  budget: 0.15
});

/**
 * The provided schema uses two different vocabularies that both express
 * "how hard are we going": user_preferences.pace and users.travel_style.
 * We map both onto one ordinal axis so a trip can be compared even when
 * only one of the two is populated. Values not in the map score 0 for this
 * component rather than guessing a midpoint — an unknown is not a match.
 */
const PACE_SCALE = { relaxed: 0, slow: 0, moderate: 1, comfort: 1, balanced: 1, packed: 2, fast: 2, adventure: 2 };

/** users.budget_band is a 5-point scale in the provided schema. */
const BUDGET_SCALE = { shoestring: 0, value: 1, mid: 2, premium: 3, luxury: 4 };

export function jaccard(a, b) {
  const setA = new Set(a.map(normaliseInterest));
  const setB = new Set(b.map(normaliseInterest));
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function normaliseInterest(s) {
  return String(s).trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

/**
 * Overlap / union of the two date windows (Intersection-over-Union).
 *
 * IoU rather than "days in common" on purpose: a solo traveller free for
 * 3 days and a 14-day expedition share 3 days, but that is a poor match,
 * and raw overlap would score it as highly as a perfect 3-day alignment.
 */
export function dateOverlap(aStart, aEnd, bStart, bEnd) {
  if (!aStart || !aEnd || !bStart || !bEnd) return 0;
  const a1 = Date.parse(aStart), a2 = Date.parse(aEnd);
  const b1 = Date.parse(bStart), b2 = Date.parse(bEnd);
  if ([a1, a2, b1, b2].some(Number.isNaN)) return 0;

  const DAY = 86_400_000;
  // Inclusive windows: a single shared day is one day, not zero.
  const overlap = Math.max(0, Math.min(a2, b2) - Math.max(a1, b1) + DAY);
  const union = Math.max(a2, b2) - Math.min(a1, b1) + DAY;
  return union > 0 ? Math.min(1, overlap / union) : 0;
}

export function scaleCompatibility(a, b, scale) {
  const x = scale[String(a ?? '').toLowerCase()];
  const y = scale[String(b ?? '').toLowerCase()];
  if (x === undefined || y === undefined) return 0;
  const span = Math.max(...Object.values(scale)) - Math.min(...Object.values(scale));
  return span === 0 ? 1 : 1 - Math.abs(x - y) / span;
}

export function scoreCandidate(solo, candidate) {
  const interestScore = jaccard(solo.interests ?? [], candidate.memberInterests ?? []);
  const dateScore = dateOverlap(solo.startDate, solo.endDate, candidate.startDate, candidate.endDate);
  const paceScore = scaleCompatibility(solo.pace, candidate.pace, PACE_SCALE);
  const budgetScore = scaleCompatibility(solo.budgetBand, candidate.budgetBand, BUDGET_SCALE);

  const total =
    WEIGHTS.interests * interestScore +
    WEIGHTS.dates * dateScore +
    WEIGHTS.pace * paceScore +
    WEIGHTS.budget * budgetScore;

  return {
    total: Number(total.toFixed(4)),
    components: {
      interestScore: Number(interestScore.toFixed(4)),
      dateScore: Number(dateScore.toFixed(4)),
      paceScore: Number(paceScore.toFixed(4)),
      budgetScore: Number(budgetScore.toFixed(4))
    }
  };
}

/**
 * Candidate generation in SQL.
 *
 * Aggregates each open group trip's member interests and modal pace/budget
 * in one pass, so JS never sees more than the shortlist. `party_size >
 * active members` is what "has room" means against the provided schema —
 * there is no explicit capacity column, and inventing one would break R1.
 */
export async function fetchCandidateTrips(client, { destinationCityId, startDate, endDate, excludeUserId, limit = 60 }) {
  const { rows } = await client.query(
    `WITH open_trips AS (
       SELECT t.trip_id, t.title, t.destination_city_id, t.start_date, t.end_date,
              t.party_size, t.owner_user_id, t.home_currency, t.trip_type,
              c.name AS destination_name
         FROM trips t
         LEFT JOIN cities c ON c.city_id = t.destination_city_id
        WHERE t.is_group_trip
          AND t.status IN ('planning', 'draft')
          AND ($1::text IS NULL OR t.destination_city_id = $1)
          -- Only trips whose window could plausibly overlap. A 60-day pad
          -- keeps "flexible dates" usable without scanning all of history.
          AND ($2::date IS NULL OR t.end_date   >= $2::date - INTERVAL '60 days')
          AND ($3::date IS NULL OR t.start_date <= $3::date + INTERVAL '60 days')
     ),
     membership AS (
       SELECT tm.trip_id,
              COUNT(*) FILTER (WHERE tm.status = 'active') AS member_count,
              bool_or(tm.user_id = $4) AS already_member,
              -- Union of every active member's interests, de-duplicated.
              COALESCE(
                array_agg(DISTINCT trim(i)) FILTER (WHERE trim(i) <> ''),
                '{}'
              ) AS member_interests,
              -- Modal pace / budget across the group: the group's centre of
              -- gravity, not just the owner's preference.
              mode() WITHIN GROUP (ORDER BY up.pace)      AS group_pace,
              mode() WITHIN GROUP (ORDER BY u.budget_band) AS group_budget
         FROM trip_members tm
         JOIN users u ON u.user_id = tm.user_id
         LEFT JOIN user_preferences up ON up.user_id = tm.user_id
         LEFT JOIN LATERAL unnest(string_to_array(COALESCE(up.interests, ''), ',')) AS i ON true
        WHERE tm.status = 'active'
        GROUP BY tm.trip_id
     )
     SELECT ot.*, m.member_count, m.member_interests, m.group_pace, m.group_budget
       FROM open_trips ot
       JOIN membership m ON m.trip_id = ot.trip_id
      WHERE COALESCE(m.already_member, false) = false
        AND m.member_count < ot.party_size          -- has room
      ORDER BY ot.start_date
      LIMIT $5`,
    [destinationCityId ?? null, startDate ?? null, endDate ?? null, excludeUserId, limit]
  );

  return rows.map(r => ({
    tripId: r.trip_id,
    title: r.title,
    destinationCityId: r.destination_city_id,
    destinationName: r.destination_name,
    startDate: r.start_date,
    endDate: r.end_date,
    partySize: r.party_size,
    memberCount: Number(r.member_count),
    seatsLeft: r.party_size - Number(r.member_count),
    ownerUserId: r.owner_user_id,
    currency: r.home_currency,
    memberInterests: r.member_interests ?? [],
    pace: r.group_pace,
    budgetBand: r.group_budget
  }));
}

/** Stable digest of the solo inputs, so a cached row can be invalidated. */
export function digestInputs(solo) {
  const canonical = JSON.stringify({
    i: [...(solo.interests ?? [])].map(normaliseInterest).sort(),
    s: solo.startDate ?? null,
    e: solo.endDate ?? null,
    p: solo.pace ?? null,
    b: solo.budgetBand ?? null,
    d: solo.destinationCityId ?? null
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/**
 * Full ranked match. Reads cache first, computes and writes through on miss.
 */
export async function findMatches(client, solo, { limit = 10, useCache = true } = {}) {
  const digest = digestInputs(solo);

  if (useCache) {
    const cached = await client.query(
      `SELECT ms.*, t.title, t.start_date, t.end_date, t.party_size,
              t.owner_user_id, c.name AS destination_name
         FROM match_scores ms
         JOIN trips t ON t.trip_id = ms.trip_id
         LEFT JOIN cities c ON c.city_id = t.destination_city_id
        WHERE ms.user_id = $1
          AND ms.inputs_digest = $2
          AND ms.expires_at > now()
        ORDER BY ms.total_score DESC
        LIMIT $3`,
      [solo.userId, digest, limit]
    );
    if (cached.rows.length > 0) {
      return {
        cached: true,
        weights: WEIGHTS,
        matches: cached.rows.map(r => ({
          matchScoreId: r.match_score_id,
          tripId: r.trip_id,
          title: r.title,
          destinationName: r.destination_name,
          startDate: r.start_date,
          endDate: r.end_date,
          score: Number(r.total_score),
          components: {
            interestScore: Number(r.interest_score),
            dateScore: Number(r.date_score),
            paceScore: Number(r.pace_score),
            budgetScore: Number(r.budget_score)
          }
        }))
      };
    }
  }

  const candidates = await fetchCandidateTrips(client, {
    destinationCityId: solo.destinationCityId,
    startDate: solo.startDate,
    endDate: solo.endDate,
    excludeUserId: solo.userId
  });

  const scored = candidates
    .map(c => ({ candidate: c, ...scoreCandidate(solo, c) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);

  // Write-through cache. ON CONFLICT keeps this idempotent under the
  // double-submit that a impatient user reliably produces.
  const rows = [];
  for (const s of scored) {
    const id = ulid();
    const { rows: ins } = await client.query(
      `INSERT INTO match_scores (
         match_score_id, user_id, trip_id, total_score,
         interest_score, date_score, pace_score, budget_score,
         weights, inputs_digest, computed_at, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10, now(), now() + INTERVAL '1 hour')
       ON CONFLICT (user_id, trip_id, inputs_digest)
       DO UPDATE SET total_score = EXCLUDED.total_score,
                     interest_score = EXCLUDED.interest_score,
                     date_score = EXCLUDED.date_score,
                     pace_score = EXCLUDED.pace_score,
                     budget_score = EXCLUDED.budget_score,
                     computed_at = now(),
                     expires_at = now() + INTERVAL '1 hour'
       RETURNING match_score_id`,
      [
        id, solo.userId, s.candidate.tripId, s.total,
        s.components.interestScore, s.components.dateScore,
        s.components.paceScore, s.components.budgetScore,
        JSON.stringify(WEIGHTS), digest
      ]
    );
    rows.push({
      matchScoreId: ins[0].match_score_id,
      tripId: s.candidate.tripId,
      title: s.candidate.title,
      destinationName: s.candidate.destinationName,
      startDate: s.candidate.startDate,
      endDate: s.candidate.endDate,
      seatsLeft: s.candidate.seatsLeft,
      score: s.total,
      components: s.components,
      // Shown verbatim in the UI's breakdown drawer. Having the inputs
      // next to the score is what makes "why this trip?" answerable.
      matchedOn: {
        sharedInterests: (solo.interests ?? [])
          .map(normaliseInterest)
          .filter(i => s.candidate.memberInterests.map(normaliseInterest).includes(i)),
        groupPace: s.candidate.pace,
        groupBudget: s.candidate.budgetBand
      }
    });
  }

  return { cached: false, weights: WEIGHTS, matches: rows };
}
