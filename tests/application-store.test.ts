import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store, StoreError, parseApplicationRequest } from '../src/server/store.js';
import type { ApplicationRecordRequest, Concept } from '../src/shared/types.js';

const concept: Concept = {
  id: 'concept-alpha',
  title: 'Alpha',
  aliases: [],
  domain: 'Math',
  summary: 'summary',
  body: 'body',
  source: { path: 'Alpha.md', revision: 'rev-1' },
};

function fixture(namespace = 'application-test-source', now = '2026-01-10T00:00:00.000Z', sharedDataDir?: string) {
  const dataDir = sharedDataDir ?? mkdtempSync(join(tmpdir(), 'living-memory-application-store-'));
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
    occurredAt: '2026-01-09T00:00:00Z',
    kind: 'application',
    context: '为 orchestrator 做规则校验建模',
    content: '我把校验拆成意图、范围和安全风险三层。',
    outcome: 'partial',
    assistance: 'resources',
    result: '识别出决策表和布尔逻辑的适用位置。',
    limitations: '还没有验证边界样本。',
    insight: '先从业务约束抽象成可检查条件。',
    correction: '补充输入不完整时的默认策略。',
    references: 'decision-table.md',
    ...overrides,
  };
}

function assertStoreError(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof StoreError && error.code === code);
}

