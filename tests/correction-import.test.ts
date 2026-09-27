import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildImportPlan, type PreparedImport } from '../src/server/import-plan.js';
import type { CorrectionEvent } from '../src/shared/corrections.js';
import type { ApplicationRecord, Concept, ExportData } from '../src/shared/types.js';
import { MODEL_VERSION } from '../src/shared/types.js';

const now = '2026-01-10T00:00:00.000Z';

const liveConcept: Concept = {
  id: 'live-alpha',
  title: 'Alpha',
  aliases: [],
  domain: 'Math',
  summary: 'summary',
  body: 'body',
  source: { path: 'Alpha.md', revision: 'rev-1' },
};

function application(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    eventId: 'application-alpha',
    conceptId: liveConcept.id,
    sourceRevision: 'rev-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    recordedAt: '2026-01-01T00:01:00.000Z',
    kind: 'application',
    context: 'work',
    content: 'used the concept',
    outcome: 'partial',
    assistance: 'independent',
    result: 'found a gap',
    limitations: '',
    insight: '',
    correction: 'the original rule needs a boundary',
    references: '',
    ...overrides,
  };
}

function correction(overrides: Partial<CorrectionEvent> = {}): CorrectionEvent {
  return {
    eventId: 'correction-1',
    applicationEventId: 'application-alpha',
    conceptId: liveConcept.id,
    sourceRevision: 'rev-1',
    occurredAt: '2026-01-02T00:00:00.000Z',
    recordedAt: '2026-01-02T00:01:00.000Z',
    previousEventId: null,
    status: 'open',
    note: '',
    ...overrides,
  };
}

function exportData(overrides: Partial<ExportData> = {}): ExportData {
  return {
    schemaVersion: 1,
    exportedAt: '2026-01-09T00:00:00.000Z',
    source: { name: 'backup', mode: 'local', conceptCount: 1, limit: 20, diagnostics: [] },
    concepts: [{ id: liveConcept.id, title: liveConcept.title, source: liveConcept.source }],
    config: { modelVersion: MODEL_VERSION, halfLifeDays: 14, revision: 1 },
    configHistory: [{ modelVersion: MODEL_VERSION, halfLifeDays: 14, revision: 1 }],
    anchors: [],
    observations: [],
    retentions: [],
    applications: [application()],
    corrections: [],
    layout: {},
    ...overrides,
  };
}

function currentExport(overrides: Partial<ExportData> = {}): ExportData {
  return exportData({
    exportedAt: '2026-01-09T12:00:00.000Z',
    concepts: [{ id: liveConcept.id, title: liveConcept.title, source: liveConcept.source }],
    applications: [],
    corrections: [],
    ...overrides,
  });
}

function plan(data: ExportData, current = currentExport(), concepts: Concept[] = [liveConcept]): PreparedImport {
  return buildImportPlan({
    data,
    options: { restoreLayout: false, restoreReviewPlan: false },
    current,
    concepts,
    sourceId: 'target-source',
    now,
  });
}

function codes(prepared: PreparedImport): string[] {
  return prepared.preview.issues.map((issue) => issue.code);
}

test('imports corrections after applications, deduplicates an old prefix, and keeps legacy exports valid', () => {
  const first = correction({ eventId: 'correction-first', status: 'open', sourceRevision: 'rev-1' });
  const second = correction({
    eventId: 'correction-second', previousEventId: first.eventId, status: 'resolved', sourceRevision: 'rev-2',
    occurredAt: '2026-01-03T00:00:00.000Z', recordedAt: '2026-01-03T00:01:00.000Z',
  });
  const data = exportData({ corrections: [second, first] });
  const prepared = plan(data);
  assert.equal(prepared.preview.canImport, true, JSON.stringify(prepared.preview.issues));
  assert.deepEqual(prepared.preview.counts.added, { anchors: 0, observations: 0, retentions: 0, applications: 1, corrections: 2 });
  assert.deepEqual(prepared.newCorrections.map((event) => event.eventId), [first.eventId, second.eventId]);

  const live = currentExport({ applications: [application()], corrections: [first, second] });
  const retry = plan(exportData({ corrections: [first] }), live);
  assert.equal(retry.preview.canImport, true, JSON.stringify(retry.preview.issues));
  assert.equal(retry.preview.counts.added.corrections, 0);
  assert.equal(retry.preview.counts.duplicates, 2);
  assert.deepEqual(retry.newCorrections, []);

  const legacy = exportData();
  delete legacy.corrections;
  const legacyPlan = plan(legacy);
  assert.equal(legacyPlan.preview.canImport, true, JSON.stringify(legacyPlan.preview.issues));
  assert.equal(legacyPlan.preview.counts.added.corrections, 0);
  assert.deepEqual(legacyPlan.normalized.corrections, []);
});

