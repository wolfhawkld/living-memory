import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEMO_HALF_LIFE_DAYS,
  createDemoRecord,
  extendDemoRecord,
  isDemoRecord,
  projectDemoSnapshot,
  type DemoRecord,
} from '../src/core/demo-snapshot.js';
import type { Concept, Snapshot } from '../src/shared/types.js';

const concepts: Concept[] = [
  {
    id: 'math:zeta',
    title: 'Zeta',
    aliases: [],
    domain: 'math',
    summary: 'z',
    body: 'z',
    source: { path: 'zeta.md', revision: 'rev-z' },
  },
  {
    id: 'math:alpha',
    title: 'Alpha',
    aliases: [],
    domain: 'math',
    summary: 'a',
    body: 'a',
    source: { path: 'alpha.md', revision: 'rev-a' },
  },
  {
    id: 'math:beta',
    title: 'Beta',
    aliases: [],
    domain: 'math',
    summary: 'b',
    body: 'b',
    source: { path: 'beta.md', revision: 'rev-b' },
  },
  {
    id: 'math:gamma',
    title: 'Gamma',
    aliases: [],
    domain: 'math',
    summary: 'g',
    body: 'g',
    source: { path: 'gamma.md', revision: 'rev-g' },
  },
];

const snapshot: Snapshot = {
  concepts,
  links: [{ id: 'alpha-beta', source: 'math:alpha', target: 'math:beta', type: 'related', description: '' }],
  source: { name: 'test', mode: 'local', conceptCount: concepts.length, limit: 20, diagnostics: [] },
  config: { modelVersion: 'time-only-v0', halfLifeDays: 14, revision: 4 },
  states: Object.fromEntries(concepts.map((concept) => [concept.id, {
    conceptId: concept.id,
    status: 'recent' as const,
    decay: 1,
    elapsedDays: 0,
    anchor: null,
    reason: null,
    asOf: '2026-01-01T00:00:00.000Z',
  }])),
  asOf: '2026-01-01T00:00:00.000Z',
  observationsCount: 9,
};

const demoStages: readonly (number | null)[] = [0, 3, 7, 10, 14, 21, 28, null];

function makeDemoSnapshot(count: number): Snapshot {
  const generatedConcepts: Concept[] = Array.from({ length: count }, (_, index) => ({
    id: `math:${String(index).padStart(3, '0')}`,
    title: `Concept ${index}`,
    aliases: [],
    domain: 'math',
    summary: `summary ${index}`,
    body: `body ${index}`,
    source: { path: `${index}.md`, revision: `rev-${index}` },
  }));
  return {
    ...snapshot,
    concepts: generatedConcepts,
    links: [],
    source: { ...snapshot.source, conceptCount: count },
    states: Object.fromEntries(generatedConcepts.map((concept) => [concept.id, {
      conceptId: concept.id,
      status: 'unknown' as const,
      decay: null,
      elapsedDays: null,
      anchor: null,
      reason: null,
      asOf: snapshot.asOf,
    }])),
  };
}

test('createDemoRecord assigns stable elapsed-day stages by sorted concept ID', () => {
  const record = createDemoRecord(snapshot, 'source:test');
  assert.equal(record.version, 1);
  assert.equal(record.mode, 'demo');
  assert.equal(record.modelVersion, 'time-only-v0');
  assert.equal(record.sourceId, 'source:test');
  assert.equal(record.halfLifeDays, DEMO_HALF_LIFE_DAYS);
  assert.deepEqual(record.assignments.map((item) => [item.conceptId, item.elapsedDays]), [
    ['math:alpha', 0],
    ['math:beta', 3],
    ['math:gamma', 7],
    ['math:zeta', 10],
  ]);
  assert.equal(isDemoRecord(record, 'source:test'), true);
  assert.equal(isDemoRecord(record, 'other-source'), false);
});

