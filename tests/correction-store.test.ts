import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store, StoreError, parseCorrectionRequest } from '../src/server/store.js';
import type { ApplicationRecordRequest, Concept, ExportData } from '../src/shared/types.js';
import type { ImportCommitRequest } from '../src/shared/import-data.js';
import type { CorrectionRequest } from '../src/shared/corrections.js';

const concept: Concept = {
  id: 'concept-alpha',
  title: 'Alpha',
  aliases: [],
  domain: 'Math',
  summary: 'summary',
  body: 'body',
  source: { path: 'Alpha.md', revision: 'rev-1' },
};

function fixture(namespace = 'correction-source', now = '2026-01-10T00:00:00.000Z', sharedDataDir?: string) {
  const dataDir = sharedDataDir ?? mkdtempSync(join(tmpdir(), 'living-memory-correction-store-'));
  const ownsDataDir = sharedDataDir === undefined;
  let currentNow = now;
  const store = new Store({ dataDir, namespace, now: () => new Date(currentNow) });
  return {
    store,
    dataDir,
    setNow(value: string) { currentNow = value; },
    cleanup(removeDataDir = ownsDataDir) { store.close(); if (removeDataDir) rmSync(dataDir, { recursive: true, force: true }); },
  };
}

function application(overrides: Partial<ApplicationRecordRequest> = {}): ApplicationRecordRequest {
  return {
    eventId: 'application-alpha',
    conceptId: concept.id,
    sourceRevision: concept.source.revision,
    occurredAt: '2026-01-01T00:00:00Z',
    kind: 'application',
    context: 'work',
    content: 'used the concept',
    outcome: 'partial',
    assistance: 'resources',
    result: 'found a gap',
    limitations: '',
    insight: '',
    correction: 'the original rule needs a boundary',
    references: '',
    ...overrides,
  };
}

function correction(overrides: Partial<CorrectionRequest> = {}): CorrectionRequest {
  return {
    eventId: 'correction-1',
    applicationEventId: 'application-alpha',
    conceptId: concept.id,
    sourceRevision: 'rev-2',
    occurredAt: '2026-01-02T00:00:00Z',
    previousEventId: null,
    status: 'resolved',
    note: '',
    ...overrides,
  };
}

function assertCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof StoreError && error.code === code);
}

