/**
 * Trip creation, membership and roles — the entry point for everything else.
 */
import { z } from 'zod';
import { ulid } from 'ulid';
import { pool, withTransaction } from '../db/pool.js';
import { requirePermission, getMembership } from '../plugins/rbac.js';
import { emitToTrip, EVENTS } from '../realtime/io.js';
import { ensureActiveItinerary } from '../domain/concurrency.js';
import { NotFoundError, ValidationError, ForbiddenError } from '../lib/errors.js';

const TripCreate = z.object({
  title: z.string().min(1).max(160),
  destinationCityId: z.string().min(1),
  originCityId: z.string().nullable().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  partySize: z.number().int().min(1).max(50),
  adults: z.number().int().min(1).max(50).default(1),
  children: z.number().int().min(0).max(20).default(0),
  tripType: z.enum(['solo','couple','family','business','friends','senior','backpacker']).default('friends'),
  isGroupTrip: z.boolean().default(true),
  homeCurrency: z.string().length(3).default('INR'),
  notes: z.string().max(2000).nullable().optional(),
  invites: z.array(z.object({
    userId: z.string(),
    role: z.enum(['editor', 'viewer']).default('viewer'),
    shareWeight: z.number().min(0).max(10).default(1)
  })).max(40).default([])
});

export default async function tripRoutes(fastify) {
  fastify.post('/trips', async (request, reply) => {
    const body = TripCreate.parse(request.body);
    const userId = request.user.sub;

    if (Date.parse(body.endDate) < Date.parse(body.startDate)) {
      throw new ValidationError('The trip cannot end before it starts.');
    }

    const result = await withTransaction(async c => {
      const tripId = ulid();

      const { rows } = await c.query(
        `INSERT INTO trips (
           trip_id, owner_user_id, title, origin_city_id, destination_city_id,
           start_date, end_date, party_size, adults, children, trip_type,
           is_group_trip, status, home_currency, notes, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'planning',$13,$14,now(),now())
         RETURNING *`,
        [
          tripId, userId, body.title, body.originCityId ?? null, body.destinationCityId,
          body.startDate, body.endDate, body.partySize, body.adults, body.children,
          body.tripType, body.isGroupTrip, body.homeCurrency, body.notes ?? null
        ]
      );

      // The creator is the owner. Always inserted first so a trip can never
      // exist without someone able to administer it.
      await c.query(
        `INSERT INTO trip_members (
           member_id, trip_id, user_id, role, joined_at, share_weight,
           invited_by_user_id, status, updated_at
         ) VALUES ($1,$2,$3,'owner',now(),1,NULL,'active',now())`,
        [ulid(), tripId, userId]
      );

      for (const invite of body.invites) {
        if (invite.userId === userId) continue;
        await c.query(
          `INSERT INTO trip_members (
             member_id, trip_id, user_id, role, joined_at, share_weight,
             invited_by_user_id, status, updated_at
           ) VALUES ($1,$2,$3,$4,now(),$5,$6,'active',now())
           ON CONFLICT (trip_id, user_id) DO NOTHING`,
          [ulid(), tripId, invite.userId, invite.role, invite.shareWeight, userId]
        );
      }

      const itinerary = await ensureActiveItinerary(c, tripId, { newId: ulid() });
      return { trip: rows[0], itinerary };
    });

    reply.code(201);
    return result;
  });

  fastify.get('/trips', async request => {
    const { rows } = await pool.query(
      `SELECT t.*, tm.role, c.name AS destination_name,
              (SELECT COUNT(*) FROM trip_members m WHERE m.trip_id = t.trip_id AND m.status='active') AS member_count
         FROM trips t
         JOIN trip_members tm ON tm.trip_id = t.trip_id AND tm.user_id = $1 AND tm.status='active'
         LEFT JOIN cities c ON c.city_id = t.destination_city_id
        WHERE t.status <> 'cancelled'
        ORDER BY t.start_date DESC
        LIMIT 100`,
      [request.user.sub]
    );
    return { trips: rows };
  });

  fastify.get('/trips/:tripId',
    { preHandler: requirePermission('trip:read') },
    async request => {
      const { tripId } = request.params;
      const [trip, members] = await Promise.all([
        pool.query(
          `SELECT t.*, c.name AS destination_name, cur.symbol AS currency_symbol
             FROM trips t
             LEFT JOIN cities c ON c.city_id = t.destination_city_id
             LEFT JOIN currencies cur ON cur.iso4217 = t.home_currency
            WHERE t.trip_id = $1`,
          [tripId]
        ),
        pool.query(
          `SELECT tm.member_id, tm.user_id, tm.role, tm.share_weight, tm.joined_at,
                  u.display_name, u.locale, u.budget_band, u.travel_style
             FROM trip_members tm
             JOIN users u ON u.user_id = tm.user_id
            WHERE tm.trip_id = $1 AND tm.status = 'active'
            ORDER BY tm.joined_at`,
          [tripId]
        )
      ]);
      if (trip.rows.length === 0) throw new NotFoundError('trip', tripId);
      return {
        trip: trip.rows[0],
        members: members.rows,
        yourRole: request.membership.role
      };
    }
  );

  fastify.put('/trips/:tripId/members/:userId/role',
    { preHandler: requirePermission('member:set_role') },
    async request => {
      const { role } = z.object({ role: z.enum(['owner','editor','viewer']) }).parse(request.body);
      const { tripId, userId: targetUserId } = request.params;
      const actor = request.user.sub;

      if (targetUserId === actor && role !== 'owner') {
        // Preventing self-demotion is not paternalism: an owner who
        // demotes themselves on a trip with no other owner locks the trip
        // out of administration permanently.
        const owners = await pool.query(
          `SELECT COUNT(*)::int AS n FROM trip_members
            WHERE trip_id = $1 AND role = 'owner' AND status = 'active'`,
          [tripId]
        );
        if (owners.rows[0].n <= 1) {
          throw new ForbiddenError('Promote another owner before changing your own role.');
        }
      }

      const { rows } = await pool.query(
        `UPDATE trip_members SET role = $1, updated_at = now()
          WHERE trip_id = $2 AND user_id = $3 AND status = 'active'
          RETURNING member_id, user_id, role`,
        [role, tripId, targetUserId]
      );
      if (rows.length === 0) throw new NotFoundError('trip member', targetUserId);

      emitToTrip(tripId, EVENTS.MEMBER_ROLE_CHANGED, {
        userId: targetUserId, role
      }, { actorUserId: actor });

      return { member: rows[0] };
    }
  );

  fastify.post('/trips/:tripId/members',
    { preHandler: requirePermission('member:invite') },
    async (request, reply) => {
      const body = z.object({
        userId: z.string(),
        role: z.enum(['editor','viewer']).default('viewer'),
        shareWeight: z.number().min(0).max(10).default(1)
      }).parse(request.body);
      const { tripId } = request.params;

      const existing = await getMembership(tripId, body.userId);
      if (existing) throw new ValidationError('That person is already on this trip.');

      const { rows } = await pool.query(
        `INSERT INTO trip_members (
           member_id, trip_id, user_id, role, joined_at, share_weight,
           invited_by_user_id, status, updated_at
         ) VALUES ($1,$2,$3,$4,now(),$5,$6,'active',now())
         RETURNING member_id, user_id, role, share_weight`,
        [ulid(), tripId, body.userId, body.role, body.shareWeight, request.user.sub]
      );

      emitToTrip(tripId, EVENTS.MEMBER_JOINED, { member: rows[0] }, { actorUserId: request.user.sub });
      reply.code(201);
      return { member: rows[0] };
    }
  );

  /**
   * Archiving is where the privacy promise is kept. Photos, face groups
   * and the embedding index all go together — see routes/photos.js.
   */
  fastify.post('/trips/:tripId/archive',
    { preHandler: requirePermission('trip:archive') },
    async request => {
      const { tripId } = request.params;
      const { purgeTripIndex } = await import('../lib/faceClient.js');
      const { deleteObject } = await import('../lib/s3.js');

      const photos = await pool.query(
        `SELECT storage_key FROM trip_photos WHERE trip_id = $1`, [tripId]
      );

      await withTransaction(async c => {
        await c.query(
          `UPDATE trips SET status = 'completed', updated_at = now() WHERE trip_id = $1`,
          [tripId]
        );
        await c.query(`DELETE FROM face_groups WHERE trip_id = $1`, [tripId]);
        await c.query(`DELETE FROM trip_photos WHERE trip_id = $1`, [tripId]);
      });

      await Promise.allSettled([
        purgeTripIndex(tripId),
        ...photos.rows.map(p => deleteObject(p.storage_key))
      ]);

      return { ok: true, photosDeleted: photos.rows.length };
    }
  );
}
