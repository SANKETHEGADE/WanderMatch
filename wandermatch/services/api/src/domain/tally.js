/**
 * Proposal tallying.
 *
 * The provided `votes` table carries both `value` (yes/no/abstain) and
 * `weight`, and `trip_members` carries `share_weight`. The design doc calls
 * out that ties are "deliberately-present" in the seed data — so tie
 * handling is a first-class path here, not an edge case bolted on.
 *
 * Two distinct things can be tied, and they are NOT the same:
 *
 *   1. A SPLIT proposal: yes-weight == no-weight on one proposal.
 *      "The group cannot agree about this one change."
 *
 *   2. CONTESTED proposals: two or more OPEN proposals target the same
 *      slot (same target_item_id, or same day_index for adds) and both
 *      are passing. "The group agrees on two incompatible things."
 *
 * Only case 1 can be settled by counting harder. Case 2 needs a choice
 * between alternatives — which is precisely why the consensus planner
 * takes a *list* of candidates rather than a single proposal.
 */

/**
 * Which weight actually counts.
 *
 * `votes.weight` is per-vote; `trip_members.share_weight` is per-member.
 * We multiply them: share_weight expresses standing in the trip (a couple
 * sharing one booking may hold 2.0), vote weight expresses intensity on
 * this specific question. Multiplying keeps both meanings intact instead
 * of silently discarding one.
 */
const EFFECTIVE_WEIGHT_SQL = `(v.weight * COALESCE(tm.share_weight, 1.0))`;

export async function tallyProposal(client, proposalId) {
  const { rows } = await client.query(
    `SELECT
        p.proposal_id,
        p.itinerary_id,
        p.status,
        p.closes_at,
        p.action,
        p.target_item_id,
        p.title,
        p.cost_delta,
        p.currency,
        p.proposed_by_user_id,
        p.created_at,
        i.trip_id,
        COALESCE(SUM(${EFFECTIVE_WEIGHT_SQL}) FILTER (WHERE v.value = 'yes'), 0)     AS yes_weight,
        COALESCE(SUM(${EFFECTIVE_WEIGHT_SQL}) FILTER (WHERE v.value = 'no'), 0)      AS no_weight,
        COALESCE(SUM(${EFFECTIVE_WEIGHT_SQL}) FILTER (WHERE v.value = 'abstain'), 0) AS abstain_weight,
        COUNT(v.vote_id) FILTER (WHERE v.value = 'yes')     AS yes_count,
        COUNT(v.vote_id) FILTER (WHERE v.value = 'no')      AS no_count,
        COUNT(v.vote_id) FILTER (WHERE v.value = 'abstain') AS abstain_count,
        COUNT(v.vote_id)                                    AS ballots_cast
       FROM proposals p
       JOIN itineraries i ON i.itinerary_id = p.itinerary_id
       LEFT JOIN votes v  ON v.proposal_id = p.proposal_id
       LEFT JOIN trip_members tm
              ON tm.trip_id = i.trip_id
             AND tm.user_id = v.user_id
             AND tm.status = 'active'
      WHERE p.proposal_id = $1
      GROUP BY p.proposal_id, i.trip_id`,
    [proposalId]
  );

  if (rows.length === 0) return null;
  const r = rows[0];

  // Eligible voters = active members who can actually vote. Viewers are
  // members of the trip and DO get a say on proposals — the role gate is
  // about direct editing, not about voice. (See rbac.js: PERMISSIONS.)
  const eligible = await client.query(
    `SELECT COUNT(*)::int AS n
       FROM trip_members
      WHERE trip_id = $1 AND status = 'active'`,
    [r.trip_id]
  );

  const yes = Number(r.yes_weight);
  const no = Number(r.no_weight);
  const abstain = Number(r.abstain_weight);
  const eligibleCount = eligible.rows[0].n;
  const ballots = Number(r.ballots_cast);

  // Quorum: more than half the active members have registered an opinion.
  // Abstentions COUNT toward quorum (an abstention is participation) but
  // not toward either side — which is what makes a 3-3 with two abstentions
  // a real, decidable tie rather than an under-attended vote.
  const quorumRequired = Math.floor(eligibleCount / 2) + 1;
  const quorumMet = ballots >= quorumRequired;

  const decisive = yes !== no;
  const closed = new Date(r.closes_at) <= new Date();

  return {
    proposalId: r.proposal_id,
    itineraryId: r.itinerary_id,
    tripId: r.trip_id,
    status: r.status,
    action: r.action,
    targetItemId: r.target_item_id,
    title: r.title,
    costDelta: Number(r.cost_delta),
    currency: r.currency,
    proposedByUserId: r.proposed_by_user_id,
    createdAt: r.created_at,
    closesAt: r.closes_at,
    weights: { yes, no, abstain },
    counts: {
      yes: Number(r.yes_count),
      no: Number(r.no_count),
      abstain: Number(r.abstain_count),
      ballots,
      eligible: eligibleCount
    },
    quorum: { required: quorumRequired, met: quorumMet },
    closed,
    // A tie is only meaningful once somebody actually voted. 0-0 is an
    // untouched proposal, not a deadlock, and must never wake the planner.
    isSplitTie: !decisive && (yes > 0 || no > 0),
    passing: yes > no,
    // Ready to resolve = the vote is over (or everyone has spoken) and we
    // have enough participation to honour the result.
    readyToResolve: quorumMet && (closed || ballots >= eligibleCount)
  };
}

