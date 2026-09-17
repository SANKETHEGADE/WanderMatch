/**
 * Proposals and votes — screen 2, and the trigger for the AI path.
 *
 * The flow this file implements, end to end:
 *
 *   POST /proposals          raise a change instead of editing directly
 *   POST /proposals/:id/vote cast yes|no|abstain with an optional comment
 *        -> tally
 *        -> decideProposalOutcome
 *            'accept'    -> applyProposal   (version-checked, broadcast)
 *            'reject'    -> close it
 *            'consensus' -> generate + validate recommendation, broadcast
 *   POST /proposals/:id/consensus/:recId/accept|override
 *
 * Note where the AI is invoked: here, server-side, off the back of a vote.
 * Never by the client. The client only ever receives the validated result.
 */

import { z } from 'zod';
import { ulid } from 'ulid';
import { withTransaction, pool } from '../db/pool.js';
import { requirePermission } from '../plugins/rbac.js';
import { emitToTrip, EVENTS } from '../realtime/io.js';
import { tallyProposal, decideProposalOutcome } from '../domain/tally.js';
import { generateConsensusRecommendation } from '../domain/consensus.js';
import {
  lockItineraryAtVersion, bumpItineraryVersion, nextSortOrder
} from '../domain/concurrency.js';
import { NotFoundError, ValidationError, ConflictError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ mod: 'proposals' });

const ProposalCreate = z.object({
  itineraryId: z.string().min(1),
  action: z.enum(['add', 'remove', 'replace', 'reschedule']),
  targetItemId: z.string().nullable().optional(),
  title: z.string().min(1).max(200),
  rationale: z.string().max(1000).nullable().optional(),
  costDelta: z.number().default(0),
  currency: z.string().length(3),
  dayIndex: z.number().int().min(0).max(120).nullable().optional(),
  itemType: z.enum(['hotel','flight','poi','package','guide','transfer','meal','free']).default('poi'),
  durationMinutes: z.number().int().min(0).default(0),
  closesInMinutes: z.number().int().min(1).max(10080).default(1440)
});

const VoteCast = z.object({
  value: z.enum(['yes', 'no', 'abstain']),
  weight: z.number().min(0).max(10).default(1),
  comment: z.string().max(500).nullable().optional()
});

/**
 * Apply an accepted proposal to the itinerary.
 *
 * Runs inside the caller's transaction and holds the itinerary lock, so
 * `expectedVersion` is passed as null deliberately — we are the authority
 * here, and there is no user-held version to compare against.
 */
