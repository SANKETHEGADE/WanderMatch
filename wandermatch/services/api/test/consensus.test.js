/**
 * Grounding-validator tests.
 *
 * This is the design doc's headline safety claim: "a missing/invalid field
 * is a detectable failure, not a silent bad answer." These tests are the
 * evidence for it. Each one is a hallucination we specifically refuse.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateGrounding, validateNoInventedFigures, deterministicFallback
} from '../src/domain/consensus.js';

const context = {
  candidates: [
    { proposal_id: 'p1', title: 'Ridge Lookout', cost_delta: 450, currency: 'INR' },
    { proposal_id: 'p2', title: 'Chhatri Complex', cost_delta: 300, currency: 'INR' }
  ],
  votes: [
    { proposal_id: 'p1', user_id: 'u1', value: 'yes', comment: 'Better views' },
    { proposal_id: 'p2', user_id: 'u2', value: 'yes', comment: 'Less walking' }
  ],
  voter_preferences: [
    { user_id: 'u1', interests: ['hiking'], pace: 'packed', max_daily_budget: 3000 },
    { user_id: 'u2', interests: ['heritage'], pace: 'relaxed', max_daily_budget: null }
  ],
  neighbouring_items: [
    { item_id: 'i1', title: 'Lunch', cost: 800, currency: 'INR', duration_minutes: 60 }
  ]
};

test('a well-grounded pick_one passes', () => {
  const r = validateGrounding({
    strategy: 'pick_one',
    primary_proposal_id: 'p1',
    secondary_proposal_id: null,
    recommendation: 'Go with Ridge Lookout.',
    rationale: 'The group leans toward views over a shorter walk.',
    cites: [{ user_id: 'u1', reason: 'said the views are better' }]
  }, context);
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('REJECTS a proposal id that was never a candidate', () => {
  const r = validateGrounding({
    strategy: 'pick_one',
    primary_proposal_id: 'p_invented',
    recommendation: 'Go somewhere else.',
    rationale: 'Because.',
    cites: [{ user_id: 'u1', reason: 'whatever' }]
  }, context);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('not one of the candidates')));
});

test('REJECTS attributing an opinion to someone who never voted', () => {
  // The single most damaging failure mode: a fabricated quote from a real
  // teammate, rendered on screen as if they had said it.
  const r = validateGrounding({
    strategy: 'pick_one',
    primary_proposal_id: 'p1',
    recommendation: 'Go with Ridge Lookout.',
    rationale: 'Most people preferred it.',
    cites: [{ user_id: 'u_ghost', reason: 'strongly preferred the lookout' }]
  }, context);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('did not vote')));
});

test('REJECTS a non-defer recommendation that cites nobody', () => {
  const r = validateGrounding({
    strategy: 'pick_one',
    primary_proposal_id: 'p1',
    recommendation: 'Go with Ridge Lookout.',
    rationale: 'It seems better.',
    cites: []
  }, context);
  assert.equal(r.ok, false);
});

test('synthesise requires two distinct real candidates', () => {
  const same = validateGrounding({
    strategy: 'synthesise',
    primary_proposal_id: 'p1',
    secondary_proposal_id: 'p1',
    recommendation: 'Keep both.',
    rationale: 'They fit together.',
    cites: [{ user_id: 'u1', reason: 'wants the views' }]
  }, context);
  assert.equal(same.ok, false);
  assert.ok(same.errors.some(e => e.includes('two different proposals')));
});

test('defer is a legitimate answer and may cite nobody', () => {
  const r = validateGrounding({
    strategy: 'defer',
    primary_proposal_id: null,
    secondary_proposal_id: null,
    recommendation: 'This needs a human decision.',
    rationale: 'The comments do not reveal a compatible compromise.',
    cites: []
  }, context);
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('REJECTS an invented cost figure', () => {
  const r = validateNoInventedFigures({
    recommendation: 'Go with Ridge Lookout, only 120 extra.',
    rationale: 'Cheap.',
    cites: []
  }, context);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('120')));
});

test('ACCEPTS a figure that really is in the data', () => {
  const r = validateNoInventedFigures({
    recommendation: 'Ridge Lookout adds 450.',
    rationale: 'That is within budget.',
    cites: []
  }, context);
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('the deterministic fallback picks the earliest proposal and admits it', () => {
  const fallback = deterministicFallback([
    { proposalId: 'p2', title: 'Later', createdAt: '2027-01-02T00:00:00Z', weights: {} },
    { proposalId: 'p1', title: 'Earlier', createdAt: '2027-01-01T00:00:00Z', weights: {} }
  ]);
  assert.equal(fallback.primary_proposal_id, 'p1');
  assert.match(fallback.rationale, /proposed first/);
  assert.equal(fallback._fallback, true);
});
