import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildImportPlan, type PreparedImport } from '../src/server/import-plan.js';
import type { Concept, ExportData } from '../src/shared/types.js';
import { MODEL_VERSION } from '../src/shared/types.js';
import { DEFAULT_IMPORT_OPTIONS, type ImportOptions } from '../src/shared/import-data.js';

const now = '2026-01-10T00:00:00.000Z';

const liveConcept: Concept = {
  id: 'live-alpha',
  title: 'Alpha',
  aliases: [],
  domain: 'Math',
  summary: 'summary',
  body: 'body',
  source: { path: 'Alpha.md', revision: 'rev-2' },
};

function baseExport(overrides: Partial<ExportData> = {}): ExportData {
  return {
    schemaVersion: 1,
    exportedAt: '2026-01-09T00:00:00.000Z',
    source: { name: 'backup', mode: 'local', conceptCount: 1, limit: 20, diagnostics: [] },
    concepts: [{ id: liveConcept.id, title: liveConcept.title, source: { path: 'Alpha.md', revision: 'rev-1' } }],
    config: { modelVersion: MODEL_VERSION, halfLifeDays: 14, revision: 2 },
    configHistory: [
      { modelVersion: MODEL_VERSION, halfLifeDays: 7, revision: 1 },
      { modelVersion: MODEL_VERSION, halfLifeDays: 14, revision: 2 },
    ],
    anchors: [{
      eventId: 'anchor-alpha', conceptId: liveConcept.id, sourceRevision: 'rev-1',
      occurredAt: '2026-01-01T00:00:00.000Z', recordedAt: '2026-01-01T00:01:00.000Z', kind: 'review',
    }],
    observations: [{
      eventId: 'observation-alpha', conceptId: liveConcept.id, sourceRevision: 'rev-1',
      observedAt: '2026-01-08T00:00:00.000Z', recordedAt: '2026-01-08T00:01:00.000Z',
      configRevision: 1, halfLifeDays: 7, anchorEventId: 'anchor-alpha', elapsedDays: 7, decay: 0.5,
      answer: 'answer', rating: 'partial', exposure: 'unexposed', observedExposure: false,
    }],
    retentions: [
      { eventId: 'retention-set', conceptId: liveConcept.id, sourceRevision: 'rev-1', occurredAt: '2026-01-02T00:00:00.000Z', recordedAt: '2026-01-02T00:01:00.000Z', active: true, previousEventId: null },
      { eventId: 'retention-clear', conceptId: liveConcept.id, sourceRevision: 'rev-1', occurredAt: '2026-01-03T00:00:00.000Z', recordedAt: '2026-01-03T00:01:00.000Z', active: false, previousEventId: 'retention-set' },
    ],
    applications: [{
      eventId: 'application-alpha', conceptId: liveConcept.id, sourceRevision: 'rev-1',
      occurredAt: '2026-01-04T00:00:00.000Z', recordedAt: '2026-01-04T00:01:00.000Z', kind: 'application',
      context: 'context', content: 'content', outcome: 'success', assistance: 'independent', result: 'result',
      limitations: '', insight: 'insight', correction: '', references: '',
    }],
    reviewPlan: { revision: 2, dailyBudget: 3, concepts: { [liveConcept.id]: { focus: true, deferUntil: '2026-01-11T00:00:00.000Z' } } },
    layout: { [liveConcept.id]: { x: 1, y: 2, z: 3 } },
    restoreMetadata: {
      sourceId: 'old-source',
      anchorRequests: [{ eventId: 'anchor-alpha', conceptId: liveConcept.id, sourceRevision: 'rev-1', kind: 'review' }],
      configRecordedAt: { '1': '2026-01-01T00:00:00.000Z', '2': '2026-01-05T00:00:00.000Z' },
    },
    ...overrides,
  };
}

function currentExport(overrides: Partial<ExportData> = {}): ExportData {
  return {
    ...baseExport({
      exportedAt: '2026-01-09T12:00:00.000Z',
      concepts: [{ id: liveConcept.id, title: liveConcept.title, source: liveConcept.source }],
      config: { modelVersion: MODEL_VERSION, halfLifeDays: 7, revision: 1 },
      configHistory: [{ modelVersion: MODEL_VERSION, halfLifeDays: 7, revision: 1 }],
      anchors: [], observations: [], retentions: [], applications: [],
      reviewPlan: { revision: 0, dailyBudget: 5, concepts: {} }, layout: {},
      restoreMetadata: undefined,
    }),
    ...overrides,
  };
}

function plan(data: ExportData, options: ImportOptions = { restoreLayout: true, restoreReviewPlan: true }, current = currentExport()): PreparedImport {
  return buildImportPlan({ data, options, current, concepts: [liveConcept], sourceId: 'target-source', now });
}