test('assignment cycle includes every initial color stage and then unknown', () => {
  const manyConcepts = Array.from({ length: 9 }, (_, index): Concept => ({
    ...concepts[0],
    id: `concept:${String(index).padStart(2, '0')}`,
    source: { path: `${index}.md`, revision: `rev-${index}` },
  }));
  const manySnapshot = { ...snapshot, concepts: manyConcepts };
  const record = createDemoRecord(manySnapshot, 'source:test');
  assert.deepEqual(record.assignments.map((item) => item.elapsedDays), [0, 3, 7, 10, 14, 21, 28, null, 0]);
});

test('extendDemoRecord expands 20 concepts to 87 with append-only stable stages', () => {
  const initialSnapshot = makeDemoSnapshot(20);
  const expandedSnapshot = makeDemoSnapshot(87);
  expandedSnapshot.concepts.reverse();
  const changedExistingConcept = expandedSnapshot.concepts.find((concept) => concept.id === 'math:000');
  assert.ok(changedExistingConcept);
  changedExistingConcept.source.revision = 'rev-0-changed';
  const initial = createDemoRecord(initialSnapshot, 'source:test', '2026-01-01T00:00:00Z');
  const initialBefore = structuredClone(initial);

  const extended = extendDemoRecord(expandedSnapshot, initial);

  assert.deepEqual(initial, initialBefore);
  assert.equal(extended.assignments.length, 87);
  assert.deepEqual(extended.assignments.slice(0, 20), initial.assignments);
  assert.deepEqual(
    extended.assignments.slice(20).map(({ conceptId, sourceRevision, elapsedDays }) => [
      conceptId,
      sourceRevision,
      elapsedDays,
    ]),
    Array.from({ length: 67 }, (_, offset) => {
      const index = offset + 20;
      return [`math:${String(index).padStart(3, '0')}`, `rev-${index}`, demoStages[index % demoStages.length]];
    }),
  );
  assert.equal(extended.assignments[0].sourceRevision, 'rev-0');
  assert.equal(extended.generatedAt, initial.generatedAt);
  assert.equal(extended.baseAsOf, initial.baseAsOf);
  assert.equal(extended.sourceId, initial.sourceId);
  assert.equal(extended.modelVersion, initial.modelVersion);
  assert.equal(extended.halfLifeDays, initial.halfLifeDays);
  assert.equal(extended.assignments[7].elapsedDays, null);
});

test('extendDemoRecord is idempotent, preserves removed assignments, and keeps true unknowns', () => {
  const initialSnapshot = makeDemoSnapshot(20);
  const expandedSnapshot = makeDemoSnapshot(87);
  const initial = createDemoRecord(initialSnapshot, 'source:test');
  const shrunkenSnapshot: Snapshot = {
    ...initialSnapshot,
    concepts: [initialSnapshot.concepts[19], initialSnapshot.concepts[3]],
  };
  const afterShrink = extendDemoRecord(shrunkenSnapshot, initial);
  const afterExpand = extendDemoRecord(expandedSnapshot, afterShrink);
  const directExpand = extendDemoRecord(expandedSnapshot, initial);

  assert.deepEqual(afterShrink, initial);
  assert.deepEqual(afterExpand, directExpand);
  assert.deepEqual(extendDemoRecord(expandedSnapshot, afterExpand), afterExpand);

  const projectedWithOldRecord = projectDemoSnapshot(expandedSnapshot, initial);
  assert.equal(projectedWithOldRecord.states['math:020'].status, 'unknown');
  assert.equal(projectedWithOldRecord.states['math:020'].anchor, null);
  assert.match(projectedWithOldRecord.states['math:020'].reason ?? '', /模拟起点/);
});

