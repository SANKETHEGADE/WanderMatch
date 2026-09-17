/**
 * Optimistic concurrency control for the shared itinerary.
 *
 * The design doc's central claim is: "item-level optimistic locking
 * (compare-and-bump on version) gets us conflict-safety without a
 * research-grade merge engine." This file is that claim, implemented.
 *
 * The rule, stated precisely:
 *   Every mutation of an itinerary or any of its items carries the
 *   version the client last SAW. The write succeeds only if the stored
 *   version still equals it. Otherwise the write is REFUSED — never
 *   silently merged, never last-write-wins.
 *
 * Why a single version on `itineraries` rather than per-item versions:
 * the board is displayed and reasoned about as one object. Two people
 * editing different items on the same day still need to see each other's
 * result, and a per-item version would let the *list* (ordering, day
 * assignment) drift while each item looked individually consistent.
 * The provided schema already gives us `itineraries.version` for exactly
 * this, so we use it as named (Rule R1) rather than adding our own.
 */

import { ConflictError, NotFoundError } from '../lib/errors.js';

/**
 * Load an itinerary FOR UPDATE, proving the caller's expected version.
 *
 * Takes a row lock, so two concurrent transactions serialise here rather
 * than both reading the same version and both believing they won. The
 * lock is held only for the duration of the enclosing transaction.
 *
 * @throws {ConflictError} when the stored version has moved on.
 */
export async function lockItineraryAtVersion(client, itineraryId, expectedVersion) {
  const { rows } = await client.query(
    `SELECT itinerary_id, trip_id, version, status, is_active
       FROM itineraries
      WHERE itinerary_id = $1
      FOR UPDATE`,
    [itineraryId]
  );

  if (rows.length === 0) {
    throw new NotFoundError('itinerary', itineraryId);
  }

  const itinerary = rows[0];

  if (itinerary.status === 'archived') {
    throw new ConflictError('This itinerary is archived and can no longer be edited.', {
      code: 'ITINERARY_ARCHIVED',
      itineraryId
    });
  }

  // `expectedVersion == null` means the caller explicitly opted out of the
  // check (server-initiated writes like applying an accepted proposal, which
  // already hold the lock and know they are authoritative). Client-facing
  // routes must always pass a number — see routes/itinerary.js.
  if (expectedVersion != null && itinerary.version !== expectedVersion) {
    throw new ConflictError(
      'Someone else changed this plan while you were editing. Reload to see their version.',
      {
        code: 'VERSION_CONFLICT',
        itineraryId,
        expectedVersion,
        currentVersion: itinerary.version
      }
    );
  }

  return itinerary;
}

/**
 * Bump the version after a successful mutation. Returns the new version,
 * which every route echoes back so the client can keep editing without a
 * refetch.
 *
 * Deliberately separate from the lock: a handler that locks but makes no
 * change (a no-op edit) should NOT bump, or every reader would be forced
 * into a spurious conflict.
 */
export async function bumpItineraryVersion(client, itineraryId, { recalcTotals = true } = {}) {
  if (recalcTotals) {
    // Totals are derived, so we recompute rather than trusting incremental
    // arithmetic that drifts after enough edits. Scoped to one itinerary and
    // indexed, so this stays cheap.
    await client.query(
      `UPDATE itineraries i
          SET total_cost = COALESCE(agg.cost, 0),
              total_duration_minutes = COALESCE(agg.duration, 0),
              total_carbon_kg = COALESCE(agg.carbon, 0),
              version = i.version + 1,
              updated_at = now()
         FROM (
           SELECT SUM(cost) AS cost,
                  SUM(duration_minutes) AS duration,
                  SUM(carbon_kg) AS carbon
             FROM itinerary_items
            WHERE itinerary_id = $1
              AND status <> 'removed'
         ) agg
        WHERE i.itinerary_id = $1`,
      [itineraryId]
    );
  } else {
    await client.query(
      `UPDATE itineraries
          SET version = version + 1, updated_at = now()
        WHERE itinerary_id = $1`,
      [itineraryId]
    );
  }

  const { rows } = await client.query(
    `SELECT version, total_cost, total_duration_minutes, total_carbon_kg
       FROM itineraries WHERE itinerary_id = $1`,
    [itineraryId]
  );
  return rows[0];
}

/**
 * Resolve the active itinerary for a trip, creating one on first touch.
 *
 * A trip with no itinerary is a real state (trip just created), and the
 * board should not 404 on it. Created with generated_by='user' because a
 * human creating the trip is what caused it.
 */
export async function ensureActiveItinerary(client, tripId, { newId }) {
  const existing = await client.query(
    `SELECT itinerary_id, version FROM itineraries
      WHERE trip_id = $1 AND is_active AND status = 'active'
      ORDER BY created_at DESC LIMIT 1`,
    [tripId]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const trip = await client.query(
    `SELECT title, home_currency FROM trips WHERE trip_id = $1`,
    [tripId]
  );
  if (trip.rows.length === 0) throw new NotFoundError('trip', tripId);

  const { rows } = await client.query(
    `INSERT INTO itineraries (
       itinerary_id, trip_id, name, version, is_active, generated_by,
       total_cost, currency, total_duration_minutes, total_carbon_kg,
       status, created_at, updated_at
     ) VALUES ($1, $2, $3, 1, true, 'user', 0, $4, 0, 0, 'active', now(), now())
     RETURNING itinerary_id, version`,
    [newId, tripId, `${trip.rows[0].title} — plan`, trip.rows[0].home_currency]
  );
  return rows[0];
}

/**
 * Next sort_order within a day. Gaps are fine and expected (deletes leave
 * holes); we only need monotonicity within a day so the board renders in a
 * stable, intentional order.
 */
export async function nextSortOrder(client, itineraryId, dayIndex) {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
       FROM itinerary_items
      WHERE itinerary_id = $1 AND day_index = $2 AND status <> 'removed'`,
    [itineraryId, dayIndex]
  );
  return rows[0].next;
}
