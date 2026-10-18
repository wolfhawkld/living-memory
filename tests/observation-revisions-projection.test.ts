import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareObservationRevision, projectObservationAssessments } from '../src/core/observation-revisions.js';
import type { ObservationRevision, ObservationRevisionRequest } from '../src/shared/observation-revisions.js';
import type { Observation } from '../src/shared/types.js';

const NOW = '2026-12-01T00:00:00Z';
function observation(eventId = 'original', fields: Partial<Observation> = {}): Observation {
  return { eventId, conceptId: 'concept-a', sourceRevision: 'version-old', observedAt: '2026-10-01T08:00:00+08:00',
    recordedAt: '2026-10-01T00:00:01Z', configRevision: 3, halfLifeDays: 7, anchorEventId: 'anchor-original',
    elapsedDays: 7, decay: .5, answer: 'private original answer', rating: 'clear', exposure: 'unexposed', observedExposure: false,
    evidenceMode: 'written', learning: { task: 'concept', confidence: 80, confidenceAt: '2026-09-30T23:59:59Z',
      cue: 'independent', outcome: 'success', basis: 'self-check' }, ...fields };
}
function revision(eventId: string, parent: Observation, changes: Record<string, unknown> = {}): ObservationRevision {
  return { eventId, observationEventId: parent.eventId, previousEventId: null, action: 'revise', reason: 'input-error',
    occurredAt: '2026-10-02T00:00:00Z', recordedAt: '2026-10-02T00:00:01Z', conceptId: parent.conceptId,
    sourceRevision: parent.sourceRevision, assessment: { rating: 'partial', learning: parent.learning
      ? { outcome: 'failure', basis: 'self-check' } : null }, ...changes } as ObservationRevision;
}
function action(eventId: string, parent: Observation, kind: 'withdraw' | 'reinstate', previous: string | null, changes: Record<string, unknown> = {}): ObservationRevision {
  const { assessment: _assessment, ...base } = revision(eventId, parent);
  return { ...base, action: kind, previousEventId: previous, ...changes } as ObservationRevision;
}
function request(event: ObservationRevision): ObservationRevisionRequest {
  const { conceptId: _concept, sourceRevision: _version, recordedAt: _receipt, ...value } = event;
  return value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test('revise, withdraw and repeated reinstate preserve the last adopted judgment and original facts', () => {
  const parent = observation();
  const r = revision('correction', parent);
  const w = action('withdraw', parent, 'withdraw', r.eventId);
  const s = action('reinstate', parent, 'reinstate', w.eventId);
  const w2 = action('withdraw-again', parent, 'withdraw', s.eventId);
  const s2 = action('reinstate-again', parent, 'reinstate', w2.eventId);
  const raw = freeze([parent]), chain = freeze([r, w, s, w2, s2]);
  const bytes = JSON.stringify([raw, chain]);
  for (let length = 0; length <= chain.length; length++) {
    const result = projectObservationAssessments(raw, chain.slice(0, length), NOW);
    const withdrawn = length === 2 || length === 4;
    assert.equal(result.states[0].status, withdrawn ? 'withdrawn' : 'active');
    assert.equal(result.states[0].appliedRevisionCount, length);
    assert.equal(result.states[0].currentAssessment?.rating, length ? 'partial' : 'clear');
    assert.equal(result.effective.length, withdrawn ? 0 : 1);
    if (!withdrawn) {
      const effective = result.effective[0];
      assert.equal(effective.kind, 'derived-observation-assessment');
      assert.notEqual(effective.observation, parent);
      assert.notEqual(effective.observation.learning, parent.learning);
      assert.equal(effective.observation.observedAt, parent.observedAt);
      assert.equal(effective.observation.recordedAt, parent.recordedAt);
      assert.equal(effective.observation.answer, parent.answer);
      assert.equal(effective.observation.learning?.confidence, 80);
      assert.equal(effective.observation.learning?.confidenceAt, parent.learning?.confidenceAt);
      assert.equal(effective.observation.anchorEventId, parent.anchorEventId);
      assert.equal(effective.observation.halfLifeDays, 7);
      assert.equal(effective.observation.decay, .5);
    }
    assert.equal(result.issues.length, 0);
    assert.doesNotMatch(JSON.stringify(result.states), /private original answer|private reason/);
  }
  assert.equal(JSON.stringify([raw, chain]), bytes);
});

test('legacy observations keep absent learning and cannot receive a fabricated assessment shape', () => {
  const parent = observation('legacy', { learning: undefined });
  const corrected = revision('legacy-correction', parent);
  const result = projectObservationAssessments([parent], [corrected], NOW);
  assert.equal(result.effective[0].observation.learning, undefined);
  const invalid = { ...corrected, assessment: { rating: 'partial', learning: { outcome: 'success', basis: 'self-check' } } };
  const rejected = projectObservationAssessments([parent], [invalid], NOW);
  assert.equal(rejected.states[0].status, 'unresolved');
  assert.equal(rejected.states[0].issues[0].code, 'LEARNING_SHAPE_MISMATCH');
  assert.equal(rejected.effective.length, 0);
});

test('asOf uses server receipt and ignores future corrupt or conflicting records before inspecting their schema', () => {
  const parent = observation();
  const r = revision('correction', parent);
  const before = projectObservationAssessments([parent], [r], '2026-10-02T00:00:00Z');
  assert.equal(before.effective[0].observation.rating, 'clear');
  assert.equal(before.states[0].appliedRevisionCount, 0);
  const futureCorrupt = { recordedAt: '2026-11-01T00:00:00Z', eventId: r.eventId, observationEventId: null, bad: 'private reason' };
  assert.deepEqual(projectObservationAssessments([parent], [r, futureCorrupt], '2026-10-03T00:00:00Z'),
    projectObservationAssessments([parent], [r], '2026-10-03T00:00:00Z'));
  assert.throws(() => projectObservationAssessments([parent], [futureCorrupt], NOW), { code: 'UNATTRIBUTABLE_REVISION' });
});

test('unordered chains and canonical duplicates replay deterministically without changing original date spelling', () => {
  const parent = observation();
  const r = revision('correction', parent);
  const w = action('withdraw', parent, 'withdraw', r.eventId);
  const s = action('restore', parent, 'reinstate', w.eventId);
  const equivalent = { ...r, occurredAt: '2026-10-02T08:00:00+08:00', recordedAt: '2026-10-02T08:00:01+08:00' };
  const expected = projectObservationAssessments([parent], [r, w, s], NOW);
  assert.deepEqual(projectObservationAssessments([parent], [s, equivalent, w, r], NOW), expected);
  assert.equal(expected.effective[0].observation.observedAt, '2026-10-01T08:00:00+08:00');
  assert.equal(expected.states[0].audit.length, 3);
});

test('forks invalidate the whole affected chain while independent parents remain active', () => {
  const parent = observation(), healthy = observation('healthy');
  const r = revision('root', parent);
  const result = projectObservationAssessments([parent, healthy], [r,
    action('left', parent, 'withdraw', r.eventId), action('right', parent, 'withdraw', r.eventId)], NOW);
  const state = result.states.find(item => item.observationEventId === parent.eventId)!;
  assert.equal(state.status, 'unresolved');
  assert.equal(state.latestRevisionEventId, null);
  assert.equal(state.appliedRevisionCount, 0);
  assert.deepEqual(state.audit, []);
  assert.ok(state.issues.some(item => item.code === 'FORK'));
  assert.deepEqual(result.effective.map(item => item.observationEventId), ['healthy']);
});

test('cycles, missing predecessors, multiple roots and foreign predecessors have explicit diagnostics', () => {
  const parent = observation(), other = observation('other');
  const cases: Array<[unknown[], string, string]> = [
    [[revision('a', parent, { previousEventId: 'b' }), revision('b', parent, { previousEventId: 'a' })], 'CYCLE', 'invalid'],
    [[revision('a', parent, { previousEventId: 'missing' })], 'MISSING_PREDECESSOR', 'incomplete'],
    [[revision('a', parent), revision('b', parent)], 'FORK', 'invalid'],
    [[revision('foreign', other), revision('a', parent, { previousEventId: 'foreign' })], 'FOREIGN_PREDECESSOR', 'invalid'],
  ];
  for (const [events, code, kind] of cases) {
    const result = projectObservationAssessments([parent, other], events, NOW);
    const state = result.states.find(item => item.observationEventId === parent.eventId)!;
    assert.equal(state.status, 'unresolved');
    assert.ok(state.issues.some(item => item.code === code && item.kind === kind));
    assert.equal(state.appliedRevisionCount, 0);
    assert.deepEqual(result, projectObservationAssessments([other, parent], [...events].reverse(), NOW));
  }
});

test('event conflicts include metadata differences, all mentioned parents and observation ID collisions', () => {
  const a = observation('a'), b = observation('b');
  const r = revision('same-id', a);
  for (const events of [
    [r, { ...r, recordedAt: '2026-10-02T00:00:02Z' }],
    [r, { ...r, sourceRevision: 'conflicting-version' }],
    [r, { ...r, occurredAt: '2026-09-01T00:00:00Z' }],
    [r, revision(r.eventId, b)],
    [revision(b.eventId, a)],
    [r, { ...revision(r.eventId, b), extra: 'invalid' }],
  ]) {
    const result = projectObservationAssessments([a, b], events, NOW);
    assert.ok(result.issues.some(item => item.code === 'EVENT_CONFLICT'));
    assert.equal(result.states.find(item => item.observationEventId === a.eventId)?.status, 'unresolved');
    if (events.some(item => item.observationEventId === b.eventId || item.eventId === b.eventId)) {
      assert.equal(result.states.find(item => item.observationEventId === b.eventId)?.status, 'unresolved');
    }
    assert.deepEqual(result, projectObservationAssessments([b, a], [...events].reverse(), NOW));
  }
  assert.equal(projectObservationAssessments([a, { ...a }], [], NOW).states[0].status, 'unresolved');
});

test('visible children of future parents or predecessors are time errors rather than normal truncation', () => {
  const parent = observation();
  const future = revision('future-predecessor', parent, { recordedAt: '2026-11-01T00:00:00Z' });
  const child = action('visible-child', parent, 'withdraw', future.eventId);
  const result = projectObservationAssessments([parent], [future, child], '2026-10-03T00:00:00Z');
  assert.ok(result.issues.some(item => item.code === 'INVALID_REVISION_TIME'));
  const lateParent = observation('late-parent', { recordedAt: '2026-11-01T00:00:00Z' });
  assert.equal(projectObservationAssessments([lateParent], [], '2026-10-03T00:00:00Z').states[0].status, 'not-yet-recorded');
  assert.ok(projectObservationAssessments([lateParent], [revision('visible', lateParent)], '2026-10-03T00:00:00Z')
    .issues.some(item => item.code === 'INVALID_REVISION_TIME'));
});

test('attributable corruption is local, unknown parents remain diagnostics and unassignable corruption fails closed globally', () => {
  const parent = observation(), healthy = observation('healthy');
  const invalid = { ...revision('bad', parent), recordedAt: 'not-a-date' };
  const result = projectObservationAssessments([parent, healthy], [invalid], NOW);
  assert.deepEqual(result.effective.map(item => item.observationEventId), ['healthy']);
  assert.ok(result.issues.some(item => item.code === 'INVALID_REVISION'));
  assert.ok(!result.issues.some(item => item.code === 'EVENT_CONFLICT'));
  const orphan = projectObservationAssessments([healthy], [revision('orphan', parent)], NOW);
  assert.ok(orphan.issues.some(item => item.code === 'MISSING_PARENT' && item.kind === 'incomplete'));
  assert.equal(orphan.states.length, 1);
  assert.throws(() => projectObservationAssessments([parent], [{ recordedAt: NOW, eventId: 'bad' }], NOW), { code: 'UNATTRIBUTABLE_REVISION' });
  assert.throws(() => projectObservationAssessments([parent], [], '2026-10-01'), { code: 'INVALID_AS_OF' });
});

test('parent identity, revision chronology, transitions and nonchanges cannot silently revive original ratings', () => {
  const parent = observation();
  const same = revision('same', parent, { assessment: { rating: parent.rating, learning: { outcome: 'success', basis: 'self-check' } } });
  const cases: Array<[unknown[], string]> = [
    [[revision('wrong-parent', parent, { sourceRevision: 'different' })], 'PARENT_MISMATCH'],
    [[revision('early', parent, { occurredAt: '2026-09-30T00:00:00Z' })], 'INVALID_REVISION_TIME'],
    [[action('restore', parent, 'reinstate', null)], 'INVALID_TRANSITION'],
    [[same], 'UNCHANGED_ASSESSMENT'],
  ];
  for (const [events, code] of cases) {
    const result = projectObservationAssessments([parent], events, NOW);
    assert.equal(result.effective.length, 0);
    assert.ok(result.issues.some(item => item.code === code));
    assert.equal(result.states[0].currentAssessment, null);
  }
  const badParent = observation('bad-time', { recordedAt: '2026-09-30T00:00:00Z' });
  assert.equal(projectObservationAssessments([badParent], [], NOW).states[0].issues[0].code, 'INVALID_PARENT');
});

test('legal prototype-like IDs are ordinary map keys while invalid proto IDs are rejected', () => {
  const a = observation('constructor'), b = observation('toString');
  const result = projectObservationAssessments([a, b], [revision('constructor-change', a)], NOW);
  assert.deepEqual(result.effective.map(item => item.observationEventId), ['constructor', 'toString']);
  assert.throws(() => projectObservationAssessments([observation('__proto__')], [], NOW), { code: 'INVALID_PARENT' });
});

test('withdrawn observations reject revisions and repeated withdrawals in projection and preparation', () => {
  const parent = observation();
  const withdrawn = action('withdrawn', parent, 'withdraw', null);
  for (const candidate of [
    revision('revise-withdrawn', parent, { previousEventId: withdrawn.eventId }),
    action('withdraw-twice', parent, 'withdraw', withdrawn.eventId),
  ]) {
    const result = projectObservationAssessments([parent], [withdrawn, candidate], NOW);
    assert.equal(result.states[0].status, 'unresolved');
    assert.equal(result.effective.length, 0);
    assert.ok(result.issues.some(item => item.code === 'INVALID_TRANSITION' && item.eventId === candidate.eventId));
    assert.throws(() => prepareObservationRevision({ observation: parent, revisions: [withdrawn],
      request: request(candidate), recordedAt: candidate.recordedAt }), { code: 'INVALID_TRANSITION' });
  }
});

test('predecessor occurrence and receipt chronology are checked independently in projection and preparation', () => {
  const parent = observation();
  const predecessor = revision('predecessor', parent, {
    occurredAt: '2026-10-04T00:00:00Z', recordedAt: '2026-10-05T00:00:00Z',
  });
  for (const times of [
    { occurredAt: '2026-10-03T00:00:00Z', recordedAt: '2026-10-06T00:00:00Z' },
    { occurredAt: '2026-10-04T12:00:00Z', recordedAt: '2026-10-04T13:00:00Z' },
  ]) {
    const candidate = action('out-of-order', parent, 'withdraw', predecessor.eventId, times);
    const result = projectObservationAssessments([parent], [predecessor, candidate], NOW);
    assert.equal(result.states[0].status, 'unresolved');
    assert.equal(result.effective.length, 0);
    assert.ok(result.issues.some(item => item.code === 'INVALID_REVISION_TIME' && item.eventId === candidate.eventId));
    assert.throws(() => prepareObservationRevision({ observation: parent, revisions: [predecessor],
      request: request(candidate), recordedAt: candidate.recordedAt }), { code: 'INVALID_REVISION_TIME' });
  }
});

test('invalid parent accessors stay classified without re-reading private exceptions during sorting', () => {
  for (const field of ['observedAt', 'recordedAt']) {
    const healthy = observation('healthy'), invalid = observation('invalid');
    Object.defineProperty(invalid, field, { enumerable: true, get() { throw new Error('private-original-answer'); } });
    const result = projectObservationAssessments([healthy, invalid], [], NOW);
    assert.deepEqual(result.effective.map(item => item.observationEventId), ['healthy']);
    assert.equal(result.states.find(item => item.observationEventId === 'invalid')?.status, 'unresolved');
    assert.doesNotMatch(JSON.stringify(result.issues), /private-original-answer/);
  }
});

test('long reverse-ordered chains replay iteratively and audit carries no private payload', () => {
  const parent = observation();
  const events: ObservationRevision[] = [];
  for (let index = 0; index < 2500; index++) events.push(action(`decision-${index}`, parent,
    index % 2 === 0 ? 'withdraw' : 'reinstate', events.at(-1)?.eventId ?? null, { note: 'private reason' }));
  const result = projectObservationAssessments([parent], events.reverse(), NOW);
  assert.equal(result.states[0].status, 'active');
  assert.equal(result.states[0].audit.length, 2500);
  assert.equal(result.states[0].latestRevisionEventId, 'decision-2499');
  assert.doesNotMatch(JSON.stringify(result.states), /private reason|private original answer/);
});

test('prepare derives server metadata and known duplicate receipts win over later tails, state and new clock values', () => {
  const parent = observation();
  const original = revision('correct', parent);
  const prepared = prepareObservationRevision({ observation: parent, revisions: [], request: request(original), recordedAt: original.recordedAt });
  assert.equal(prepared.status, 'append');
  assert.deepEqual(prepared.event, { ...original, occurredAt: '2026-10-02T00:00:00.000Z', recordedAt: '2026-10-02T00:00:01.000Z' });
  const withdrawn = action('withdrawn', parent, 'withdraw', original.eventId);
  const duplicate = prepareObservationRevision({ observation: parent, revisions: [prepared.event, withdrawn],
    request: { ...request(original), occurredAt: '2026-10-02T08:00:00+08:00' }, recordedAt: 'invalid new clock' });
  assert.equal(duplicate.status, 'duplicate');
  assert.deepEqual(duplicate.event, prepared.event);
  assert.throws(() => prepareObservationRevision({ observation: parent, revisions: [original],
    request: { ...request(original), reason: 'other' }, recordedAt: NOW }), { code: 'EVENT_CONFLICT' });
});

test('pure preparation does not execute database CAS and rejects the stale candidate after a winner is supplied', () => {
  const parent = observation();
  const left = revision('left', parent), right = revision('right', parent);
  assert.equal(prepareObservationRevision({ observation: parent, revisions: [], request: request(left), recordedAt: left.recordedAt }).status, 'append');
  assert.equal(prepareObservationRevision({ observation: parent, revisions: [], request: request(right), recordedAt: right.recordedAt }).status, 'append');
  assert.throws(() => prepareObservationRevision({ observation: parent, revisions: [left], request: request(right), recordedAt: NOW }), { code: 'PREVIOUS_EVENT_CONFLICT' });
});

test('prepare validates the complete persisted chain instead of filtering later receipts with a reversed clock', () => {
  const parent = observation();
  const later = revision('later', parent, { occurredAt: '2026-11-01T00:00:00Z', recordedAt: '2026-11-01T00:00:01Z' });
  const next = action('next', parent, 'withdraw', later.eventId, { occurredAt: '2026-11-01T00:00:00Z' });
  assert.throws(() => prepareObservationRevision({ observation: parent, revisions: [later], request: request(next),
    recordedAt: '2026-10-10T00:00:00Z' }), { code: 'INVALID_REVISION_TIME' });
  assert.throws(() => prepareObservationRevision({ observation: parent, revisions: [later], request: request(revision('stale', parent)),
    recordedAt: '2026-10-10T00:00:00Z' }), { code: 'PREVIOUS_EVENT_CONFLICT' });
});

test('prepare rejects unchanged judgments, invalid transitions, malformed requests and raw event ID reuse', () => {
  const parent = observation();
  const unchanged = revision('same', parent, { assessment: { rating: 'clear', learning: { outcome: 'success', basis: 'self-check' } } });
  const prepare = (value: unknown) => prepareObservationRevision({ observation: parent, revisions: [], request: value, recordedAt: NOW });
  assert.throws(() => prepare(request(unchanged)), { code: 'UNCHANGED_ASSESSMENT' });
  assert.throws(() => prepare(request(action('restore', parent, 'reinstate', null))), { code: 'INVALID_TRANSITION' });
  assert.throws(() => prepare({ ...request(revision('new', parent)), conceptId: 'forged' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => prepare(request(revision(parent.eventId, parent))), { code: 'EVENT_CONFLICT' });
  assert.throws(() => prepare(request(revision('new', observation('another')))), { code: 'INVALID_PARENT' });
  assert.throws(() => prepareObservationRevision({ observation: parent, revisions: [revision('broken', parent, { previousEventId: 'missing' })],
    request: request(revision('new', parent)), recordedAt: NOW }), { code: 'INVALID_CHAIN' });
});
