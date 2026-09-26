import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AnchorEvent,
  Concept,
  MemoryState,
  Snapshot,
} from '../src/shared/types.js';
import { domainIdOf } from '../src/core/domain-view.js';
import { selectBriefReviewCandidates } from '../src/core/brief-review.js';
import { projectMemory } from '../src/core/time-model.js';

const AS_OF = '2026-01-15T00:00:00.000Z';
const config = { modelVersion: 'time-only-v0' as const, halfLifeDays: 7, revision: 1 };

function concept(id: string, path: string, revision = `rev-${id}`, title = id): Concept {
  return {
    id,
    title,
    aliases: [],
    domain: 'ignored',
    summary: title,
    body: title,
    source: { path, revision },
  };
}

function anchor(item: Concept, kind: AnchorEvent['kind'] = 'review'): AnchorEvent {
  return {
    eventId: `event-${item.id}`,
    conceptId: item.id,
    sourceRevision: item.source.revision,
    occurredAt: '2026-01-01T00:00:00.000Z',
    recordedAt: '2026-01-01T00:00:01.000Z',
    kind,
  };
}

function state(item: Concept, overrides: Partial<MemoryState> = {}): MemoryState {
  return {
    conceptId: item.id,
    status: 'stale',
    decay: 0.25,
    elapsedDays: 14,
    anchor: anchor(item),
    reason: null,
    asOf: AS_OF,
    ...overrides,
  };
}

function snapshot(concepts: Concept[], states: Record<string, MemoryState>): Snapshot {
  return {
    concepts,
    links: [],
    source: {
      name: 'fixture',
      mode: 'local',
      conceptCount: concepts.length,
      limit: 1,
      diagnostics: [],
    },
    config,
    states,
    asOf: AS_OF,
    observationsCount: 0,
  };
}

test('uses complete domain concepts, real H/2H boundaries, and deterministic ranking', () => {
  const revisit = concept('revisit', 'Cognition/Math/revisit.md');
  const stale = concept('stale', 'Cognition/Math/stale.md');
  const farthest = concept('farthest', 'Cognition/Math/farthest.md');
  const tieZ = concept('tie-z', 'Cognition/Math/tie-z.md');
  const tieA = concept('tie-a', 'Cognition/Math/tie-a.md');
  const duplicate = { ...stale };
  const other = concept('other', 'Cognition/Model/other.md', 'rev-other', 'stale');

  const revisitState = projectMemory(revisit, anchor(revisit), config, '2026-01-08T00:00:00.000Z');
  const staleState = projectMemory(stale, anchor(stale), config, AS_OF);
  const farthestState = projectMemory(farthest, anchor(farthest), config, '2026-01-01T00:00:00.000Z');
  const tieState = projectMemory(tieZ, anchor(tieZ), config, '2026-01-11T00:00:00.000Z');
  const tieAState = projectMemory(tieA, anchor(tieA), config, '2026-01-11T00:00:00.000Z');

  const states = {
    revisit: revisitState,
    stale: staleState,
    farthest: farthestState,
    'tie-z': tieState,
    'tie-a': tieAState,
    other: state(other),
  };
  const result = selectBriefReviewCandidates(
    snapshot([revisit, stale, farthest, tieZ, tieA, duplicate, other], states),
    'Cognition/Math',
    { limit: 5 },
  );

  assert.deepEqual(result.map((item) => [item.conceptId, item.status, item.elapsedDays]), [
    ['stale', 'stale', 14],
    ['tie-a', 'revisit', 10],
    ['tie-z', 'revisit', 10],
    ['revisit', 'revisit', 7],
  ]);
  assert.equal(result.find((item) => item.conceptId === 'revisit')?.estimated, false);
  assert.equal(result.length, 4);
  assert.equal(domainIdOf(other), 'Cognition/Model');
});

