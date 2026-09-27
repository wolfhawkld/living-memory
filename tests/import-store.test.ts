import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/server/store.js';
import { StoreError } from '../src/server/store.js';
import { DEFAULT_IMPORT_OPTIONS, type ImportCommitRequest, type ImportReceipt } from '../src/shared/import-data.js';
import type { Concept, ExportData } from '../src/shared/types.js';

const concept: Concept = {
  id: 'concept-alpha',
  title: 'Alpha',
  aliases: [],
  domain: 'Math',
  summary: 'summary',
  body: 'body',
  source: { path: 'Math/Alpha.md', revision: 'rev-1' },
};

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-import-store-'));
  const store = new Store({ dataDir, namespace: 'import-source', now: () => new Date('2026-01-10T12:00:00.000Z') });
  return {
    store,
    dataDir,
    cleanup() { store.close(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

const source = { name: 'test', mode: 'local' as const, conceptCount: 1, limit: 1, diagnostics: [] };

function cleanStore(namespace: string, now = '2026-01-10T12:00:00.000Z') {
  const dataDir = mkdtempSync(join(tmpdir(), `living-memory-import-${namespace}-`));
  const store = new Store({ dataDir, namespace, now: () => new Date(now) });
  return {
    store,
    dataDir,
    cleanup() { store.close(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

function recoveryExport(): { donor: ReturnType<typeof cleanStore>; data: ExportData } {
  const donor = cleanStore('donor-import');
  const { store } = donor;
  store.addReview({ eventId: 'anchor-implicit', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review' });
  store.addReview({ eventId: 'anchor-explicit', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review', occurredAt: '2026-01-08T12:00:00Z' });
  store.updateConfig(14, 1);
  store.addObservation({
    eventId: 'observation-frozen', conceptId: concept.id, sourceRevision: concept.source.revision,
    observedAt: '2026-01-09T12:00:00Z', configRevision: 2, anchorEventId: 'anchor-explicit',
    answer: 'remembered', rating: 'partial', exposure: 'exposed', observedExposure: true,
  }, 'anchor-explicit');
  store.addRetention({
    eventId: 'retention-root', conceptId: concept.id, sourceRevision: concept.source.revision,
    occurredAt: '2026-01-08T13:00:00Z', active: true, previousEventId: null,
  }, null);
  store.addRetention({
    eventId: 'retention-child', conceptId: concept.id, sourceRevision: concept.source.revision,
    occurredAt: '2026-01-09T13:00:00Z', active: false, previousEventId: 'retention-root',
  }, 'retention-root');
  store.addApplication({
    eventId: 'application-private', conceptId: concept.id, sourceRevision: concept.source.revision,
    occurredAt: '2026-01-09T14:00:00Z', kind: 'application', context: 'work task', content: 'used the idea',
    outcome: 'success', assistance: 'independent', result: 'done', limitations: '', insight: 'useful', correction: '', references: '',
  });
  store.setLayout({ [concept.id]: { x: 1, y: 2, z: 3 } });
  store.updateReviewPlan({ revision: 0, dailyBudget: 9 });
  store.updateReviewPlan({ revision: 1, concept: { conceptId: concept.id, sourceRevision: concept.source.revision, focus: true, deferUntil: '2026-01-11T12:00:00Z' } });
  return { donor, data: store.exportData(source, [concept]) };
}

test('export preserves recovery metadata needed for exact anchor retries and config history', () => {
  const current = fixture();
  try {
    const { store } = current;
    store.addReview({ eventId: 'review-implicit-time', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review' });
    store.addReview({ eventId: 'review-explicit-time', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review', occurredAt: '2026-01-09T12:00:00Z' });
    store.addReview({ eventId: 'estimated-explicit-time', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'estimated', occurredAt: '2026-01-08T12:00:00Z' });
    assert.equal(store.updateConfig(14, 1).revision, 2);

    const exported = store.exportData({ name: 'test', mode: 'local', conceptCount: 1, limit: 1, diagnostics: [] }, [concept]);
    assert.equal(exported.restoreMetadata?.sourceId, 'import-source');
    assert.deepEqual(exported.restoreMetadata?.configRecordedAt, {
      '1': '2026-01-10T12:00:00.000Z',
      '2': '2026-01-10T12:00:00.000Z',
    });
    const requests = exported.restoreMetadata?.anchorRequests ?? [];
    const implicit = requests.find((item) => item.eventId === 'review-implicit-time');
    const explicit = requests.find((item) => item.eventId === 'review-explicit-time');
    const estimated = requests.find((item) => item.eventId === 'estimated-explicit-time');
    assert.ok(implicit && explicit && estimated);
    assert.equal(Object.prototype.hasOwnProperty.call(implicit, 'occurredAt'), false);
    assert.equal(explicit.occurredAt, '2026-01-09T12:00:00.000Z');
    assert.equal(estimated.occurredAt, '2026-01-08T12:00:00.000Z');
    assert.deepEqual(exported.concepts, [{ id: concept.id, title: concept.title, source: concept.source }]);
  } finally {
    current.cleanup();
  }
});

test('recovery tables are additive and namespace isolated', () => {
  const current = fixture();
  const other = new Store({ dataDir: current.dataDir, namespace: 'other-import-source', now: () => new Date('2026-01-10T12:00:00.000Z') });
  try {
    const db = new DatabaseSync(join(current.dataDir, 'living-memory.sqlite'));
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('imported_concepts', 'import_receipts') ORDER BY name").all() as Array<{ name: string }>;
      assert.deepEqual(tables.map((row) => row.name), ['import_receipts', 'imported_concepts']);
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM imported_concepts WHERE namespace = ?').get('import-source') as { count: number }).count, 0);
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM import_receipts WHERE namespace = ?').get('other-import-source') as { count: number }).count, 0);
    } finally {
      db.close();
    }
    assert.equal(current.store.exportData({ name: 'current', mode: 'local', conceptCount: 1, limit: 1, diagnostics: [] }, [concept]).restoreMetadata?.sourceId, 'import-source');
    assert.equal(other.exportData({ name: 'other', mode: 'local', conceptCount: 0, limit: 1, diagnostics: [] }, []).concepts.length, 0);
  } finally {
    other.close();
    current.cleanup();
  }
});

test('export imports frozen history, config times, retention chain, applications, layout and plan atomically', () => {
  const { donor, data } = recoveryExport();
  const target = cleanStore('target-import');
  try {
    const options = { restoreLayout: true, restoreReviewPlan: true };
    const before = target.store.exportData(source, [concept]);
    const preview = target.store.previewImport(data, options, source, [concept]);
    assert.equal(preview.canImport, true, JSON.stringify(preview.issues));
    assert.deepEqual(preview.counts.added, { anchors: 2, observations: 1, retentions: 2, applications: 1, corrections: 0 });
    assert.equal(preview.counts.configurations, 1);
    assert.equal(preview.layoutChanged, true);
    assert.equal(preview.reviewPlanChanged, true);
    assert.deepEqual(target.store.exportData(source, [concept]).anchors, before.anchors);

    const request: ImportCommitRequest = {
      data,
      options,
      importId: 'restore-1',
      previewToken: preview.token,
      confirmed: true,
    };
    let backups = 0;
    const receipt = target.store.commitImport(request, source, [concept], (backup) => {
      backups += 1;
      assert.deepEqual(backup.anchors, before.anchors);
      return 'backup-restore-1';
    });
    assert.equal(receipt.status, 'accepted');
    assert.equal(backups, 1);
    assert.equal(target.store.getAnchors().length, 2);
    assert.equal(target.store.getObservations().length, 1);
    assert.equal(target.store.getRetentions().length, 2);
    assert.equal(target.store.getApplications().length, 1);
    assert.deepEqual(target.store.getObservations(), data.observations);
    assert.deepEqual(target.store.getRetentions(), data.retentions);
    assert.deepEqual(target.store.getApplications(), data.applications);
    assert.deepEqual(target.store.getConfigHistory(), data.configHistory);
    assert.deepEqual(target.store.getLayout(), data.layout);
    assert.deepEqual(target.store.getReviewPlan(), {
      revision: 1,
      dailyBudget: 9,
      concepts: { [concept.id]: { focus: true, deferUntil: '2026-01-11T12:00:00.000Z' } },
    });

    const duplicate = target.store.commitImport(request, source, [concept], () => {
      throw new Error('duplicate must not write another backup');
    });
    assert.deepEqual(duplicate, { ...receipt, status: 'duplicate' });
    assert.equal(target.store.getObservations().length, 1);

    const replayPreview = target.store.previewImport(data, options, source, [concept]);
    assert.equal(replayPreview.canImport, true, JSON.stringify(replayPreview.issues));
    assert.equal(replayPreview.counts.duplicates, 6);
    assert.deepEqual(replayPreview.counts.added, { anchors: 0, observations: 0, retentions: 0, applications: 0, corrections: 0 });
    const replay: ImportCommitRequest = { ...request, importId: 'restore-2', previewToken: replayPreview.token };
    const replayReceipt = target.store.commitImport(replay, source, [concept], () => 'backup-restore-2');
    assert.equal(replayReceipt.status, 'accepted');
    assert.equal(target.store.getObservations().length, 1);
  } finally {
    target.cleanup();
    donor.cleanup();
  }
});

test('import receipt is persistent, same importId conflicts, stale previews and backup failures leave data unchanged', () => {
  const { donor, data } = recoveryExport();
  const target = cleanStore('target-import-retry');
  try {
    const options = { ...DEFAULT_IMPORT_OPTIONS };
    const preview = target.store.previewImport(data, options, source, [concept]);
    const request: ImportCommitRequest = { data, options, importId: 'retry-1', previewToken: preview.token, confirmed: true };
    assert.throws(
      () => target.store.commitImport(request, source, [concept], () => { throw new StoreError('IMPORT_BACKUP_FAILED', 'backup failed', 503); }),
      (error: unknown) => error instanceof StoreError && error.code === 'IMPORT_BACKUP_FAILED',
    );
    assert.equal(target.store.getAnchors().length, 0);
    const accepted = target.store.commitImport(request, source, [concept], () => 'backup-retry-1');
    assert.equal(accepted.status, 'accepted');
    const duplicate = target.store.commitImport(request, source, [concept], () => 'must-not-run');
    assert.deepEqual(duplicate, { ...accepted, status: 'duplicate' });
    assert.throws(
      () => target.store.commitImport({ ...request, data: { ...data, exportedAt: '2026-01-10T11:59:59Z' } }, source, [concept], () => 'unused'),
      (error: unknown) => error instanceof StoreError && error.code === 'IMPORT_CONFLICT',
    );

    const staleTarget = cleanStore('target-import-stale');
    try {
      const stalePreview = staleTarget.store.previewImport(data, options, source, [concept]);
      staleTarget.store.addReview({ eventId: 'local-change', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review' });
      assert.throws(
        () => staleTarget.store.commitImport({ ...request, importId: 'stale-1', previewToken: stalePreview.token }, source, [concept], () => 'must-not-run'),
        (error: unknown) => error instanceof StoreError && error.code === 'IMPORT_STALE',
      );
      assert.equal(staleTarget.store.getAnchors().length, 1);
      assert.equal(staleTarget.store.hasEvent('anchor-implicit'), false);
    } finally {
      staleTarget.cleanup();
    }
  } finally {
    target.cleanup();
    donor.cleanup();
  }
});

test('SQL failure rolls back every import mutation and a committed receipt survives Store restart', () => {
  const { donor, data } = recoveryExport();
  const target = cleanStore('target-import-transaction');
  try {
    const options = { restoreLayout: true, restoreReviewPlan: true };
    const preview = target.store.previewImport(data, options, source, [concept]);
    const request: ImportCommitRequest = {
      data, options, importId: 'transaction-1', previewToken: preview.token, confirmed: true,
    };
    const before = target.store.exportData(source, [concept]);
    const db = (target.store as unknown as { db: DatabaseSync }).db;
    db.exec(`CREATE TRIGGER fail_import_application
      BEFORE INSERT ON applications
      BEGIN SELECT RAISE(ABORT, 'forced import failure'); END;`);
    assert.throws(
      () => target.store.commitImport(request, source, [concept], () => 'backup-before-abort'),
      (error: unknown) => error instanceof StoreError && error.code === 'IMPORT_FAILED',
    );
    db.exec('DROP TRIGGER fail_import_application');
    const afterRollback = target.store.exportData(source, [concept]);
    assert.deepEqual(afterRollback, before);
    assert.equal(target.store.hasEvent('anchor-implicit'), false);
    assert.equal(target.store.hasEvent('observation-frozen'), false);
    assert.equal(target.store.hasEvent('retention-root'), false);
    assert.equal(target.store.hasEvent('application-private'), false);

    const accepted = target.store.commitImport(request, source, [concept], () => 'backup-after-abort');
    assert.equal(accepted.status, 'accepted');
    target.store.close();
    const reopened = new Store({ dataDir: target.dataDir, namespace: 'target-import-transaction', now: () => new Date('2026-01-10T12:00:00.000Z') });
    try {
      const duplicate = reopened.commitImport(request, source, [concept], () => {
        throw new Error('persistent duplicate must not invoke backup');
      });
      assert.deepEqual(duplicate, { ...accepted, status: 'duplicate' });
      assert.equal(reopened.getApplications().length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    // target.store is closed above after the successful commit; avoid closing
    // the same DatabaseSync handle twice in the cleanup helper.
    try { target.store.close(); } catch { /* already closed after restart check */ }
    rmSync(target.dataDir, { recursive: true, force: true });
    donor.cleanup();
  }
});
