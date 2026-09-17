/**
 * The shared itinerary board — screen 1.
 *
 * Every mutating route here follows the same shape, and the shape is the
 * point:
 *
 *     withTransaction:
 *       lockItineraryAtVersion(expectedVersion)   <- refuses stale writes
 *       ...do the write...
 *       bumpItineraryVersion()                    <- new version for everyone
 *     emitToTrip(...)                             <- after commit, never before
 *
 * Broadcasting AFTER commit matters: if we emitted inside the transaction
 * and it then rolled back, every other client would have rendered a change
 * that does not exist in the database.
 */

import { z } from 'zod';
import { ulid } from 'ulid';
import { withTransaction, pool } from '../db/pool.js';
import { requirePermission } from '../plugins/rbac.js';
import { emitToTrip, EVENTS } from '../realtime/io.js';
import {
  lockItineraryAtVersion,
  bumpItineraryVersion,
  ensureActiveItinerary,
  nextSortOrder
} from '../domain/concurrency.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';

const ItemCreate = z.object({
  itineraryId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  dayIndex: z.number().int().min(0).max(120),
  title: z.string().min(1).max(200),
  itemType: z.enum(['hotel', 'flight', 'poi', 'package', 'guide', 'transfer', 'meal', 'free']),
  entityType: z.string().nullable().optional(),
  entityId: z.string().nullable().optional(),
  cost: z.number().min(0).default(0),
  currency: z.string().length(3),
  durationMinutes: z.number().int().min(0).default(0),
  carbonKg: z.number().min(0).default(0),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  explanation: z.string().max(1000).nullable().optional()
});

const ItemUpdate = z.object({
  expectedVersion: z.number().int().nonnegative(),
  title: z.string().min(1).max(200).optional(),
  dayIndex: z.number().int().min(0).max(120).optional(),
  sortOrder: z.number().int().min(0).optional(),
  cost: z.number().min(0).optional(),
  durationMinutes: z.number().int().min(0).optional(),
  carbonKg: z.number().min(0).optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  locked: z.boolean().optional(),
  status: z.enum(['proposed', 'confirmed', 'removed', 'replaced']).optional()
});