test('requires matching current anchors and valid time values, and protects retained nodes', () => {
  const valid = concept('valid', 'Cognition/Math/valid.md');
  const estimated = concept('estimated', 'Cognition/Math/estimated.md');
  const oldRevision = concept('old-revision', 'Cognition/Math/old.md', 'rev-current');
  const pending = concept('pending', 'Cognition/Math/pending.md');
  const unknown = concept('unknown', 'Cognition/Math/unknown.md');
  const recent = concept('recent', 'Cognition/Math/recent.md');
  const retained = concept('retained', 'Cognition/Math/retained.md');
  const invalidElapsed = concept('invalid-elapsed', 'Cognition/Math/invalid-elapsed.md');
  const invalidDecay = concept('invalid-decay', 'Cognition/Math/invalid-decay.md');
  const tooHighDecay = concept('too-high-decay', 'Cognition/Math/too-high-decay.md');

  const oldAnchor = { ...anchor(oldRevision), sourceRevision: 'rev-old' };
  const wrongConceptAnchor = { ...anchor(pending), conceptId: 'different' };
  const states: Record<string, MemoryState> = {
    valid: state(valid),
    estimated: state(estimated, { anchor: anchor(estimated, 'estimated') }),
    'old-revision': projectMemory(
      { ...oldRevision, source: { ...oldRevision.source, revision: 'rev-new' } },
      oldAnchor,
      config,
      AS_OF,
    ),
    pending: state(pending, { status: 'pending', anchor: wrongConceptAnchor }),
    unknown: state(unknown, { status: 'unknown', anchor: null, decay: null, elapsedDays: null }),
    recent: state(recent, { status: 'recent', decay: 1, elapsedDays: 0 }),
    retained: state(retained, { retention: {
      eventId: 'retention-1',
      conceptId: retained.id,
      sourceRevision: retained.source.revision,
      occurredAt: AS_OF,
      recordedAt: AS_OF,
      active: true,
      previousEventId: null,
    } }),
    'invalid-elapsed': state(invalidElapsed, { elapsedDays: Number.POSITIVE_INFINITY }),
    'invalid-decay': state(invalidDecay, { decay: Number.NaN }),
    'too-high-decay': state(tooHighDecay, { decay: 0.5001 }),
  };
  const concepts = [
    valid, estimated, oldRevision, pending, unknown, recent, retained,
    invalidElapsed, invalidDecay, tooHighDecay,
  ];

  const result = selectBriefReviewCandidates(snapshot(concepts, states), 'Cognition/Math', { limit: 5 });
  assert.deepEqual(result.map((item) => item.conceptId), ['estimated', 'valid']);
  assert.equal(result.find((item) => item.conceptId === 'estimated')?.estimated, true);
});

test('supports exclusion and bounded limits without filling from other statuses', () => {
  const concepts = Array.from({ length: 7 }, (_, index) => concept(
    `math-${index}`,
    `Cognition/Math/${index}.md`,
  ));
  const states = Object.fromEntries(concepts.map((item, index) => [item.id, state(item, {
    elapsedDays: index + 1,
  })]));
  const input = snapshot(concepts, states);
  const before = structuredClone(input);

  assert.deepEqual(
    selectBriefReviewCandidates(input, 'Cognition/Math', { excludedIds: new Set(['math-6']) })
      .map((item) => item.conceptId),
    ['math-5', 'math-4', 'math-3'],
  );
  assert.equal(selectBriefReviewCandidates(input, 'Cognition/Math', { limit: 0 }).length, 0);
  assert.equal(selectBriefReviewCandidates(input, 'Cognition/Math', { limit: 99 }).length, 5);
  assert.equal(selectBriefReviewCandidates(input, 'Cognition/Math', { limit: Number.NaN }).length, 3);
  assert.equal(selectBriefReviewCandidates(input, 'Cognition/Math', { limit: Number.POSITIVE_INFINITY }).length, 3);
  assert.deepEqual(input, before);
});