test('builds a pure mapped plan, preserves frozen values, and orders retention by chain', () => {
  const data = baseExport();
  const before = JSON.stringify(data);
  const prepared = plan(data);
  assert.equal(prepared.preview.canImport, true);
  assert.equal(prepared.preview.counts.added.anchors, 1);
  assert.equal(prepared.preview.counts.added.observations, 1);
  assert.equal(prepared.preview.counts.added.retentions, 2);
  assert.equal(prepared.preview.counts.added.applications, 1);
  assert.equal(prepared.preview.counts.configurations, 1);
  assert.equal(prepared.newObservations[0].elapsedDays, 7);
  assert.equal(prepared.newObservations[0].decay, 0.5);
  assert.deepEqual(prepared.newRetentions.map((event) => event.eventId), ['retention-set', 'retention-clear']);
  assert.equal(prepared.normalized.observations[0].conceptId, liveConcept.id);
  assert.equal(prepared.mergedLayout[liveConcept.id].x, 1);
  assert.equal(prepared.mergedReviewPlan.concepts[liveConcept.id].focus, true);
  assert.equal(prepared.anchorRequests['anchor-alpha'].occurredAt, undefined);
  assert.equal(JSON.stringify(data), before);
  assert.ok(prepared.preview.issues.some((issue) => issue.code === 'BACKUP_SOURCE_ID'));
  assert.ok(prepared.preview.issues.some((issue) => issue.code === 'OLD_SOURCE_REVISION'));
});

test('accepts exact duplicate events and rejects a changed payload without mutating the target preview input', () => {
  const data = baseExport({ restoreMetadata: undefined });
  const current = currentExport({ anchors: [baseExport().anchors[0]] });
  const duplicate = plan(data, DEFAULT_IMPORT_OPTIONS, current);
  assert.equal(duplicate.preview.canImport, true);
  assert.equal(duplicate.preview.counts.duplicates, 1);
  assert.equal(duplicate.preview.counts.added.anchors, 0);

  const changed = baseExport({ anchors: [{ ...baseExport().anchors[0], kind: 'estimated' }], restoreMetadata: undefined });
  const conflict = plan(changed, DEFAULT_IMPORT_OPTIONS, current);
  assert.equal(conflict.preview.canImport, false);
  assert.ok(conflict.preview.issues.some((issue) => issue.code === 'EVENT_CONFLICT'));
});

test('checks the frozen observation against its historical configuration and anchor', () => {
  const mismatch = baseExport({ observations: [{ ...baseExport().observations[0], decay: 0.25 }] });
  const prepared = plan(mismatch);
  assert.equal(prepared.preview.canImport, false);
  assert.ok(prepared.preview.issues.some((issue) => issue.code === 'FROZEN_DECAY_MISMATCH'));

  const missingConfig = baseExport({ observations: [{ ...baseExport().observations[0], configRevision: 3 }] });
  const missing = plan(missingConfig);
  assert.equal(missing.preview.canImport, false);
  assert.ok(missing.preview.issues.some((issue) => issue.code === 'CONFIG_REVISION_UNKNOWN'));
});

test('flags future records, exposure mismatch, and unsupported model versions', () => {
  const future = baseExport({ anchors: [{ ...baseExport().anchors[0], occurredAt: '2026-01-11T00:00:00.000Z', recordedAt: '2026-01-11T00:00:00.000Z' }] });
  const futurePlan = plan(future);
  assert.equal(futurePlan.preview.canImport, false);
  assert.ok(futurePlan.preview.issues.some((issue) => issue.code === 'FUTURE_EVENT_DATE'));

  const exposure = baseExport({ observations: [{ ...baseExport().observations[0], exposure: 'unexposed', observedExposure: true }] });
  assert.throws(() => plan(exposure), /observedExposure/);

  assert.throws(() => plan(baseExport({ config: { modelVersion: 'other' as typeof MODEL_VERSION, halfLifeDays: 14, revision: 2 } })), /不受支持/);
});