export default async function itineraryRoutes(fastify) {
  /* ---------------------------------------------------------------- */
  /* Read the whole board                                              */
  /* ---------------------------------------------------------------- */
  fastify.get(
    '/trips/:tripId/itinerary',
    { preHandler: requirePermission('trip:read') },
    async request => {
      const { tripId } = request.params;

      const itin = await withTransaction(c =>
        ensureActiveItinerary(c, tripId, { newId: ulid() })
      );

      const [itinerary, items, openProposals] = await Promise.all([
        pool.query(
          `SELECT itinerary_id, trip_id, name, version, total_cost, currency,
                  total_duration_minutes, total_carbon_kg, status, updated_at
             FROM itineraries WHERE itinerary_id = $1`,
          [itin.itinerary_id]
        ),
        pool.query(
          `SELECT item_id, day_index, sort_order, starts_at, ends_at, item_type,
                  entity_type, entity_id, title, cost, currency, carbon_kg,
                  duration_minutes, source, explanation, locked, status, updated_at
             FROM itinerary_items
            WHERE itinerary_id = $1 AND status <> 'removed'
            ORDER BY day_index, sort_order`,
          [itin.itinerary_id]
        ),
        pool.query(
          `SELECT proposal_id, action, target_item_id, title, rationale,
                  cost_delta, currency, closes_at, proposed_by_user_id, status
             FROM proposals
            WHERE itinerary_id = $1 AND status = 'open'
            ORDER BY created_at`,
          [itin.itinerary_id]
        )
      ]);

      if (itinerary.rows.length === 0) throw new NotFoundError('itinerary', itin.itinerary_id);
      const it = itinerary.rows[0];

      // Group into days so the client renders tabs without regrouping.
      const byDay = new Map();
      for (const item of items.rows) {
        if (!byDay.has(item.day_index)) byDay.set(item.day_index, []);
        byDay.get(item.day_index).push({
          ...item,
          cost: Number(item.cost),
          carbon_kg: Number(item.carbon_kg)
        });
      }

      const trip = await pool.query(
        `SELECT start_date, end_date FROM trips WHERE trip_id = $1`, [tripId]
      );
      const { start_date, end_date } = trip.rows[0] ?? {};
      const dayCount = start_date && end_date
        ? Math.max(1, Math.round((Date.parse(end_date) - Date.parse(start_date)) / 86400000) + 1)
        : Math.max(1, byDay.size);

      return {
        itinerary: {
          ...it,
          total_cost: Number(it.total_cost),
          total_carbon_kg: Number(it.total_carbon_kg)
        },
        // The client MUST echo this back on every write. It is the whole
        // conflict-detection contract in one field.
        version: it.version,
        days: Array.from({ length: dayCount }, (_, i) => ({
          dayIndex: i,
          items: byDay.get(i) ?? []
        })),
        openProposals: openProposals.rows.map(p => ({ ...p, cost_delta: Number(p.cost_delta) })),
        yourRole: request.membership.role
      };
    }
  );

  /* ---------------------------------------------------------------- */
  /* Create an item                                                    */
  /* ---------------------------------------------------------------- */
  fastify.post(
    '/trips/:tripId/itinerary/items',
    { preHandler: requirePermission('item:create') },
    async (request, reply) => {
      const body = ItemCreate.parse(request.body);
      const userId = request.user.sub;
      const { tripId } = request.params;

      const result = await withTransaction(async c => {
        await lockItineraryAtVersion(c, body.itineraryId, body.expectedVersion);

        const sortOrder = await nextSortOrder(c, body.itineraryId, body.dayIndex);
        const itemId = ulid();

        const { rows } = await c.query(
          `INSERT INTO itinerary_items (
             item_id, itinerary_id, day_index, sort_order, starts_at, ends_at,
             item_type, entity_type, entity_id, title, cost, currency, carbon_kg,
             duration_minutes, source, explanation, locked, status,
             created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'user',$15,false,'confirmed',now(),now())
           RETURNING *`,
          [
            itemId, body.itineraryId, body.dayIndex, sortOrder,
            body.startsAt ?? null, body.endsAt ?? null,
            body.itemType, body.entityType ?? null, body.entityId ?? null,
            body.title, body.cost, body.currency, body.carbonKg,
            body.durationMinutes, body.explanation ?? null
          ]
        );

        const totals = await bumpItineraryVersion(c, body.itineraryId);
        return { item: rows[0], totals };
      });

      emitToTrip(tripId, EVENTS.ITEM_CREATED, {
        itineraryId: body.itineraryId,
        item: { ...result.item, cost: Number(result.item.cost) },
        version: result.totals.version
      }, { actorUserId: userId });

      reply.code(201);
      return { item: result.item, version: result.totals.version, totals: result.totals };
    }
  );

  /* ---------------------------------------------------------------- */
  /* Update an item                                                    */
  /* ---------------------------------------------------------------- */
  fastify.patch(
    '/trips/:tripId/itinerary/items/:itemId',
    { preHandler: requirePermission('item:update') },
    async request => {
      const body = ItemUpdate.parse(request.body);
      const { tripId, itemId } = request.params;
      const userId = request.user.sub;

      const result = await withTransaction(async c => {
        const owner = await c.query(
          `SELECT itinerary_id, locked FROM itinerary_items WHERE item_id = $1`,
          [itemId]
        );
        if (owner.rows.length === 0) throw new NotFoundError('itinerary item', itemId);

        await lockItineraryAtVersion(c, owner.rows[0].itinerary_id, body.expectedVersion);

        // A locked item is a group decision that someone deliberately
        // pinned. Unlocking is its own explicit action, not a side effect
        // of editing.
        if (owner.rows[0].locked && body.locked !== false) {
          throw new ValidationError('This item is locked. Unlock it before editing.', { itemId });
        }

        const sets = [];
        const values = [];
        let n = 1;
        const map = {
          title: 'title', dayIndex: 'day_index', sortOrder: 'sort_order',
          cost: 'cost', durationMinutes: 'duration_minutes', carbonKg: 'carbon_kg',
          startsAt: 'starts_at', endsAt: 'ends_at', locked: 'locked', status: 'status'
        };
        for (const [key, col] of Object.entries(map)) {
          if (body[key] !== undefined) {
            sets.push(`${col} = $${n++}`);
            values.push(body[key]);
          }
        }
        if (sets.length === 0) {
          throw new ValidationError('No fields to update.');
        }
        sets.push('updated_at = now()');
        values.push(itemId);

        const { rows } = await c.query(
          `UPDATE itinerary_items SET ${sets.join(', ')} WHERE item_id = $${n} RETURNING *`,
          values
        );

        const totals = await bumpItineraryVersion(c, owner.rows[0].itinerary_id);
        return { item: rows[0], totals, itineraryId: owner.rows[0].itinerary_id };
      });

      emitToTrip(tripId, EVENTS.ITEM_UPDATED, {
        itineraryId: result.itineraryId,
        item: { ...result.item, cost: Number(result.item.cost) },
        version: result.totals.version
      }, { actorUserId: userId });

      return { item: result.item, version: result.totals.version, totals: result.totals };
    }
  );

  /* ---------------------------------------------------------------- */
  /* Delete (soft) an item                                             */
  /* ---------------------------------------------------------------- */
  fastify.delete(
    '/trips/:tripId/itinerary/items/:itemId',
    { preHandler: requirePermission('item:delete') },
    async request => {
      const expectedVersion = Number(request.query.expectedVersion);
      if (!Number.isInteger(expectedVersion)) {
        throw new ValidationError('expectedVersion query parameter is required.');
      }
      const { tripId, itemId } = request.params;
      const userId = request.user.sub;

      const result = await withTransaction(async c => {
        const owner = await c.query(
          `SELECT itinerary_id FROM itinerary_items WHERE item_id = $1`, [itemId]
        );
        if (owner.rows.length === 0) throw new NotFoundError('itinerary item', itemId);

        await lockItineraryAtVersion(c, owner.rows[0].itinerary_id, expectedVersion);

        // Soft delete: `status = 'removed'` is in the provided CHECK
        // constraint, and a proposal may still reference this item via
        // target_item_id. Hard-deleting would orphan that FK.
        await c.query(
          `UPDATE itinerary_items SET status = 'removed', updated_at = now()
            WHERE item_id = $1`,
          [itemId]
        );

        const totals = await bumpItineraryVersion(c, owner.rows[0].itinerary_id);
        return { totals, itineraryId: owner.rows[0].itinerary_id };
      });

      emitToTrip(tripId, EVENTS.ITEM_DELETED, {
        itineraryId: result.itineraryId,
        itemId,
        version: result.totals.version
      }, { actorUserId: userId });

      return { ok: true, version: result.totals.version, totals: result.totals };
    }
  );

  /* ---------------------------------------------------------------- */
  /* Reorder within/across days — one transaction, one version bump    */
  /* ---------------------------------------------------------------- */
  fastify.post(
    '/trips/:tripId/itinerary/reorder',
    { preHandler: requirePermission('item:update') },
    async request => {
      const schema = z.object({
        itineraryId: z.string(),
        expectedVersion: z.number().int(),
        moves: z.array(z.object({
          itemId: z.string(),
          dayIndex: z.number().int().min(0),
          sortOrder: z.number().int().min(0)
        })).min(1).max(200)
      });
      const body = schema.parse(request.body);
      const { tripId } = request.params;
      const userId = request.user.sub;

      const result = await withTransaction(async c => {
        await lockItineraryAtVersion(c, body.itineraryId, body.expectedVersion);

        // A drag-and-drop reorder is one user action, so it is one version
        // bump — not one per moved card, which would make every other
        // client conflict mid-drag.
        for (const move of body.moves) {
          await c.query(
            `UPDATE itinerary_items
                SET day_index = $1, sort_order = $2, updated_at = now()
              WHERE item_id = $3 AND itinerary_id = $4`,
            [move.dayIndex, move.sortOrder, move.itemId, body.itineraryId]
          );
        }

        const totals = await bumpItineraryVersion(c, body.itineraryId, { recalcTotals: false });
        return { totals };
      });

      emitToTrip(tripId, EVENTS.ITINERARY_VERSION, {
        itineraryId: body.itineraryId,
        moves: body.moves,
        version: result.totals.version
      }, { actorUserId: userId });

      return { ok: true, version: result.totals.version };
    }
  );
}