test('reports orphan, cross-concept, cross-parent, branch, cycle, missing-link, and time errors', () => {
  const cases: Array<{ name: string; data: ExportData; code: string }> = [
    {
      name: 'orphan parent',
      data: exportData({ corrections: [correction({ applicationEventId: 'missing-application' })] }),
      code: 'CORRECTION_APPLICATION_NOT_FOUND',
    },
    {
      name: 'cross concept',
      data: exportData({ corrections: [correction({ conceptId: 'other-concept' })] }),
      code: 'CORRECTION_CONCEPT_MISMATCH',
    },
    {
      name: 'cross parent',
      data: exportData({
        applications: [application(), application({ eventId: 'application-other' })],
        corrections: [
          correction({ eventId: 'other-root', applicationEventId: 'application-other' }),
          correction({ eventId: 'wrong-parent', previousEventId: 'other-root' }),
        ],
      }),
      code: 'CORRECTION_APPLICATION_MISMATCH',
    },
    {
      name: 'branch',
      data: exportData({ corrections: [
        correction({ eventId: 'root' }),
        correction({ eventId: 'branch-a', previousEventId: 'root' }),
        correction({ eventId: 'branch-b', previousEventId: 'root' }),
      ] }),
      code: 'CORRECTION_BRANCH',
    },
    {
      name: 'cycle',
      data: exportData({ corrections: [
        correction({ eventId: 'cycle-a', previousEventId: 'cycle-b' }),
        correction({ eventId: 'cycle-b', previousEventId: 'cycle-a' }),
      ] }),
      code: 'CORRECTION_CYCLE',
    },
    {
      name: 'missing link',
      data: exportData({ corrections: [correction({ previousEventId: 'missing-correction' })] }),
      code: 'CORRECTION_PREVIOUS_NOT_FOUND',
    },
    {
      name: 'before application',
      data: exportData({ corrections: [correction({ occurredAt: '2025-12-31T23:59:00.000Z' })] }),
      code: 'CORRECTION_BEFORE_APPLICATION',
    },
    {
      name: 'before previous',
      data: exportData({ corrections: [
        correction({ eventId: 'time-root' }),
        correction({ eventId: 'time-child', previousEventId: 'time-root', occurredAt: '2026-01-01T23:59:00.000Z' }),
      ] }),
      code: 'CORRECTION_BEFORE_PREVIOUS',
    },
  ];
  for (const item of cases) {
    const prepared = plan(item.data);
    assert.equal(prepared.preview.canImport, false, item.name);
    assert.ok(codes(prepared).includes(item.code), `${item.name}: ${codes(prepared).join(',')}`);
  }

  const resolvedUnchanged = plan(exportData({ corrections: [correction({ status: 'resolved' })] }));
  assert.equal(resolvedUnchanged.preview.canImport, false);
  assert.ok(codes(resolvedUnchanged).includes('CORRECTION_SOURCE_REVISION_MISMATCH'));

  const future = plan(exportData({ corrections: [correction({ occurredAt: '2026-01-11T00:00:00.000Z', recordedAt: '2026-01-11T00:01:00.000Z' })] }));
  assert.ok(codes(future).includes('FUTURE_EVENT_DATE'));
  const recordedBefore = plan(exportData({ corrections: [correction({ recordedAt: '2026-01-01T23:00:00.000Z' })] }));
  assert.ok(codes(recordedBefore).includes('RECORDED_BEFORE_EVENT'));
});

test('orders equal-timestamp corrections by dependency rather than event ID', () => {
  const parent = correction({ eventId: 'z-parent', occurredAt: '2026-01-02T00:00:00.000Z', recordedAt: '2026-01-02T00:00:00.000Z' });
  const child = correction({ eventId: 'a-child', previousEventId: parent.eventId, occurredAt: parent.occurredAt, recordedAt: parent.recordedAt });
  const prepared = plan(exportData({ corrections: [child, parent] }));
  assert.equal(prepared.preview.canImport, true, JSON.stringify(prepared.preview.issues));
  assert.deepEqual(prepared.newCorrections.map((event) => event.eventId), [parent.eventId, child.eventId]);
});

test('maps concept IDs while preserving correction references, source revision, and original timestamps', () => {
  const backupId = 'backup-alpha';
  const backupConcept: ExportData['concepts'][number] = {
    id: backupId,
    title: 'Alpha',
    source: { path: liveConcept.source.path, revision: liveConcept.source.revision },
  };
  const backupCorrection = correction({
    eventId: 'mapped-correction', conceptId: backupId, sourceRevision: 'rev-old',
    occurredAt: '2026-01-02T08:00:00+08:00', recordedAt: '2026-01-02T08:01:00+08:00',
  });
  const prepared = plan(exportData({
    concepts: [backupConcept],
    applications: [application({ conceptId: backupId, sourceRevision: 'rev-old' })],
    corrections: [backupCorrection],
  }));
  assert.equal(prepared.preview.canImport, true, JSON.stringify(prepared.preview.issues));
  assert.equal(prepared.newApplications[0].conceptId, liveConcept.id);
  assert.equal(prepared.newCorrections[0].conceptId, liveConcept.id);
  assert.equal(prepared.newCorrections[0].applicationEventId, application().eventId);
  assert.equal(prepared.newCorrections[0].sourceRevision, 'rev-old');
  assert.equal(prepared.newCorrections[0].occurredAt, backupCorrection.occurredAt);
  assert.equal(prepared.newCorrections[0].recordedAt, backupCorrection.recordedAt);
});

test('validates a long single chain with linear previous traversal', () => {
  const length = 4000;
  const chain: CorrectionEvent[] = [];
  for (let index = length - 1; index >= 0; index -= 1) {
    const time = new Date(Date.parse('2026-01-02T00:00:00.000Z') + index).toISOString();
    chain.push(correction({
      eventId: `chain-${String(index).padStart(4, '0')}`,
      occurredAt: time,
      recordedAt: time,
      previousEventId: index === 0 ? null : `chain-${String(index - 1).padStart(4, '0')}`,
    }));
  }
  const prepared = plan(exportData({ corrections: chain }));
  assert.equal(prepared.preview.canImport, true, JSON.stringify(prepared.preview.issues.slice(0, 5)));
  assert.equal(prepared.newCorrections.length, length);
  assert.equal(prepared.newCorrections[0].eventId, 'chain-0000');
  assert.equal(prepared.newCorrections[length - 1].eventId, 'chain-3999');
});