test('maps by exact path and revision, preserves unresolved histories, and includes referenced IDs in matches', () => {
  const oldId = 'backup-alpha';
  const data = baseExport({
    concepts: [{ id: oldId, title: 'Alpha', source: { path: 'Alpha.md', revision: 'rev-2' } }],
    anchors: [{ ...baseExport().anchors[0], conceptId: oldId, sourceRevision: 'rev-2' }],
    observations: [], retentions: [], applications: [],
    layout: { [oldId]: { x: 1, y: 1, z: 1 } },
    restoreMetadata: undefined,
  });
  const prepared = buildImportPlan({ data, options: { restoreLayout: true, restoreReviewPlan: false }, current: currentExport(), concepts: [liveConcept], sourceId: 'target-source', now });
  assert.equal(prepared.preview.matches.find((match) => match.fromId === oldId)?.match, 'path-revision');
  assert.equal(prepared.newAnchors[0].conceptId, liveConcept.id);

  const unresolved = baseExport({ concepts: [{ id: oldId, title: 'Alpha', source: { path: 'Alpha.md', revision: 'rev-old' } }], anchors: [], observations: [], retentions: [], applications: [], restoreMetadata: undefined });
  const unresolvedPlan = plan(unresolved);
  assert.equal(unresolvedPlan.preview.counts.unresolvedConcepts, 1);
  assert.equal(unresolvedPlan.preview.matches.find((match) => match.fromId === oldId)?.toId, null);
});

test('retention chains reject branches but allow a historical backfill order', () => {
  const base = baseExport().retentions![0];
  const branch = baseExport({ retentions: [
    base,
    { ...base, eventId: 'retention-root-2', occurredAt: '2026-01-04T00:00:00.000Z', recordedAt: '2026-01-04T00:01:00.000Z' },
  ], anchors: [], observations: [], applications: [], restoreMetadata: undefined });
  const branchPlan = plan(branch);
  assert.equal(branchPlan.preview.canImport, false);
  assert.ok(branchPlan.preview.issues.some((issue) => issue.code === 'RETENTION_BRANCH'));

  const backfill = baseExport({ retentions: [{ ...base, occurredAt: '2026-01-05T00:00:00.000Z', recordedAt: '2026-01-06T00:00:00.000Z' }, { ...baseExport().retentions![1], occurredAt: '2026-01-02T00:00:00.000Z', recordedAt: '2026-01-03T00:00:00.000Z' }], anchors: [], observations: [], applications: [], restoreMetadata: undefined });
  assert.equal(plan(backfill).preview.canImport, true);
});

test('token is stable across current export time and event collection ordering', () => {
  const data = baseExport();
  const first = plan(data).preview.token;
  const reordered = baseExport({
    anchors: [...data.anchors].reverse(), observations: [...data.observations].reverse(),
    retentions: [...data.retentions!].reverse(), applications: [...data.applications!].reverse(),
  });
  const current = currentExport({ exportedAt: '2026-01-10T00:00:00.000Z' });
  assert.equal(plan(reordered, { restoreLayout: true, restoreReviewPlan: true }, current).preview.token, first);
});

test('prototype-like layout and plan keys are treated as data', () => {
  const data = baseExport({ layout: JSON.parse('{"__proto__":{"x":1,"y":2,"z":3}}') as ExportData['layout'], reviewPlan: { revision: 1, dailyBudget: 2, concepts: JSON.parse('{"__proto__":{"focus":true,"deferUntil":null}}') } });
  const prepared = plan(data);
  assert.equal(prepared.preview.canImport, true);
  assert.ok(Object.prototype.hasOwnProperty.call(prepared.mergedLayout, '__proto__'));
  assert.ok(Object.prototype.hasOwnProperty.call(prepared.mergedReviewPlan.concepts, '__proto__'));
});

test('legacy v1 without restoreMetadata is importable with an explicit warning', () => {
  const data = baseExport();
  delete data.restoreMetadata;
  const prepared = plan(data);
  assert.equal(prepared.preview.canImport, true);
  assert.ok(prepared.preview.issues.some((issue) => issue.code === 'LEGACY_RESTORE_METADATA'));
  assert.equal(prepared.normalized.restoreMetadata?.configRecordedAt['1'], data.exportedAt);
});

test('anchor requests must match anchors and estimated requests require occurredAt', () => {
  const invalid = baseExport({ anchors: [{ ...baseExport().anchors[0], kind: 'estimated' }], restoreMetadata: {
    sourceId: 'old-source',
    anchorRequests: [{ eventId: 'anchor-alpha', conceptId: liveConcept.id, sourceRevision: 'rev-1', kind: 'estimated' }],
    configRecordedAt: {},
  } });
  assert.throws(() => plan(invalid), /estimated anchor request/);
});

test('does not treat application evidence as a recall or configuration event', () => {
  const data = baseExport({ anchors: [], observations: [], retentions: [], restoreMetadata: undefined, configHistory: [{ modelVersion: MODEL_VERSION, halfLifeDays: 7, revision: 1 }], config: { modelVersion: MODEL_VERSION, halfLifeDays: 7, revision: 1 } });
  const prepared = plan(data);
  assert.equal(prepared.preview.canImport, true);
  assert.equal(prepared.newApplications.length, 1);
  assert.equal(prepared.newAnchors.length, 0);
  assert.equal(prepared.newObservations.length, 0);
  assert.equal(prepared.newConfigs.length, 0);
});
