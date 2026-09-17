/**
 * Matching heuristic tests.
 *
 * These matter because the design doc promises the score is "fully
 * explainable" — which is only true if the components behave the way the
 * UI claims they do. Each test pins one component's contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  jaccard, dateOverlap, scaleCompatibility, scoreCandidate, WEIGHTS
} from '../src/domain/matching.js';

test('weights sum to exactly 1', () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(Number(sum.toFixed(10)), 1);
});

test('jaccard is case- and separator-insensitive', () => {
  assert.equal(jaccard(['Hiking', 'Food'], ['hiking', 'food']), 1);
  assert.equal(jaccard(['tea_plantations'], ['tea plantations']), 1);
});

test('jaccard of disjoint sets is zero, not NaN', () => {
  assert.equal(jaccard(['surfing'], ['museums']), 0);
  assert.equal(jaccard([], []), 0);
});

test('date overlap is IoU, so a short window inside a long one scores low', () => {
  // 3 days fully inside a 30-day trip: overlap 3, union 30 => 0.1
  const score = dateOverlap('2027-03-10', '2027-03-12', '2027-03-01', '2027-03-30');
  assert.ok(score > 0.09 && score < 0.11, `expected ~0.1, got ${score}`);
});

test('identical windows score 1', () => {
  assert.equal(dateOverlap('2027-03-10', '2027-03-15', '2027-03-10', '2027-03-15'), 1);
});

test('non-overlapping windows score 0', () => {
  assert.equal(dateOverlap('2027-01-01', '2027-01-05', '2027-06-01', '2027-06-05'), 0);
});

test('a single shared day counts as overlap, not zero', () => {
  const score = dateOverlap('2027-03-10', '2027-03-12', '2027-03-12', '2027-03-14');
  assert.ok(score > 0, 'inclusive windows must count the shared boundary day');
});

test('unknown scale values score 0 rather than guessing a midpoint', () => {
  assert.equal(scaleCompatibility('unknown', 'mid', { mid: 1, luxury: 2 }), 0);
});

test('adjacent budget bands score higher than distant ones', () => {
  const SCALE = { shoestring: 0, value: 1, mid: 2, premium: 3, luxury: 4 };
  const near = scaleCompatibility('mid', 'premium', SCALE);
  const far = scaleCompatibility('shoestring', 'luxury', SCALE);
  assert.ok(near > far);
  assert.equal(far, 0);
});

test('a perfect candidate scores 1 and a null candidate scores 0', () => {
  const solo = {
    interests: ['hiking', 'food'], startDate: '2027-03-10', endDate: '2027-03-15',
    pace: 'moderate', budgetBand: 'mid'
  };
  const perfect = scoreCandidate(solo, {
    memberInterests: ['hiking', 'food'], startDate: '2027-03-10', endDate: '2027-03-15',
    pace: 'moderate', budgetBand: 'mid'
  });
  assert.equal(perfect.total, 1);

  const nothing = scoreCandidate(solo, {
    memberInterests: ['opera'], startDate: '2028-01-01', endDate: '2028-01-05',
    pace: null, budgetBand: null
  });
  assert.equal(nothing.total, 0);
});

test('components are individually reported so the UI breakdown is real', () => {
  const result = scoreCandidate(
    { interests: ['hiking'], startDate: '2027-03-10', endDate: '2027-03-15',
      pace: 'moderate', budgetBand: 'mid' },
    { memberInterests: ['hiking'], startDate: '2027-03-10', endDate: '2027-03-15',
      pace: 'moderate', budgetBand: 'mid' }
  );
  for (const key of ['interestScore', 'dateScore', 'paceScore', 'budgetScore']) {
    assert.ok(key in result.components, `missing ${key}`);
  }
  // The total must actually be the weighted sum of what we show the user.
  const recomputed =
    WEIGHTS.interests * result.components.interestScore +
    WEIGHTS.dates * result.components.dateScore +
    WEIGHTS.pace * result.components.paceScore +
    WEIGHTS.budget * result.components.budgetScore;
  assert.equal(Number(recomputed.toFixed(4)), result.total);
});