test('extendDemoRecord keeps old revisions so changed concepts remain pending', () => {
  const initialSnapshot = makeDemoSnapshot(20);
  const expandedSnapshot = makeDemoSnapshot(21);
  expandedSnapshot.concepts[0].source.revision = 'rev-0-changed';
  const initial = createDemoRecord(initialSnapshot, 'source:test');
  const extended = extendDemoRecord(expandedSnapshot, initial);
  const projected = projectDemoSnapshot(expandedSnapshot, extended);

  assert.equal(extended.assignments[0].sourceRevision, 'rev-0');
  assert.equal(extended.assignments[20].sourceRevision, 'rev-20');
  assert.equal(projected.states['math:000'].status, 'pending');
  assert.equal(projected.states['math:020'].status, 'stale');
});

test('projectDemoSnapshot uses synthetic anchors, fixed H=7, and preserves graph data', () => {
  const realSnapshot = structuredClone(snapshot);
  const realAnchor = {
    eventId: 'real-anchor',
    conceptId: 'math:alpha',
    sourceRevision: 'rev-a',
    occurredAt: '2025-01-01T00:00:00.000Z',
    recordedAt: '2025-01-01T00:00:00.000Z',
    kind: 'review' as const,
  };
  realSnapshot.states['math:alpha'].anchor = realAnchor;
  const record = createDemoRecord(snapshot, 'source:test');
  const projected = projectDemoSnapshot(realSnapshot, record);

  assert.equal(projected.config.halfLifeDays, 7);
  assert.equal(projected.config.modelVersion, 'time-only-v0');
  assert.equal(projected.observationsCount, 0);
  assert.equal(projected.links, realSnapshot.links);
  assert.equal(projected.concepts, realSnapshot.concepts);
  assert.equal(projected.states['math:alpha'].anchor?.eventId.startsWith('demo:'), true);
  assert.equal(projected.states['math:alpha'].anchor?.kind, 'estimated');
  assert.equal(projected.states['math:alpha'].reason?.includes('不是个人学习记录'), true);
  assert.equal(projected.states['math:alpha'].status, 'recent');
  assert.equal(projected.states['math:beta'].status, 'recent');
  assert.equal(projected.states['math:gamma'].status, 'revisit');
  assert.equal(projected.states['math:zeta'].status, 'revisit');
  assert.equal(projected.states['math:alpha'].elapsedDays, 0);
  assert.equal(projected.states['math:gamma'].elapsedDays, 7);
  assert.equal(projected.states['math:zeta'].elapsedDays, 10);
  assert.equal(projected.states['math:alpha'].decay, 1);
  assert.equal(projected.states['math:gamma'].decay, 0.5);
  assert.equal(realSnapshot.states['math:alpha'].anchor, realAnchor);
});

test('offset days advances synthetic anchors without changing their simulated start', () => {
  const record = createDemoRecord(snapshot, 'source:test', '2026-01-01T00:00:00Z');
  const projected = projectDemoSnapshot(snapshot, record, 14);
  assert.equal(projected.asOf, '2026-01-15T00:00:00.000Z');
  assert.equal(projected.states['math:alpha'].elapsedDays, 14);
  assert.equal(projected.states['math:alpha'].decay, 0.25);
  assert.equal(projected.states['math:alpha'].status, 'stale');
  assert.equal(projected.states['math:beta'].elapsedDays, 17);
  assert.equal(projected.states['math:gamma'].elapsedDays, 21);
  assert.equal(projected.states['math:gamma'].decay, 0.125);
  assert.equal(projected.states['math:alpha'].anchor?.occurredAt, '2026-01-01T00:00:00.000Z');
});

test('missing assignment stays unknown and never reads a real snapshot anchor', () => {
  const source = structuredClone(snapshot);
  source.states['math:alpha'].anchor = {
    eventId: 'real-anchor',
    conceptId: 'math:alpha',
    sourceRevision: 'rev-a',
    occurredAt: '2025-01-01T00:00:00.000Z',
    recordedAt: '2025-01-01T00:00:00.000Z',
    kind: 'review',
  };
  const record = createDemoRecord(snapshot, 'source:test');
  record.assignments = record.assignments.filter((item) => item.conceptId !== 'math:alpha');
  const projected = projectDemoSnapshot(source, record);
  assert.equal(projected.states['math:alpha'].status, 'unknown');
  assert.equal(projected.states['math:alpha'].anchor, null);
  assert.match(projected.states['math:alpha'].reason ?? '', /模拟起点/);
});