test('correction requests are strict, idempotent, cross-event safe, and namespace isolated', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-correction-shared-'));
  const first = fixture('correction-a', '2026-01-10T00:00:00.000Z', dataDir);
  const second = fixture('correction-b', '2026-01-10T00:00:00.000Z', dataDir);
  try {
    assert.deepEqual(parseCorrectionRequest({ ...correction(), occurredAt: '2026-01-02T08:00:00+08:00', note: '  note  ' }), {
      ...correction(), occurredAt: '2026-01-02T00:00:00.000Z', note: '  note  ',
    });
    assertCode(() => parseCorrectionRequest({ ...correction(), status: 'unknown' }), 'INVALID_BODY');
    assertCode(() => parseCorrectionRequest({ ...correction(), eventId: 'bad id' }), 'INVALID_EVENT_ID');
    assertCode(() => parseCorrectionRequest({ ...correction(), occurredAt: '2026-01-02' }), 'INVALID_OCCURRED_AT');
    assertCode(() => parseCorrectionRequest({ ...correction(), note: 'x'.repeat(4001) }), 'INVALID_BODY');

    first.store.addApplication(application());
    assert.deepEqual(first.store.addCorrection(correction()), { status: 'accepted', eventId: 'correction-1' });
    assert.deepEqual(first.store.addCorrection(correction()), { status: 'duplicate', eventId: 'correction-1' });
    assertCode(() => first.store.addCorrection(correction({ status: 'open' })), 'EVENT_CONFLICT');

    assertCode(() => first.store.addApplication({ ...application(), eventId: 'correction-1' }), 'EVENT_CONFLICT');
    assert.equal(second.store.getCorrections().length, 0);
    second.store.addApplication({ ...application(), eventId: 'application-b' });
    assert.deepEqual(second.store.addCorrection({ ...correction(), eventId: 'correction-1', applicationEventId: 'application-b' }), { status: 'accepted', eventId: 'correction-1' });
    assert.equal(first.store.getCorrections().length, 1);
  } finally {
    first.cleanup();
    second.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('correction chain uses the explicit tail under a fixed clock and protects CAS', () => {
  const current = fixture();
  try {
    const { store } = current;
    store.addApplication(application());
    const first = correction({ eventId: 'correction-first', status: 'open', sourceRevision: 'rev-1' });
    const second = correction({ eventId: 'correction-second', status: 'resolved', previousEventId: first.eventId, occurredAt: first.occurredAt });
    assert.deepEqual(store.addCorrection(first), { status: 'accepted', eventId: first.eventId });
    assert.deepEqual(store.addCorrection(second), { status: 'accepted', eventId: second.eventId });
    assertCode(() => store.addCorrection(correction({ eventId: 'correction-stale', previousEventId: first.eventId })), 'CORRECTION_CONFLICT');
    assert.deepEqual(store.getCorrectionHistory('application-alpha', 50), {
      latest: store.getCorrections()[1],
      events: [store.getCorrections()[1], store.getCorrections()[0]],
      total: 2,
    });
    assert.equal(store.getCorrectionHistory('application-alpha', 1).events.length, 1);

    // A retry of the already accepted first decision remains a duplicate even
    // after the application has a newer correction and source revision.
    assert.deepEqual(store.addCorrection(first), { status: 'duplicate', eventId: first.eventId });
    assertCode(() => store.addCorrection({ ...second, eventId: 'correction-old-retry', previousEventId: null }), 'CORRECTION_CONFLICT');
  } finally {
    current.cleanup();
  }
});

test('parent, version, content, and date invariants reject without mutating the chain', () => {
  const current = fixture();
  try {
    const { store } = current;
    assertCode(() => store.addCorrection(correction()), 'APPLICATION_NOT_FOUND');
    store.addApplication(application({ correction: '' }));
    assertCode(() => store.addCorrection(correction()), 'INVALID_BODY');
    store.addApplication(application({ eventId: 'application-good' }));
    assertCode(() => store.addCorrection(correction({ applicationEventId: 'application-good', sourceRevision: 'rev-1' })), 'CORRECTION_SOURCE_UNCHANGED');
    assertCode(() => store.addCorrection(correction({ applicationEventId: 'application-good', occurredAt: '2025-12-31T23:59:59Z' })), 'CORRECTION_CONFLICT');
    assertCode(() => store.addCorrection(correction({ applicationEventId: 'application-good', occurredAt: '2026-01-11T00:00:00Z' })), 'FUTURE_EVENT');
    assertCode(() => store.addCorrection(correction({ applicationEventId: 'application-good', conceptId: 'other-concept' })), 'CORRECTION_CONFLICT');
    assert.equal(store.getCorrections().length, 0);
  } finally {
    current.cleanup();
  }
});

test('correction history is bounded, exported, persistent, and separate from memory projections', () => {
  const current = fixture();
  try {
    const { store } = current;
    store.addApplication(application());
    store.addReview({ eventId: 'anchor-latest', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review', occurredAt: '2026-01-09T00:00:00Z' });
    const before = store.getStates([concept], '2026-01-10T00:00:00Z')[concept.id];
    let previous: string | null = null;
    for (let index = 1; index <= 3; index += 1) {
      const event = correction({
        eventId: `correction-${index}`,
        previousEventId: previous,
        status: index === 3 ? 'resolved' : 'open',
        sourceRevision: index === 3 ? 'rev-2' : 'rev-1',
        occurredAt: `2026-01-0${index + 1}T00:00:00Z`,
      });
      store.addCorrection(event);
      previous = event.eventId;
    }
    const history = store.getCorrectionHistory('application-alpha', 2);
    assert.equal(history.latest?.eventId, 'correction-3');
    assert.deepEqual(history.events.map((event) => event.eventId), ['correction-3', 'correction-2']);
    assert.equal(history.total, 3);
    assert.equal(store.getCorrections(concept.id).length, 3);
    const conceptHistory = store.getConceptHistory(concept, '2026-01-10T00:00:00Z', 1);
    assert.equal(conceptHistory.total, 2);
    assert.equal(conceptHistory.correctionCount, 3);
    assert.deepEqual(Object.keys(conceptHistory.corrections ?? {}), []);
    const appPage = store.getConceptHistory(concept, '2026-01-10T00:00:00Z', 2);
    assert.deepEqual(Object.keys(appPage.corrections ?? {}), ['application-alpha']);
    assert.equal(appPage.corrections?.['application-alpha'].total, 3);
    assert.deepEqual(store.getStates([concept], '2026-01-10T00:00:00Z')[concept.id], before);
    assert.equal(store.countObservations(), 0);
    const exported = store.exportData({ name: 'test', mode: 'local', conceptCount: 1, limit: 1, diagnostics: [] }, [concept]);
    assert.deepEqual(exported.corrections, store.getCorrections());

    store.close();
    const reopened = new Store({ dataDir: current.dataDir, namespace: current.store.namespace, now: () => new Date('2026-01-10T00:00:00Z') });
    try {
      assert.equal(reopened.getCorrections().length, 3);
      assert.equal(reopened.getCorrectionHistory('application-alpha').latest?.eventId, 'correction-3');
    } finally {
      reopened.close();
    }
  } finally {
    // The store is closed explicitly before reopening in the persistence case.
    try { current.store.close(); } catch { /* already closed */ }
    rmSync(current.dataDir, { recursive: true, force: true });
  }
});

test('corrections import after applications, preserves chain dates, supports legacy exports, and rolls back atomically', () => {
  const donor = fixture('correction-donor');
  const target = fixture('correction-target');
  const source = { name: 'test', mode: 'local' as const, conceptCount: 1, limit: 1, diagnostics: [] };
  try {
    donor.store.addApplication(application({ eventId: 'application-import', correction: 'fix this' }));
    donor.store.addCorrection(correction({ eventId: 'import-correction-1', applicationEventId: 'application-import', status: 'open', sourceRevision: 'rev-1' }));
    donor.store.addCorrection(correction({
      eventId: 'import-correction-2', applicationEventId: 'application-import', previousEventId: 'import-correction-1',
      status: 'resolved', sourceRevision: 'rev-2', occurredAt: '2026-01-03T00:00:00Z',
    }));
    const data = donor.store.exportData(source, [concept]);
    const preview = target.store.previewImport(data, { restoreLayout: false, restoreReviewPlan: false }, source, [concept]);
    assert.equal(preview.canImport, true, JSON.stringify(preview.issues));
    assert.deepEqual(preview.counts.added, { anchors: 0, observations: 0, retentions: 0, applications: 1, corrections: 2 });
    const request: ImportCommitRequest = {
      data,
      options: { restoreLayout: false, restoreReviewPlan: false },
      importId: 'correction-import-1',
      previewToken: preview.token,
      confirmed: true,
    };
    const receipt = target.store.commitImport(request, source, [concept], () => 'backup-correction-1');
    assert.equal(receipt.status, 'accepted');
    assert.deepEqual(target.store.getCorrections(), data.corrections);
    assert.equal(target.store.getCorrectionHistory('application-import').latest?.eventId, 'import-correction-2');
    const duplicate = target.store.commitImport(request, source, [concept], () => { throw new Error('duplicate backup'); });
    assert.deepEqual(duplicate, { ...receipt, status: 'duplicate' });

    const legacy = { ...data } as ExportData;
    delete legacy.corrections;
    const legacyPreview = target.store.previewImport(legacy, { restoreLayout: false, restoreReviewPlan: false }, source, [concept]);
    assert.equal(legacyPreview.canImport, true, JSON.stringify(legacyPreview.issues));
    assert.equal(legacyPreview.counts.added.corrections, 0);

    const rollbackTarget = fixture('correction-rollback');
    try {
      const db = (rollbackTarget.store as unknown as { db: DatabaseSync }).db;
      db.exec(`CREATE TRIGGER fail_import_correction
        BEFORE INSERT ON corrections
        BEGIN SELECT RAISE(ABORT, 'forced correction import failure'); END;`);
      const rollbackPreview = rollbackTarget.store.previewImport(data, { restoreLayout: false, restoreReviewPlan: false }, source, [concept]);
      assert.throws(
        () => rollbackTarget.store.commitImport({ ...request, importId: 'correction-import-rollback', previewToken: rollbackPreview.token }, source, [concept], () => 'backup-rollback'),
        (error: unknown) => error instanceof StoreError && error.code === 'IMPORT_FAILED',
      );
      assert.equal(rollbackTarget.store.getApplications().length, 0);
      assert.equal(rollbackTarget.store.getCorrections().length, 0);
      db.exec('DROP TRIGGER fail_import_correction');
    } finally {
      rollbackTarget.cleanup();
    }
  } finally {
    donor.cleanup();
    target.cleanup();
  }
});