/**
 * Find OPEN proposals contesting the same slot as the given one.
 *
 * Two proposals contest each other when they act on the same target item,
 * or when both are 'add' proposals aimed at the same day. This is the
 * case-2 tie above: both may be individually passing, yet they cannot both
 * be applied.
 */
export async function findContestingProposals(client, proposal) {
  const { rows } = await client.query(
    `SELECT p.proposal_id
       FROM proposals p
      WHERE p.itinerary_id = $1
        AND p.status = 'open'
        AND p.proposal_id <> $2
        AND (
          ($3::text IS NOT NULL AND p.target_item_id = $3)
          OR ($3::text IS NULL AND p.target_item_id IS NULL AND p.action = $4)
        )`,
    [proposal.itineraryId, proposal.proposalId, proposal.targetItemId, proposal.action]
  );

  const tallies = [];
  for (const row of rows) {
    const t = await tallyProposal(client, row.proposal_id);
    if (t && t.passing) tallies.push(t);
  }
  return tallies;
}

/**
 * The single decision point: given a proposal that just received a vote,
 * what should happen?
 *
 * Returns one of:
 *   { kind: 'wait' }                       — not resolvable yet
 *   { kind: 'accept' }                     — clear majority, apply it
 *   { kind: 'reject' }                     — clearly rejected, close it
 *   { kind: 'consensus', candidates: [] }  — needs the planner
 */
export async function decideProposalOutcome(client, proposalId) {
  const tally = await tallyProposal(client, proposalId);
  if (!tally) return { kind: 'wait', reason: 'not_found' };
  if (tally.status !== 'open') return { kind: 'wait', reason: 'already_closed' };

  if (!tally.readyToResolve) {
    return { kind: 'wait', reason: tally.quorum.met ? 'voting_open' : 'quorum_not_met', tally };
  }

  // Case 1: the proposal itself is split down the middle.
  if (tally.isSplitTie) {
    const contesting = await findContestingProposals(client, tally);
    return { kind: 'consensus', trigger: 'split_tie', candidates: [tally, ...contesting], tally };
  }

  if (!tally.passing) {
    return { kind: 'reject', tally };
  }

  // Case 2: it passes, but something else passing wants the same slot.
  const contesting = await findContestingProposals(client, tally);
  if (contesting.length > 0) {
    return { kind: 'consensus', trigger: 'contested_slot', candidates: [tally, ...contesting], tally };
  }

  return { kind: 'accept', tally };
}
