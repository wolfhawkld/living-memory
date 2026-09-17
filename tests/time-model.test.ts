import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decayAt,
  isValidInstant,
  projectMemory,
} from '../src/core/time-model.js';
import type { AnchorEvent, Concept, ModelConfig } from '../src/shared/types.js';

const concept: Concept = {
  id: 'math:exponentials',
  title: '指数函数',
  aliases: [],
  domain: 'math',
  summary: 'A test concept',
  body: 'A test concept body',
  source: { path: 'math/exponentials.md', revision: 'rev-1' },
};

const config: ModelConfig = {
  modelVersion: 'time-only-v0',
  halfLifeDays: 7,
  revision: 1,
};

const anchor: AnchorEvent = {
  eventId: 'event-1',
  conceptId: concept.id,
  sourceRevision: concept.source.revision,
  occurredAt: '2026-01-01T00:00:00.000Z',
  recordedAt: '2026-01-01T00:00:01.000Z',
  kind: 'review',
};

function stateAt(asOf: string) {
  return projectMemory(concept, anchor, config, asOf);
}

test('decayAt follows the half-life checkpoints', () => {
  assert.equal(decayAt(0, 7), 1);
  assert.equal(decayAt(7, 7), 0.5);
  assert.equal(decayAt(14, 7), 0.25);
});

test('projectMemory bins exact 0/H/2H checkpoints', () => {
  assert.equal(stateAt('2026-01-01T00:00:00Z').status, 'recent');
  assert.equal(stateAt('2026-01-08T00:00:00Z').status, 'revisit');
  assert.equal(stateAt('2026-01-15T00:00:00Z').status, 'stale');
  assert.equal(stateAt('2026-01-08T00:00:00Z').decay, 0.5);
  assert.equal(stateAt('2026-01-15T00:00:00Z').decay, 0.25);
});

test('no anchor produces an unknown state', () => {
  const state = projectMemory(concept, null, config, '2026-01-01T00:00:00Z');
  assert.deepEqual(state, {
    conceptId: concept.id,
    status: 'unknown',
    decay: null,
    elapsedDays: null,
    anchor: null,
    reason: null,
    asOf: '2026-01-01T00:00:00Z',
  });
});

test('future anchor is pending and does not clamp elapsed time to zero', () => {
  const futureAnchor = {
    ...anchor,
    occurredAt: '2026-01-02T00:00:00Z',
  };
  const state = projectMemory(
    concept,
    futureAnchor,
    config,
    '2026-01-01T00:00:00Z',
  );
  assert.equal(state.status, 'pending');
  assert.equal(state.decay, null);
  assert.equal(state.elapsedDays, null);
  assert.match(state.reason ?? '', /晚于投影时间/);
});

test('concept and source revision mismatches are pending with Chinese reasons', () => {
  const wrongConcept = projectMemory(
    concept,
    { ...anchor, conceptId: 'other:concept' },
    config,
    '2026-01-01T00:00:00Z',
  );
  assert.equal(wrongConcept.status, 'pending');
  assert.match(wrongConcept.reason ?? '', /概念 ID/);

  const changedRevision = { ...concept, source: { ...concept.source, revision: 'rev-2' } };
  const oldAnchor = projectMemory(
    changedRevision,
    anchor,
    config,
    '2026-01-01T00:00:00Z',
  );
  assert.equal(oldAnchor.status, 'pending');
  assert.match(oldAnchor.reason ?? '', /版本/);
});

test('instant validation requires timezone and rejects invalid calendar values', () => {
  assert.equal(isValidInstant('2026-01-01T00:00:00Z'), true);
  assert.equal(isValidInstant('2026-01-01T08:00:00+08:00'), true);
  assert.equal(isValidInstant('2026-01-01'), false);
  assert.equal(isValidInstant('2026-01-01T00:00:00'), false);
  assert.equal(isValidInstant('2026-02-30T00:00:00Z'), false);
  assert.throws(
    () => projectMemory(concept, null, config, '2026-01-01T00:00:00'),
    /Invalid asOf/,
  );
});

test('half-life and elapsed time validation rejects invalid values', () => {
  assert.throws(() => decayAt(Number.NaN, 7), /elapsedDays/);
  assert.throws(() => decayAt(Number.POSITIVE_INFINITY, 7), /elapsedDays/);
  assert.throws(() => decayAt(-0.1, 7), /non-negative/);
  assert.throws(() => decayAt(1, 0), /halfLifeDays/);
  assert.throws(() => decayAt(1, Number.NaN), /halfLifeDays/);
  assert.throws(() => decayAt(1, 3650.1), /halfLifeDays/);
});

test('UTC offsets represent the same instant and seven days change the projection', () => {
  const offsetAnchor = { ...anchor, occurredAt: '2026-01-01T08:00:00+08:00' };
  const state = projectMemory(
    concept,
    offsetAnchor,
    config,
    '2026-01-08T00:00:00Z',
  );
  assert.equal(state.elapsedDays, 7);
  assert.equal(state.decay, 0.5);
  assert.equal(state.status, 'revisit');
});

test('projection is idempotent and does not mutate inputs', () => {
  const conceptBefore = structuredClone(concept);
  const anchorBefore = structuredClone(anchor);
  const configBefore = structuredClone(config);
  const first = projectMemory(concept, anchor, config, '2026-01-08T00:00:00Z');
  const second = projectMemory(concept, anchor, config, '2026-01-08T00:00:00Z');
  assert.deepEqual(second, first);
  assert.deepEqual(concept, conceptBefore);
  assert.deepEqual(anchor, anchorBefore);
  assert.deepEqual(config, configBefore);
});