test('application and summary records are namespace isolated, idempotent, and cross-event safe', () => {
  const sharedDataDir = mkdtempSync(join(tmpdir(), 'living-memory-application-shared-store-'));
  const first = fixture('application-source-a', '2026-01-10T00:00:00.000Z', sharedDataDir);
  const second = fixture('application-source-b', '2026-01-10T00:00:00.000Z', sharedDataDir);
  try {
    const record = application();
    const privateRecord = application({ content: '另一个 namespace 的私有总结。', context: '独立的个人工作场景。' });
    assert.deepEqual(first.store.addApplication(record), { status: 'accepted', eventId: record.eventId });
    first.setNow('2026-01-11T00:00:00Z');
    assert.deepEqual(first.store.addApplication(record), { status: 'duplicate', eventId: record.eventId });
    assert.equal(first.store.getApplications().length, 1);
    assert.equal(second.store.getApplications().length, 0);
    assert.deepEqual(second.store.addApplication(privateRecord), { status: 'accepted', eventId: privateRecord.eventId });
    assert.equal(first.store.getApplications()[0].content, record.content);
    assert.equal(second.store.getApplications()[0].content, privateRecord.content);
    assert.deepEqual(first.store.getConceptHistory(concept, '2026-01-11T00:00:00Z', 20).entries.map((entry) => entry.event.eventId), [record.eventId]);
    assert.deepEqual(second.store.getConceptHistory(concept, '2026-01-11T00:00:00Z', 20).entries.map((entry) => entry.event.eventId), [privateRecord.eventId]);
    assert.deepEqual(first.store.exportData({ name: 'first', mode: 'local', conceptCount: 1, limit: 1, diagnostics: [] }, [concept]).applications?.map((event) => event.content), [record.content]);
    assert.deepEqual(second.store.exportData({ name: 'second', mode: 'local', conceptCount: 1, limit: 1, diagnostics: [] }, [concept]).applications?.map((event) => event.content), [privateRecord.content]);

    assertStoreError(() => first.store.addApplication({ ...record, sourceRevision: 'rev-2' }), 'EVENT_CONFLICT');
    assertStoreError(() => first.store.addApplication({ ...record, occurredAt: '2026-01-08T00:00:00Z' }), 'EVENT_CONFLICT');

    first.store.addReview({ eventId: 'anchor-shared', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review', occurredAt: '2026-01-08T00:00:00Z' });
    assertStoreError(() => first.store.addApplication({ ...record, eventId: 'anchor-shared' }), 'EVENT_CONFLICT');
    assertStoreError(() => first.store.addApplication({ ...record, eventId: 'application-alpha-2', kind: 'invalid' as 'application' }), 'INVALID_BODY');
  } finally {
    first.cleanup();
    second.cleanup();
    rmSync(sharedDataDir, { recursive: true, force: true });
  }
});

test('application records appear in mixed, deterministic history pages without changing decay observations', () => {
  const current = fixture();
  try {
    const { store } = current;
    const anchor = { eventId: 'anchor-alpha', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review' as const, occurredAt: '2026-01-01T00:00:00Z' };
    store.addReview(anchor);
    const before = store.getStates([concept], '2026-01-10T00:00:00Z')[concept.id];
    assert.equal(store.countObservations(), 0);
    assert.deepEqual(store.addApplication(application({ eventId: 'app-old', occurredAt: '2026-01-02T00:00:00Z' })), { status: 'accepted', eventId: 'app-old' });
    assert.deepEqual(store.addApplication(application({ eventId: 'summary-mid', kind: 'summary', context: '', occurredAt: '2026-01-04T00:00:00Z', content: '整理成自己的解释。' })), { status: 'accepted', eventId: 'summary-mid' });
    store.addRetention({ eventId: 'retention-alpha', conceptId: concept.id, sourceRevision: concept.source.revision, occurredAt: '2026-01-06T00:00:00Z', active: true, previousEventId: null }, null);
    store.addObservation({ eventId: 'observation-alpha', conceptId: concept.id, sourceRevision: concept.source.revision, observedAt: '2026-01-07T00:00:00Z', configRevision: 1, anchorEventId: anchor.eventId, answer: 'answer', rating: 'partial', exposure: 'unexposed', observedExposure: false }, anchor.eventId);
    const after = store.getStates([concept], '2026-01-10T00:00:00Z')[concept.id];
    assert.equal(store.countObservations(), 1);
    assert.equal(after.anchor?.eventId, before.anchor?.eventId);
    assert.equal(after.status, 'retained');
    assert.equal(after.retention?.eventId, 'retention-alpha');

    const seen: string[] = [];
    const kinds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = store.getConceptHistory(concept, '2026-01-10T00:00:00Z', 2, cursor);
      seen.push(...page.entries.map((entry) => entry.event.eventId));
      kinds.push(...page.entries.map((entry) => entry.type));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(seen, ['observation-alpha', 'retention-alpha', 'summary-mid', 'app-old', 'anchor-alpha']);
    assert.deepEqual(kinds, ['observation', 'retention', 'application', 'application', 'anchor']);
    assert.equal(store.getConceptHistory(concept, '2026-01-10T00:00:00Z', 20).total, 5);
    assert.deepEqual(store.getApplications(concept.id, concept.source.revision).map((item) => item.eventId), ['app-old', 'summary-mid']);
  } finally {
    current.cleanup();
  }
});

test('applications export all private fields and parse input boundaries strictly', () => {
  const current = fixture();
  try {
    const record = application();
    const rawContext = '  context with indentation\n    and a formula: \\sum_{i=1}^{n} x_i  ';
    const rawContent = '  content keeps leading and trailing spaces\n  第二行  ';
    const parsed = parseApplicationRequest({ ...record, context: rawContext, content: rawContent });
    assert.equal(parsed.context, rawContext);
    assert.equal(parsed.content, rawContent);
    current.store.addApplication({ ...record, eventId: 'raw-application', context: rawContext, content: rawContent });
    const stored = current.store.getApplications()[0];
    assert.equal(stored.context, rawContext);
    assert.equal(stored.content, rawContent);
    const exported = current.store.exportData({ name: 'test', mode: 'local', conceptCount: 1, limit: 1, diagnostics: [] }, [concept]);
    assert.equal(exported.applications?.length, 1);
    assert.deepEqual(exported.applications?.[0], current.store.getApplications()[0]);

    assertStoreError(() => parseApplicationRequest({ ...record, content: '' }), 'INVALID_BODY');
    assertStoreError(() => parseApplicationRequest({ ...record, context: '' }), 'INVALID_BODY');
    assertStoreError(() => parseApplicationRequest({ ...record, content: 'x'.repeat(12001) }), 'INVALID_BODY');
    assertStoreError(() => parseApplicationRequest({ ...record, insight: 'x'.repeat(4001) }), 'INVALID_BODY');
    assertStoreError(() => parseApplicationRequest({ ...record, assistance: 'ai' }), 'INVALID_BODY');
    assertStoreError(() => parseApplicationRequest({ ...record, occurredAt: 'not-a-date' }), 'INVALID_OCCURRED_AT');
    assertStoreError(() => current.store.addApplication({ ...record, eventId: 'future-application', occurredAt: '2026-01-11T00:00:00Z' }), 'FUTURE_EVENT');
    const summary = parseApplicationRequest({ ...record, kind: 'summary', context: undefined });
    assert.equal(summary.context, '');
  } finally {
    current.cleanup();
  }
});

test('opening an older database adds the applications table without rewriting existing observations', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-application-migration-'));
  const dbPath = join(dataDir, 'legacy.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE namespaces (namespace TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE config_history (namespace TEXT NOT NULL, revision INTEGER NOT NULL, model_version TEXT NOT NULL, half_life_days REAL NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY(namespace, revision));
    CREATE TABLE anchors (namespace TEXT NOT NULL, event_id TEXT NOT NULL, concept_id TEXT NOT NULL, source_revision TEXT NOT NULL, occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, kind TEXT NOT NULL, request_payload TEXT NOT NULL, PRIMARY KEY(namespace, event_id));
    CREATE TABLE observations (
      namespace TEXT NOT NULL, event_id TEXT NOT NULL, concept_id TEXT NOT NULL, source_revision TEXT NOT NULL,
      observed_at TEXT NOT NULL, recorded_at TEXT NOT NULL, config_revision INTEGER NOT NULL, half_life_days REAL NOT NULL,
      anchor_event_id TEXT, elapsed_days REAL, decay REAL, answer TEXT NOT NULL,
      rating TEXT NOT NULL, exposure TEXT NOT NULL, observed_exposure INTEGER NOT NULL, request_payload TEXT NOT NULL,
      PRIMARY KEY(namespace, event_id)
    );
    CREATE TABLE retentions (
      namespace TEXT NOT NULL, event_id TEXT NOT NULL, concept_id TEXT NOT NULL, source_revision TEXT NOT NULL,
      occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, active INTEGER NOT NULL, previous_event_id TEXT,
      request_payload TEXT NOT NULL, PRIMARY KEY(namespace, event_id)
    );
    CREATE TABLE layouts (namespace TEXT PRIMARY KEY, layout_json TEXT NOT NULL, recorded_at TEXT NOT NULL);
    INSERT INTO namespaces VALUES ('legacy-source', '2026-01-01T00:00:00.000Z');
    INSERT INTO config_history VALUES ('legacy-source', 1, 'time-only-v0', 7, '2026-01-01T00:00:00.000Z');
    INSERT INTO observations VALUES ('legacy-source', 'old-observation', 'concept-alpha', 'rev-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 7, NULL, NULL, NULL, 'old', 'clear', 'unknown', 0, '{}');
  `);
  db.close();
  try {
    const store = new Store({ dbPath, namespace: 'legacy-source', now: () => new Date('2026-01-02T00:00:00.000Z') });
    try {
      const migrated = new DatabaseSync(dbPath);
      try {
        const tables = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'applications'").all() as Array<{ name: string }>;
        assert.deepEqual(tables.map((table) => table.name), ['applications']);
      } finally {
        migrated.close();
      }
      assert.equal(store.getObservations()[0].answer, 'old');
      assert.deepEqual(store.getApplications(), []);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