async function applyProposal(client, tally) {
  const itineraryId = tally.itineraryId;

  const proposal = await client.query(
    `SELECT * FROM proposals WHERE proposal_id = $1`, [tally.proposalId]
  );
  const p = proposal.rows[0];
  if (!p) throw new NotFoundError('proposal', tally.proposalId);

  await lockItineraryAtVersion(client, itineraryId, null);

  let affectedItemId = null;

  if (p.action === 'add') {
    const dayIndex = p.day_index ?? 0;
    const sortOrder = await nextSortOrder(client, itineraryId, dayIndex);
    affectedItemId = ulid();
    await client.query(
      `INSERT INTO itinerary_items (
         item_id, itinerary_id, day_index, sort_order, item_type, entity_type, entity_id,
         title, cost, currency, carbon_kg, duration_minutes, source, explanation,
         locked, status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'poi',$5,$6,$7,$8,$9,0,0,'vote',$10,false,'confirmed',now(),now())`,
      [
        affectedItemId, itineraryId, dayIndex, sortOrder,
        p.entity_type, p.entity_id, p.title,
        Math.max(0, Number(p.cost_delta)), p.currency,
        `Added by group vote on proposal ${p.proposal_id}`
      ]
    );
  } else if (p.action === 'remove' && p.target_item_id) {
    affectedItemId = p.target_item_id;
    await client.query(
      `UPDATE itinerary_items SET status = 'removed', updated_at = now()
        WHERE item_id = $1`,
      [p.target_item_id]
    );
  } else if (p.action === 'replace' && p.target_item_id) {
    affectedItemId = p.target_item_id;
    // 'replaced' rather than 'removed' so the history reads correctly:
    // this item did not just vanish, the group swapped it for something.
    await client.query(
      `UPDATE itinerary_items SET status = 'replaced', updated_at = now()
        WHERE item_id = $1`,
      [p.target_item_id]
    );
    const old = await client.query(
      `SELECT day_index, currency FROM itinerary_items WHERE item_id = $1`,
      [p.target_item_id]
    );
    const dayIndex = old.rows[0]?.day_index ?? 0;
    const sortOrder = await nextSortOrder(client, itineraryId, dayIndex);
    const newId = ulid();
    await client.query(
      `INSERT INTO itinerary_items (
         item_id, itinerary_id, day_index, sort_order, item_type, title, cost, currency,
         carbon_kg, duration_minutes, source, explanation, locked, status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'poi',$5,$6,$7,0,0,'vote',$8,false,'confirmed',now(),now())`,
      [
        newId, itineraryId, dayIndex, sortOrder, p.title,
        Math.max(0, Number(p.cost_delta)), p.currency,
        `Replaced item ${p.target_item_id} by group vote`
      ]
    );
    affectedItemId = newId;
  } else if (p.action === 'reschedule' && p.target_item_id) {
    affectedItemId = p.target_item_id;
    if (p.day_index != null) {
      const sortOrder = await nextSortOrder(client, itineraryId, p.day_index);
      await client.query(
        `UPDATE itinerary_items SET day_index = $1, sort_order = $2, updated_at = now()
          WHERE item_id = $3`,
        [p.day_index, sortOrder, p.target_item_id]
      );
    }
  }

  await client.query(
    `UPDATE proposals SET status = 'accepted', updated_at = now() WHERE proposal_id = $1`,
    [tally.proposalId]
  );

  const totals = await bumpItineraryVersion(client, itineraryId);
  return { affectedItemId, totals };
}