test('changed source revision becomes pending and keeps simulation context', () => {
  const changedSnapshot = structuredClone(snapshot);
  const changedConcept = changedSnapshot.concepts.find((concept) => concept.id === 'math:alpha');
  assert.ok(changedConcept);
  changedConcept.source.revision = 'rev-changed';
  const record = createDemoRecord(snapshot, 'source:test');
  const projected = projectDemoSnapshot(changedSnapshot, record);
  const changedId = changedConcept.id;
  assert.equal(projected.states[changedId].status, 'pending');
  assert.equal(projected.states[changedId].anchor?.sourceRevision, 'rev-a');
  assert.match(projected.states[changedId].reason ?? '', /模拟起点/);
});

test('demo record validation rejects invalid dates, elapsed days, duplicate IDs, and source mismatch', () => {
  const record = createDemoRecord(snapshot, 'source:test');
  const invalid = (change: (copy: DemoRecord) => void): DemoRecord => {
    const copy = structuredClone(record);
    change(copy);
    return copy;
  };

  assert.equal(isDemoRecord(invalid((copy) => { copy.generatedAt = 'not-a-date'; }), 'source:test'), false);
  assert.equal(isDemoRecord(invalid((copy) => { copy.baseAsOf = '2026-02-30T00:00:00Z'; }), 'source:test'), false);
  assert.equal(isDemoRecord(invalid((copy) => { copy.assignments[0].elapsedDays = Number.NaN; }), 'source:test'), false);
  assert.equal(isDemoRecord(invalid((copy) => { copy.assignments[0].elapsedDays = Number.POSITIVE_INFINITY; }), 'source:test'), false);
  assert.equal(isDemoRecord(invalid((copy) => { copy.assignments[0].elapsedDays = 1e20; }), 'source:test'), false);
  assert.equal(isDemoRecord(invalid((copy) => { copy.assignments[0].elapsedDays = -1; }), 'source:test'), false);
  assert.equal(isDemoRecord(invalid((copy) => { copy.assignments.push({ ...copy.assignments[0] }); }), 'source:test'), false);
  assert.equal(isDemoRecord(invalid((copy) => { copy.sourceId = 'source:other'; }), 'source:test'), false);
  assert.equal(isDemoRecord(invalid((copy) => { (copy as { halfLifeDays: number }).halfLifeDays = 14; }), 'source:test'), false);
  assert.throws(() => projectDemoSnapshot(snapshot, record, -0.1), /非负/);
  assert.throws(() => projectDemoSnapshot(snapshot, record, Number.NaN), /有限/);
  assert.throws(() => projectDemoSnapshot(snapshot, record, Number.POSITIVE_INFINITY), /有限/);
  assert.throws(() => projectDemoSnapshot(snapshot, invalid((copy) => { copy.baseAsOf = 'not-a-date'; })), /格式无效/);
  assert.throws(
    () => extendDemoRecord(snapshot, invalid((copy) => { copy.assignments[0].conceptId = ''; })),
    /格式无效/,
  );
});

test('create and project do not modify their inputs', () => {
  const snapshotBefore = structuredClone(snapshot);
  const record = createDemoRecord(snapshot, 'source:test');
  const recordBefore = structuredClone(record);
  const projected = projectDemoSnapshot(snapshot, record, 7);
  projected.states['math:alpha'].reason = 'changed in test';
  assert.deepEqual(snapshot, snapshotBefore);
  assert.deepEqual(record, recordBefore);
});
