/**
 * Solo-to-group matching and the request-to-join flow.
 */
import { z } from 'zod';
import { ulid } from 'ulid';
import { pool, withTransaction } from '../db/pool.js';
import { findMatches, WEIGHTS } from '../domain/matching.js';
import { requirePermission } from '../plugins/rbac.js';
import { emitToTrip, EVENTS } from '../realtime/io.js';
import { NotFoundError, ValidationError, ConflictError } from '../lib/errors.js';

export default async function matchingRoutes(fastify) {
  fastify.post('/matching/search', async request => {
    const body = z.object({
      destinationCityId: z.string().nullable().optional(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      interests: z.array(z.string()).max(30).optional(),
      pace: z.string().nullable().optional(),
      budgetBand: z.string().nullable().optional(),
      limit: z.number().int().min(1).max(25).default(10),
      refresh: z.boolean().default(false)
    }).parse(request.body);

    const userId = request.user.sub;

    // Fall back to the user's stored preferences for anything they did not
    // override on the form — the provided schema already has this data, so
    // making them retype it would be pointless friction.
    const prefs = await pool.query(
      `SELECT up.interests, up.pace, u.budget_band
         FROM users u LEFT JOIN user_preferences up ON up.user_id = u.user_id
        WHERE u.user_id = $1`,
      [userId]
    );
    const p = prefs.rows[0] ?? {};

    const solo = {
      userId,
      destinationCityId: body.destinationCityId ?? null,
      startDate: body.startDate ?? null,
      endDate: body.endDate ?? null,
      interests: body.interests?.length
        ? body.interests
        : (p.interests ? String(p.interests).split(/[,|]/).map(s => s.trim()).filter(Boolean) : []),
      pace: body.pace ?? p.pace ?? null,
      budgetBand: body.budgetBand ?? p.budget_band ?? null
    };

    const result = await withTransaction(c =>
      findMatches(c, solo, { limit: body.limit, useCache: !body.refresh })
    );

    return { ...result, weights: WEIGHTS, inputs: solo };
  });

  fastify.post('/trips/:tripId/join-requests', async (request, reply) => {
    const body = z.object({
      message: z.string().max(500).nullable().optional(),
      matchScoreId: z.string().nullable().optional()
    }).parse(request.body);
    const { tripId } = request.params;
    const userId = request.user.sub;

    const trip = await pool.query(
      `SELECT t.trip_id, t.owner_user_id, t.party_size, t.is_group_trip, t.status,
              (SELECT COUNT(*) FROM trip_members m
                WHERE m.trip_id = t.trip_id AND m.status='active')::int AS member_count
         FROM trips t WHERE t.trip_id = $1`,
      [tripId]
    );
    if (trip.rows.length === 0) throw new NotFoundError('trip', tripId);
    const t = trip.rows[0];

    if (!t.is_group_trip) throw new ValidationError('That trip is not open to others.');
    if (t.member_count >= t.party_size) throw new ConflictError('That trip is already full.');

    const { rows } = await pool.query(
      `INSERT INTO join_requests (request_id, trip_id, user_id, message, match_score_id, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'pending',now(),now())
       ON CONFLICT (trip_id, user_id)
       DO UPDATE SET message = EXCLUDED.message, status = 'pending', updated_at = now()
       RETURNING *`,
      [ulid(), tripId, userId, body.message ?? null, body.matchScoreId ?? null]
    );

    emitToTrip(tripId, EVENTS.JOIN_REQUEST_CREATED, {
      request: rows[0]
    }, { actorUserId: userId });

    reply.code(201);
    return { request: rows[0] };
  });

  fastify.post('/trips/:tripId/join-requests/:requestId/decide',
    { preHandler: requirePermission('join_request:decide') },
    async request => {
      const { decision, role } = z.object({
        decision: z.enum(['approve', 'reject']),
        role: z.enum(['editor', 'viewer']).default('editor')
      }).parse(request.body);
      const { tripId, requestId } = request.params;
      const actor = request.user.sub;

      const result = await withTransaction(async c => {
        const req = await c.query(
          `SELECT * FROM join_requests WHERE request_id = $1 AND trip_id = $2 FOR UPDATE`,
          [requestId, tripId]
        );
        if (req.rows.length === 0) throw new NotFoundError('join request', requestId);
        if (req.rows[0].status !== 'pending') {
          throw new ConflictError('That request was already decided.');
        }

        await c.query(
          `UPDATE join_requests SET status = $1, decided_by_user_id = $2, decided_at = now(), updated_at = now()
            WHERE request_id = $3`,
          [decision === 'approve' ? 'approved' : 'rejected', actor, requestId]
        );

        if (decision !== 'approve') return { member: null };

        // Capacity is re-checked inside the transaction: two owners
        // approving two requests at once must not overfill the trip.
        const cap = await c.query(
          `SELECT t.party_size,
                  (SELECT COUNT(*) FROM trip_members m
                    WHERE m.trip_id = t.trip_id AND m.status='active')::int AS member_count
             FROM trips t WHERE t.trip_id = $1 FOR UPDATE`,
          [tripId]
        );
        if (cap.rows[0].member_count >= cap.rows[0].party_size) {
          throw new ConflictError('The trip filled up before this was approved.');
        }

        const { rows } = await c.query(
          `INSERT INTO trip_members (
             member_id, trip_id, user_id, role, joined_at, share_weight,
             invited_by_user_id, status, updated_at
           ) VALUES ($1,$2,$3,$4,now(),1,$5,'active',now())
           ON CONFLICT (trip_id, user_id) DO UPDATE SET status='active', role=EXCLUDED.role
           RETURNING member_id, user_id, role`,
          [ulid(), tripId, req.rows[0].user_id, role, actor]
        );
        return { member: rows[0] };
      });

      if (result.member) {
        emitToTrip(tripId, EVENTS.MEMBER_JOINED, { member: result.member }, { actorUserId: actor });
      }
      return { ok: true, decision, member: result.member };
    }
  );

  fastify.get('/trips/:tripId/join-requests',
    { preHandler: requirePermission('join_request:decide') },
    async request => {
      const { rows } = await pool.query(
        `SELECT jr.*, u.display_name, ms.total_score,
                ms.interest_score, ms.date_score, ms.pace_score, ms.budget_score
           FROM join_requests jr
           JOIN users u ON u.user_id = jr.user_id
           LEFT JOIN match_scores ms ON ms.match_score_id = jr.match_score_id
          WHERE jr.trip_id = $1 AND jr.status = 'pending'
          ORDER BY ms.total_score DESC NULLS LAST, jr.created_at`,
        [request.params.tripId]
      );
      return { requests: rows };
    }
  );
}
