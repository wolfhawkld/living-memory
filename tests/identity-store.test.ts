import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store, StoreError } from '../src/server/store.js';
import { DEFAULT_IMPORT_OPTIONS } from '../src/shared/import-data.js';
import type { IdentityLinkPreview } from '../src/shared/identity.js';
import type { Concept, ExportData } from '../src/shared/types.js';

const NOW = '2026-01-02T01:00:00.000Z';
const source = { name: 'identity-test', mode: 'local' as const, conceptCount: 1, limit: 100, diagnostics: [] };

function concept(id: string, path: string, revision: string, title = id): Concept {
  return {
    id,
    title,
    aliases: [],
    domain: 'test',
    summary: title,
    body: `${title} body`,
    source: { path, revision },
  };
}

function fixture(namespace = 'identity-store-test') {
  const dataDir = mkdtempSync(join(tmpdir(), `${namespace}-`));
  const store = new Store({ dataDir, namespace, now: () => new Date(NOW) });
  return {
    store,
    dataDir,
    cleanup() {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function prepareLearnedIdentity(store: Store, old: Concept, target: Concept): void {
  store.rememberConcepts([old, target]);
  store.addReview({
    eventId: 'old-anchor', conceptId: old.id, sourceRevision: old.source.revision,
    kind: 'review', occurredAt: '2026-01-01T01:00:00Z',
  });
  store.addObservation({
    eventId: 'old-observation', conceptId: old.id, sourceRevision: old.source.revision,
    observedAt: '2026-01-01T02:00:00Z', configRevision: 1, anchorEventId: 'old-anchor',
    answer: 'remembered', rating: 'partial', exposure: 'exposed', observedExposure: true,
  }, 'old-anchor');
  store.addRetention({
    eventId: 'old-retention', conceptId: old.id, sourceRevision: old.source.revision,
    occurredAt: '2026-01-01T03:00:00Z', active: true, previousEventId: null,
  }, null);
  store.addApplication({
    eventId: 'old-application', conceptId: old.id, sourceRevision: old.source.revision,
    occurredAt: '2026-01-01T04:00:00Z', kind: 'application', context: 'test', content: 'used',
    outcome: 'success', assistance: 'independent', result: 'done', limitations: '',
    insight: '', correction: '', references: '',
  });
  store.setLayout({ [old.id]: { x: 1, y: 2, z: 3 }, [target.id]: { x: 9, y: 8, z: 7 } });
  store.updateReviewPlan({ revision: 0, concept: {
    conceptId: old.id, sourceRevision: old.source.revision, focus: true, deferUntil: null,
  } });
}

function preview(store: Store, old: Concept, target: Concept): IdentityLinkPreview {
  return store.previewIdentityLink(
    { fromConceptId: old.id, toConceptId: target.id },
    source,
    [target],
  );
}

function commit(store: Store, old: Concept, target: Concept, operationId: string, previewToken: string, beforeWrite?: (backup: ExportData) => string) {
  return store.commitIdentityLink(
    { fromConceptId: old.id, toConceptId: target.id, operationId, previewToken, confirmed: true },
    source,
    [target],
    beforeWrite ?? (() => 'backup-test'),
  );
}

test('remember refreshes catalog metadata without deleting disconnected concepts', () => {
  const fixtureData = fixture();
  try {
    const old = concept('stable-a', 'Math/Alpha.md', 'rev-a', 'Alpha');
    fixtureData.store.rememberConcepts([old]);
    fixtureData.store.rememberConcepts([concept(old.id, 'Moved/Alpha.md', 'rev-b', 'Renamed Alpha')]);
    fixtureData.store.rememberConcepts([concept('disconnected-b', 'Other/Beta.md', 'rev-b', 'Beta')]);
    const status = fixtureData.store.getIdentityStatus([]);
    assert.deepEqual(status.orphans.map(item => ({ id: item.conceptId, title: item.title, path: item.path, revision: item.sourceRevision })), [
      { id: 'disconnected-b', title: 'Beta', path: 'Other/Beta.md', revision: 'rev-b' },
      { id: 'stable-a', title: 'Renamed Alpha', path: 'Moved/Alpha.md', revision: 'rev-b' },
    ]);
  } finally {
    fixtureData.cleanup();
  }
});

test('status and link commit preserve all history, layout and old review-plan identity', () => {
  const fixtureData = fixture();
  try {
    const old = concept('stable-a', 'Math/Alpha.md', 'rev-a', 'Alpha');
    const target = concept('raw-b', 'Moved/Alpha.md', 'rev-a', 'Alpha');
    prepareLearnedIdentity(fixtureData.store, old, target);
    const beforeEvents = {
      anchors: fixtureData.store.getAnchors(),
      observations: fixtureData.store.getObservations(),
      retentions: fixtureData.store.getRetentions(),
      applications: fixtureData.store.getApplications(),
    };
    const status = fixtureData.store.getIdentityStatus([target]);
    const oldStatus = status.orphans.find(item => item.conceptId === old.id)!;
    assert.equal(oldStatus.counts.anchors, 1);
    assert.equal(oldStatus.counts.observations, 1);
    assert.equal(oldStatus.counts.retentions, 1);
    assert.equal(oldStatus.counts.applications, 1);
    assert.equal(oldStatus.hasLayout, true);
    assert.equal(oldStatus.preference?.focus, true);

    const linkPreview = preview(fixtureData.store, old, target);
    assert.equal(linkPreview.canLink, true, JSON.stringify(linkPreview.issues));
    assert.equal(linkPreview.revisionMatches, true);
    assert.equal(linkPreview.layoutAction, 'keep-original');
    const before = fixtureData.store.exportData(source, [target]);
    const receipt = commit(fixtureData.store, old, target, 'move-1', linkPreview.token, backup => {
      assert.equal(backup.identityBindings?.length, 0);
      assert.ok(backup.concepts.some(item => item.id === old.id && item.source.path === old.source.path));
      return 'backup-1';
    });
    assert.equal(receipt.status, 'accepted');
    assert.equal(receipt.conceptId, old.id);
    assert.equal(receipt.linkedPath, target.source.path);
    assert.deepEqual(fixtureData.store.getAnchors(), beforeEvents.anchors);
    assert.deepEqual(fixtureData.store.getObservations(), beforeEvents.observations);
    assert.deepEqual(fixtureData.store.getRetentions(), beforeEvents.retentions);
    assert.deepEqual(fixtureData.store.getApplications(), beforeEvents.applications);
    assert.deepEqual(fixtureData.store.getLayout(), { [old.id]: { x: 1, y: 2, z: 3 } });
    assert.equal(fixtureData.store.getReviewPlan().concepts[old.id].focus, true);
    assert.deepEqual({ ...fixtureData.store.getIdentityAcceptedPaths() }, {
      [old.id]: [old.source.path, target.source.path].sort(),
    });
    const exported = fixtureData.store.exportData(source, [target]);
    assert.deepEqual(exported.concepts, [{ id: old.id, title: target.title, source: target.source }]);
    assert.equal(exported.identityBindings?.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(exported.identityBindings?.[0] ?? {}, 'request_hash'), false);
    assert.equal(exported.concepts.filter(item => item.source.path === target.source.path).length, 1);

    const duplicate = commit(fixtureData.store, old, target, 'move-1', linkPreview.token, () => {
      throw new Error('duplicate must not make a backup');
    });
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(duplicate.backupId, 'backup-1');
    assert.equal(duplicate.confirmedAt, receipt.confirmedAt);

    fixtureData.store.close();
    const reopened = new Store({ dataDir: fixtureData.dataDir, namespace: 'identity-store-test', now: () => new Date(NOW) });
    try {
      const replay = commit(reopened, old, target, 'move-1', linkPreview.token, () => {
        throw new Error('restart duplicate must not make a backup');
      });
      assert.equal(replay.status, 'duplicate');
      assert.equal(reopened.getIdentityBindings().length, 1);
    } finally {
      reopened.close();
    }
    // Keep the pre-link export available to the import compatibility test in
    // the same synthetic database contract.
    assert.equal(before.identityBindings?.length ?? 0, 0);
  } finally {
    // The store is already closed when the restart branch ran.
    try { fixtureData.store.close(); } catch { /* already closed */ }
    rmSync(fixtureData.dataDir, { recursive: true, force: true });
  }
});

test('revision changes are a warning and leave historical state pending after linking', () => {
  const fixtureData = fixture('identity-revision-test');
  try {
    const old = concept('stable-a', 'Math/Alpha.md', 'rev-a');
    const target = concept('raw-b', 'Moved/Alpha.md', 'rev-b');
    fixtureData.store.rememberConcepts([old, target]);
    fixtureData.store.addReview({ eventId: 'anchor-rev', conceptId: old.id, sourceRevision: old.source.revision, kind: 'review' });
    const linkPreview = preview(fixtureData.store, old, target);
    assert.equal(linkPreview.canLink, true);
    assert.equal(linkPreview.revisionMatches, false);
    assert.ok(linkPreview.issues.some(issue => issue.code === 'IDENTITY_SOURCE_REVISION_MISMATCH' && issue.severity === 'warning'));
    commit(fixtureData.store, old, target, 'move-revision', linkPreview.token);
    const projected = { ...target, id: old.id };
    assert.equal(fixtureData.store.getStates([projected], NOW)[old.id].status, 'pending');
    assert.equal(fixtureData.store.getAnchors()[0].conceptId, old.id);
    assert.equal(fixtureData.store.getAnchors()[0].sourceRevision, old.source.revision);
  } finally {
    fixtureData.cleanup();
  }
});

test('target history or non-default review preference rejects identity linking', () => {
  const historyFixture = fixture('identity-target-history-test');
  try {
    const old = concept('stable-a', 'Math/Alpha.md', 'rev-a');
    const target = concept('raw-b', 'Moved/Alpha.md', 'rev-a');
    historyFixture.store.rememberConcepts([old, target]);
    historyFixture.store.addReview({ eventId: 'target-anchor', conceptId: target.id, sourceRevision: target.source.revision, kind: 'review' });
    const result = preview(historyFixture.store, old, target);
    assert.equal(result.canLink, false);
    assert.ok(result.issues.some(issue => issue.code === 'IDENTITY_TARGET_HAS_HISTORY'));
  } finally {
    historyFixture.cleanup();
  }

  const preferenceFixture = fixture('identity-target-plan-test');
  try {
    const old = concept('stable-a', 'Math/Alpha.md', 'rev-a');
    const target = concept('raw-b', 'Moved/Alpha.md', 'rev-a');
    preferenceFixture.store.rememberConcepts([old, target]);
    preferenceFixture.store.updateReviewPlan({ revision: 0, concept: {
      conceptId: target.id, sourceRevision: target.source.revision, focus: true, deferUntil: null,
    } });
    const result = preview(preferenceFixture.store, old, target);
    assert.equal(result.canLink, false);
    assert.ok(result.issues.some(issue => issue.code === 'IDENTITY_TARGET_HAS_PREFERENCE'));
  } finally {
    preferenceFixture.cleanup();
  }
});

test('repeated moves reuse the stable ID and reject aliases as sources or targets', () => {
  const fixtureData = fixture('identity-repeated-move-test');
  try {
    const old = concept('stable-a', 'Math/Alpha.md', 'rev-a');
    const first = concept('raw-b', 'Moved/Alpha.md', 'rev-a');
    const second = concept('raw-c', 'Renamed/Alpha.md', 'rev-a');
    fixtureData.store.rememberConcepts([old, first]);
    const firstPreview = preview(fixtureData.store, old, first);
    commit(fixtureData.store, old, first, 'move-first', firstPreview.token);
    fixtureData.store.rememberConcepts([second]);
    const secondPreview = preview(fixtureData.store, old, second);
    assert.equal(secondPreview.canLink, true);
    commit(fixtureData.store, old, second, 'move-second', secondPreview.token);
    assert.deepEqual(fixtureData.store.getIdentityBindings().map(binding => [binding.rawConceptId, binding.conceptId]), [
      [first.id, old.id], [second.id, old.id],
    ]);
    assert.deepEqual(fixtureData.store.getIdentityAcceptedPaths()[old.id], [old.source.path, first.source.path, second.source.path].sort());
    const fromAlias = fixtureData.store.previewIdentityLink({ fromConceptId: first.id, toConceptId: 'raw-d' }, source, [concept('raw-d', 'Other/Alpha.md', 'rev-a')]);
    assert.equal(fromAlias.canLink, false);
    assert.ok(fromAlias.issues.some(issue => issue.code === 'IDENTITY_FROM_RAW_ALIAS'));
    const targetAlias = fixtureData.store.previewIdentityLink({ fromConceptId: old.id, toConceptId: first.id }, source, [first]);
    assert.equal(targetAlias.canLink, false);
    assert.ok(targetAlias.issues.some(issue => issue.code === 'IDENTITY_TARGET_RAW_ALIAS'));
  } finally {
    fixtureData.cleanup();
  }
});

test('stale previews, backup failures and SQL failures roll back without binding or event changes', () => {
  const staleFixture = fixture('identity-stale-test');
  try {
    const old = concept('stable-a', 'Math/Alpha.md', 'rev-a');
    const target = concept('raw-b', 'Moved/Alpha.md', 'rev-a');
    staleFixture.store.rememberConcepts([old, target]);
    const linkPreview = preview(staleFixture.store, old, target);
    staleFixture.store.rememberConcepts([{ ...target, source: { ...target.source, revision: 'rev-b' } }]);
    assert.throws(() => commit(staleFixture.store, old, { ...target, source: { ...target.source, revision: 'rev-b' } }, 'stale-1', linkPreview.token), (error: unknown) => error instanceof StoreError && error.code === 'IDENTITY_STALE');
    assert.equal(staleFixture.store.getIdentityBindings().length, 0);
  } finally {
    staleFixture.cleanup();
  }

  const backupFixture = fixture('identity-backup-failure-test');
  try {
    const old = concept('stable-a', 'Math/Alpha.md', 'rev-a');
    const target = concept('raw-b', 'Moved/Alpha.md', 'rev-a');
    backupFixture.store.rememberConcepts([old, target]);
    const linkPreview = preview(backupFixture.store, old, target);
    assert.throws(() => commit(backupFixture.store, old, target, 'backup-fail', linkPreview.token, () => {
      throw new StoreError('IDENTITY_BACKUP_FAILED', 'backup failed', 503);
    }), (error: unknown) => error instanceof StoreError && error.code === 'IDENTITY_BACKUP_FAILED');
    assert.equal(backupFixture.store.getIdentityBindings().length, 0);
  } finally {
    backupFixture.cleanup();
  }

  const sqlFixture = fixture('identity-sql-failure-test');
  const triggerDb = new DatabaseSync(join(sqlFixture.dataDir, 'living-memory.sqlite'));
  try {
    const old = concept('stable-a', 'Math/Alpha.md', 'rev-a');
    const target = concept('raw-b', 'Moved/Alpha.md', 'rev-a');
    sqlFixture.store.rememberConcepts([old, target]);
    const linkPreview = preview(sqlFixture.store, old, target);
    triggerDb.exec(`CREATE TRIGGER identity_catalog_abort BEFORE UPDATE ON identity_catalog
      WHEN OLD.namespace = 'identity-sql-failure-test'
      BEGIN SELECT RAISE(ABORT, 'forced identity catalog failure'); END`);
    assert.throws(() => commit(sqlFixture.store, old, target, 'sql-fail', linkPreview.token), (error: unknown) => error instanceof StoreError && error.code === 'IDENTITY_FAILED');
    assert.equal(sqlFixture.store.getIdentityBindings().length, 0);
    assert.deepEqual(sqlFixture.store.getLayout(), {});
  } finally {
    try { triggerDb.exec('DROP TRIGGER IF EXISTS identity_catalog_abort'); } catch { /* fixture cleanup owns the file */ }
    triggerDb.close();
    sqlFixture.cleanup();
  }
});

test('accepted local paths make old exports portable while namespace data stays isolated', () => {
  const fixtureData = fixture('identity-import-test');
  const other = new Store({ dataDir: fixtureData.dataDir, namespace: 'identity-other', now: () => new Date(NOW) });
  try {
    const old = concept('stable-a', 'Math/Alpha.md', 'rev-a');
    const target = concept('raw-b', 'Moved/Alpha.md', 'rev-a');
    fixtureData.store.rememberConcepts([old, target]);
    const linkPreview = preview(fixtureData.store, old, target);
    const before = fixtureData.store.exportData(source, [target]);
    commit(fixtureData.store, old, target, 'move-import', linkPreview.token);
    const projected = { ...target, id: old.id };
    const legacy: ExportData = {
      ...before,
      concepts: before.concepts.filter(item => item.id === old.id),
      identityBindings: [],
    };
    const imported = fixtureData.store.previewImport(legacy, DEFAULT_IMPORT_OPTIONS, source, [projected]);
    assert.equal(imported.canImport, true, JSON.stringify(imported.issues));
    assert.equal(imported.matches.find(match => match.fromId === old.id)?.match, 'id');
    assert.equal(other.getIdentityBindings().length, 0);
    assert.equal(other.getIdentityStatus([]).orphans.length, 0);
    assert.equal(other.exportData(source, []).identityBindings?.length ?? 0, 0);
  } finally {
    other.close();
    fixtureData.cleanup();
  }
});