export default async function proposalRoutes(fastify) {
  /* ---------------------------------------------------------------- */
  fastify.post(
    '/trips/:tripId/proposals',
    { preHandler: requirePermission('proposal:create') },
    async (request, reply) => {
      const body = ProposalCreate.parse(request.body);
      const { tripId } = request.params;
      const userId = request.user.sub;

      if (['remove', 'replace', 'reschedule'].includes(body.action) && !body.targetItemId) {
        throw new ValidationError(`A "${body.action}" proposal must name the item it targets.`);
      }

      const proposalId = ulid();
      const closesAt = new Date(Date.now() + body.closesInMinutes * 60_000);

      const { rows } = await pool.query(
        `INSERT INTO proposals (
           proposal_id, itinerary_id, proposed_by_user_id, action, target_item_id,
           entity_type, entity_id, title, rationale, cost_delta, currency,
           closes_at, status, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,NULL,NULL,$6,$7,$8,$9,$10,'open',now(),now())
         RETURNING *`,
        [
          proposalId, body.itineraryId, userId, body.action, body.targetItemId ?? null,
          body.title, body.rationale ?? null, body.costDelta, body.currency, closesAt
        ]
      );

      // The proposer's own yes-vote is implicit: you proposed it, you're for
      // it. Making them click again is friction that produces phantom ties.
      await pool.query(
        `INSERT INTO votes (vote_id, proposal_id, user_id, value, weight, comment, cast_at, updated_at)
         VALUES ($1,$2,$3,'yes',1,$4,now(),now())
         ON CONFLICT (proposal_id, user_id) DO NOTHING`,
        [ulid(), proposalId, userId, body.rationale ?? null]
      );

      const tally = await tallyProposal(pool, proposalId);

      emitToTrip(tripId, EVENTS.PROPOSAL_CREATED, {
        proposal: { ...rows[0], cost_delta: Number(rows[0].cost_delta) },
        tally
      }, { actorUserId: userId });

      reply.code(201);
      return { proposal: rows[0], tally };
    }
  );

  /* ---------------------------------------------------------------- */
  fastify.get(
    '/trips/:tripId/proposals',
    { preHandler: requirePermission('trip:read') },
    async request => {
      const { tripId } = request.params;
      const status = request.query.status ?? 'open';

      const { rows } = await pool.query(
        `SELECT p.*, u.display_name AS proposer_name
           FROM proposals p
           JOIN itineraries i ON i.itinerary_id = p.itinerary_id
           JOIN users u ON u.user_id = p.proposed_by_user_id
          WHERE i.trip_id = $1 AND ($2 = 'all' OR p.status = $2)
          ORDER BY p.created_at DESC
          LIMIT 100`,
        [tripId, status]
      );

      const withTallies = [];
      for (const p of rows) {
        withTallies.push({
          ...p,
          cost_delta: Number(p.cost_delta),
          tally: await tallyProposal(pool, p.proposal_id)
        });
      }
      return { proposals: withTallies };
    }
  );

  /* ---------------------------------------------------------------- */
  /* Cast a vote — and resolve if this was the deciding one             */
  /* ---------------------------------------------------------------- */
  fastify.post(
    '/trips/:tripId/proposals/:proposalId/vote',
    { preHandler: requirePermission('vote:cast', { tripIdFrom: 'params.proposalId' }) },
    async request => {
      const body = VoteCast.parse(request.body);
      const { proposalId } = request.params;
      const tripId = request.tripId;
      const userId = request.user.sub;

      const outcome = await withTransaction(async c => {
        const proposal = await c.query(
          `SELECT status, closes_at FROM proposals WHERE proposal_id = $1 FOR UPDATE`,
          [proposalId]
        );
        if (proposal.rows.length === 0) throw new NotFoundError('proposal', proposalId);
        if (proposal.rows[0].status !== 'open') {
          throw new ConflictError('This proposal is already closed.', { code: 'PROPOSAL_CLOSED' });
        }

        // Upsert: changing your mind is normal and should not create a
        // second ballot. UNIQUE (proposal_id, user_id) enforces it too.
        await c.query(
          `INSERT INTO votes (vote_id, proposal_id, user_id, value, weight, comment, cast_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,now(),now())
           ON CONFLICT (proposal_id, user_id)
           DO UPDATE SET value = EXCLUDED.value,
                         weight = EXCLUDED.weight,
                         comment = EXCLUDED.comment,
                         updated_at = now()`,
          [ulid(), proposalId, userId, body.value, body.weight, body.comment ?? null]
        );

        return decideProposalOutcome(c, proposalId);
      });

      emitToTrip(tripId, EVENTS.VOTE_CAST, {
        proposalId,
        userId,
        value: body.value,
        tally: outcome.tally
      }, { actorUserId: userId });

      /* --- clear majority: apply immediately --- */
      if (outcome.kind === 'accept') {
        const applied = await withTransaction(c => applyProposal(c, outcome.tally));
        emitToTrip(tripId, EVENTS.PROPOSAL_RESOLVED, {
          proposalId,
          resolution: 'accepted',
          affectedItemId: applied.affectedItemId,
          version: applied.totals.version
        }, { actorUserId: userId });
        return { outcome: 'accepted', tally: outcome.tally, version: applied.totals.version };
      }

      /* --- clearly rejected --- */
      if (outcome.kind === 'reject') {
        await pool.query(
          `UPDATE proposals SET status = 'rejected', updated_at = now() WHERE proposal_id = $1`,
          [proposalId]
        );
        emitToTrip(tripId, EVENTS.PROPOSAL_RESOLVED, {
          proposalId, resolution: 'rejected'
        }, { actorUserId: userId });
        return { outcome: 'rejected', tally: outcome.tally };
      }

      /* --- deadlock: wake the consensus planner --- */
      if (outcome.kind === 'consensus') {
        // Generated outside the vote transaction on purpose: an external
        // API call must never hold a row lock on `itineraries`, or one slow
        // model response freezes the whole board for everyone.
        let recommendation;
        try {
          recommendation = await withTransaction(c =>
            generateConsensusRecommendation(c, outcome.candidates, { trigger: outcome.trigger })
          );
        } catch (err) {
          log.error({ err, proposalId }, 'consensus generation failed entirely');
          return { outcome: 'tied', tally: outcome.tally, consensus: null };
        }

        emitToTrip(tripId, EVENTS.CONSENSUS_READY, {
          proposalId,
          trigger: outcome.trigger,
          recommendation
        }, { actorUserId: userId });

        return { outcome: 'tied', tally: outcome.tally, consensus: recommendation };
      }

      return { outcome: 'pending', reason: outcome.reason, tally: outcome.tally };
    }
  );

  /* ---------------------------------------------------------------- */
  /* Accept or override a recommendation                                */
  /* ---------------------------------------------------------------- */
  fastify.post(
    '/trips/:tripId/consensus/:recommendationId/decide',
    { preHandler: requirePermission('consensus:accept') },
    async request => {
      const schema = z.object({
        decision: z.enum(['accept', 'override']),
        // On override the caller names which proposal wins instead.
        chosenProposalId: z.string().nullable().optional()
      });
      const { decision, chosenProposalId } = schema.parse(request.body);
      const { tripId, recommendationId } = request.params;
      const userId = request.user.sub;

      const result = await withTransaction(async c => {
        const rec = await c.query(
          `SELECT * FROM consensus_recommendations WHERE recommendation_id = $1 FOR UPDATE`,
          [recommendationId]
        );
        if (rec.rows.length === 0) throw new NotFoundError('recommendation', recommendationId);
        const r = rec.rows[0];
        if (r.outcome !== 'pending') {
          throw new ConflictError('This recommendation was already decided.', {
            code: 'ALREADY_DECIDED', outcome: r.outcome
          });
        }

        const winningId = decision === 'accept' ? r.primary_proposal_id : chosenProposalId;
        if (!winningId) {
          throw new ValidationError('An override must name which proposal to apply.');
        }

        const tally = await tallyProposal(c, winningId);
        if (!tally) throw new NotFoundError('proposal', winningId);

        const applied = await applyProposal(c, tally);

        // 'synthesise' keeps the secondary as an explicitly optional item,
        // rather than silently dropping the losing half of the compromise.
        if (decision === 'accept' && r.strategy === 'synthesise' && r.secondary_proposal_id) {
          const secondary = await tallyProposal(c, r.secondary_proposal_id);
          if (secondary) {
            const sortOrder = await nextSortOrder(c, secondary.itineraryId, 0);
            await c.query(
              `INSERT INTO itinerary_items (
                 item_id, itinerary_id, day_index, sort_order, item_type, title,
                 cost, currency, carbon_kg, duration_minutes, source, explanation,
                 locked, status, created_at, updated_at
               ) VALUES ($1,$2,0,$3,'free',$4,$5,$6,0,0,'vote',$7,false,'proposed',now(),now())`,
              [
                ulid(), secondary.itineraryId, sortOrder,
                `${secondary.title} (optional add-on)`,
                Math.max(0, secondary.costDelta), secondary.currency,
                `Kept as an optional add-on by consensus recommendation ${recommendationId}`
              ]
            );
            await c.query(
              `UPDATE proposals SET status = 'accepted', updated_at = now() WHERE proposal_id = $1`,
              [r.secondary_proposal_id]
            );
          }
        }

        // Every candidate that did not win is closed explicitly, so no
        // stale open proposal lingers to re-trigger the planner.
        await c.query(
          `UPDATE proposals SET status = 'rejected', updated_at = now()
            WHERE itinerary_id = $1 AND status = 'open' AND proposal_id <> $2`,
          [tally.itineraryId, winningId]
        );

        await c.query(
          `UPDATE consensus_recommendations
              SET outcome = $1, decided_by_user_id = $2, decided_at = now()
            WHERE recommendation_id = $3`,
          [decision === 'accept' ? 'accepted' : 'overridden', userId, recommendationId]
        );

        return { winningId, applied };
      });

      emitToTrip(tripId, EVENTS.CONSENSUS_DECIDED, {
        recommendationId,
        decision,
        winningProposalId: result.winningId,
        version: result.applied.totals.version
      }, { actorUserId: userId });

      return {
        ok: true,
        decision,
        winningProposalId: result.winningId,
        version: result.applied.totals.version
      };
    }
  );

  /* ---------------------------------------------------------------- */
  fastify.get(
    '/trips/:tripId/proposals/:proposalId/consensus',
    { preHandler: requirePermission('trip:read', { tripIdFrom: 'params.proposalId' }) },
    async request => {
      const { rows } = await pool.query(
        `SELECT * FROM consensus_recommendations
          WHERE proposal_id = $1 ORDER BY created_at DESC`,
        [request.params.proposalId]
      );
      return { recommendations: rows };
    }
  );
}
