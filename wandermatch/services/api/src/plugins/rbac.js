/**
 * Role-based access control, resolved from `trip_members.role`.
 *
 * The provided schema's roles are owner / editor / viewer. The design doc
 * maps them to "who can edit vs who can only vote" — note that viewers CAN
 * vote. That is the interesting part of this model and worth stating: a
 * viewer is not a spectator, they are a participant who cannot unilaterally
 * change the plan. Voting is voice; editing is authority.
 */

import { pool } from '../db/pool.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';

export const PERMISSIONS = Object.freeze({
  owner: new Set([
    'trip:read', 'trip:update', 'trip:archive',
    'member:invite', 'member:remove', 'member:set_role',
    'item:create', 'item:update', 'item:delete',
    'proposal:create', 'proposal:close', 'proposal:apply',
    'vote:cast',
    'consensus:accept', 'consensus:override',
    'join_request:decide',
    'photo:upload', 'photo:delete',
    'face:label', 'face:consent'
  ]),
  editor: new Set([
    'trip:read',
    'item:create', 'item:update', 'item:delete',
    'proposal:create',
    'vote:cast',
    'photo:upload',
    'face:label', 'face:consent'
  ]),
  viewer: new Set([
    'trip:read',
    'proposal:create',   // can raise a proposal — that is the whole point
    'vote:cast',         // has a voice
    'photo:upload',
    'face:consent'       // consent is always yours to give or withdraw
  ])
});

/**
 * Resolve a user's membership of a trip. Returns null for non-members so
 * callers can distinguish "not allowed" from "does not exist" where that
 * distinction is safe to expose.
 */
export async function getMembership(tripId, userId, client = pool) {
  const { rows } = await client.query(
    `SELECT member_id, trip_id, user_id, role, share_weight, status
       FROM trip_members
      WHERE trip_id = $1 AND user_id = $2 AND status = 'active'`,
    [tripId, userId]
  );
  return rows[0] ?? null;
}

export function can(role, permission) {
  return PERMISSIONS[role]?.has(permission) ?? false;
}

/**
 * Fastify preHandler factory.
 *
 * Attaches `request.membership` on success. Resolving the trip id from
 * several possible places keeps route definitions tidy — an itinerary or
 * proposal id is enough, we walk back to the trip ourselves.
 */
export function requirePermission(permission, { tripIdFrom = 'params.tripId' } = {}) {
  return async function rbacPreHandler(request) {
    const userId = request.user?.sub;
    if (!userId) throw new ForbiddenError('Sign in to continue.');

    const tripId = await resolveTripId(request, tripIdFrom);
    if (!tripId) throw new NotFoundError('trip', null);

    const membership = await getMembership(tripId, userId);
    if (!membership) {
      // Deliberately a 403 with no trip detail: membership of someone
      // else's trip is not information a stranger should be able to probe.
      throw new ForbiddenError('You are not a member of this trip.');
    }

    if (!can(membership.role, permission)) {
      throw new ForbiddenError(
        `Your role on this trip (${membership.role}) cannot ${permission.replace(':', ' ')}.`,
        { role: membership.role, permission }
      );
    }

    request.membership = membership;
    request.tripId = tripId;
  };
}

async function resolveTripId(request, spec) {
  const [bag, key] = spec.split('.');
  const direct = request[bag]?.[key];

  if (spec === 'params.tripId' || spec === 'body.tripId') return direct ?? null;

  if (spec === 'params.itineraryId') {
    const { rows } = await pool.query(
      `SELECT trip_id FROM itineraries WHERE itinerary_id = $1`, [direct]
    );
    return rows[0]?.trip_id ?? null;
  }

  if (spec === 'params.proposalId') {
    const { rows } = await pool.query(
      `SELECT i.trip_id
         FROM proposals p JOIN itineraries i ON i.itinerary_id = p.itinerary_id
        WHERE p.proposal_id = $1`, [direct]
    );
    return rows[0]?.trip_id ?? null;
  }

  if (spec === 'params.itemId') {
    const { rows } = await pool.query(
      `SELECT i.trip_id
         FROM itinerary_items it JOIN itineraries i ON i.itinerary_id = it.itinerary_id
        WHERE it.item_id = $1`, [direct]
    );
    return rows[0]?.trip_id ?? null;
  }

  if (spec === 'params.photoId') {
    const { rows } = await pool.query(
      `SELECT trip_id FROM trip_photos WHERE photo_id = $1`, [direct]
    );
    return rows[0]?.trip_id ?? null;
  }

  return direct ?? null;
}
