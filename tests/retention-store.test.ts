import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeApp, createApp, type LivingMemoryApp } from '../src/server/app.js';
import { Store, StoreError } from '../src/server/store.js';
import type { Concept } from '../src/shared/types.js';

const concept: Concept = {
  id: 'concept-alpha',
  title: 'Alpha',
  aliases: [],
  domain: 'Math',
  summary: 'summary',
  body: 'body',
  source: { path: 'Alpha.md', revision: 'rev-1' },
};

function storeFixture(now = '2026-01-02T00:00:00.000Z') {
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-retention-store-'));
  let currentNow = now;
  const store = new Store({
    dataDir,
    namespace: 'retention-test-source',
    now: () => new Date(currentNow),
  });
  return {
    store,
    dataDir,
    setNow(value: string) { currentNow = value; },
    cleanup() { store.close(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

test('retention toggles are idempotent, optimistic, source-version independent while active, and exported as history', () => {
  const fixture = storeFixture();
  try {
    const { store } = fixture;
    const review = {
      eventId: 'anchor-alpha',
      conceptId: concept.id,
      sourceRevision: concept.source.revision,
      kind: 'review' as const,
      occurredAt: '2026-01-01T00:00:00Z',
    };
    assert.deepEqual(store.addReview(review), { status: 'accepted', eventId: review.eventId });

    const set = {
      eventId: 'retention-set-1',
      conceptId: concept.id,
      sourceRevision: concept.source.revision,
      occurredAt: '2026-01-01T00:01:00Z',
      active: true,
      previousEventId: null,
    } as const;
    assert.deepEqual(store.addRetention(set, null), { status: 'accepted', eventId: set.eventId });
    assert.deepEqual(store.addRetention(set, null), { status: 'duplicate', eventId: set.eventId });
    assert.throws(() => store.addRetention({ ...set, active: false }, null), (error: unknown) => error instanceof StoreError && error.code === 'EVENT_CONFLICT');

    const retained = store.getStates([concept], '2026-01-02T00:00:00.000Z')[concept.id];
    assert.equal(retained.status, 'retained');
    assert.equal(retained.decay, null);
    assert.equal(retained.elapsedDays, null);
    assert.equal(retained.anchor?.eventId, review.eventId);
    assert.equal(retained.retention?.eventId, set.eventId);

    // A review and a model change do not leave the retained state.
    fixture.setNow('2026-01-03T00:00:00.000Z');
    const newerReview = { ...review, eventId: 'anchor-alpha-new', occurredAt: '2026-01-03T00:00:00Z' };
    assert.deepEqual(store.addReview(newerReview), { status: 'accepted', eventId: newerReview.eventId });
    assert.equal(store.updateConfig(14, 1).revision, 2);
    const stillRetained = store.getStates([concept], '2026-01-03T00:00:00.000Z')[concept.id];
    assert.equal(stillRetained.status, 'retained');
    assert.equal(stillRetained.anchor?.eventId, newerReview.eventId);

    const clear = {
      eventId: 'retention-clear-1',
      conceptId: concept.id,
      sourceRevision: concept.source.revision,
      occurredAt: '2026-01-03T00:00:00Z',
      active: false,
      previousEventId: set.eventId,
    } as const;
    assert.deepEqual(store.addRetention(clear, set.eventId), { status: 'accepted', eventId: clear.eventId });
    const resumed = store.getStates([concept], '2026-01-03T00:00:00.000Z')[concept.id];
    assert.equal(resumed.status, 'recent');
    assert.equal(resumed.retention?.eventId, clear.eventId);
    assert.equal(resumed.retention?.active, false);
    assert.equal(resumed.anchor?.eventId, newerReview.eventId);

    // Once the user sets it again, changing the source revision does not
    // silently cancel the explicit retention decision.
    fixture.setNow('2026-01-04T00:00:00.000Z');
    const setAgain = {
      eventId: 'retention-set-2',
      conceptId: concept.id,
      sourceRevision: concept.source.revision,
      occurredAt: '2026-01-04T00:00:00Z',
      active: true,
      previousEventId: clear.eventId,
    } as const;
    assert.deepEqual(store.addRetention(setAgain, clear.eventId), { status: 'accepted', eventId: setAgain.eventId });
    const changedConcept = { ...concept, source: { ...concept.source, revision: 'rev-2' } };
    const retainedAfterSourceChange = store.getStates([changedConcept], '2026-01-04T00:00:00.000Z')[concept.id];
    assert.equal(retainedAfterSourceChange.status, 'retained');
    assert.match(retainedAfterSourceChange.reason ?? '', /版本/);
    assert.equal(retainedAfterSourceChange.anchor?.eventId, newerReview.eventId);

    const exportData = store.exportData({ name: 'test', mode: 'local', conceptCount: 1, limit: 1, diagnostics: [] }, [concept]);
    assert.deepEqual(exportData.retentions?.map((event) => event.eventId), [set.eventId, clear.eventId, setAgain.eventId]);
    const history = store.getConceptHistory(concept, '2026-01-04T00:00:00.000Z', 20);
    assert.equal(history.total, 5);
    assert.deepEqual(history.entries.map((entry) => entry.type), ['retention', 'retention', 'anchor', 'retention', 'anchor']);
  } finally {
    fixture.cleanup();
  }
});

test('retention writes reject stale previous events and event IDs shared with other event kinds', () => {
  const fixture = storeFixture();
  try {
    const { store } = fixture;
    const first = {
      eventId: 'retention-first', conceptId: concept.id, sourceRevision: concept.source.revision,
      occurredAt: '2026-01-02T00:00:00Z', active: true, previousEventId: null,
    } as const;
    store.addRetention(first, null);
    assert.throws(() => store.addRetention({ ...first, eventId: 'retention-stale', active: false }, null), (error: unknown) => error instanceof StoreError && error.code === 'RETENTION_CONFLICT');
    store.addReview({ eventId: 'shared-event', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review' });
    assert.throws(() => store.addRetention({ ...first, eventId: 'shared-event' }, first.eventId), (error: unknown) => error instanceof StoreError && error.code === 'EVENT_CONFLICT');
  } finally {
    fixture.cleanup();
  }
});

test('opening a pre-evidence database adds the nullable learning column without rewriting old observations', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-retention-migration-'));
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
    CREATE TABLE layouts (namespace TEXT PRIMARY KEY, layout_json TEXT NOT NULL, recorded_at TEXT NOT NULL);
    INSERT INTO namespaces VALUES ('legacy-source', '2026-01-01T00:00:00.000Z');
    INSERT INTO config_history VALUES ('legacy-source', 1, 'time-only-v0', 7, '2026-01-01T00:00:00.000Z');
    INSERT INTO observations VALUES ('legacy-source', 'old-observation', 'concept-alpha', 'rev-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 7, NULL, NULL, NULL, 'old', 'clear', 'unknown', 0, '{}');
  `);
  db.close();
  try {
    const store = new Store({ dbPath, namespace: 'legacy-source', now: () => new Date('2026-01-02T00:00:00.000Z') });
    try {
      const columns = new DatabaseSync(dbPath).prepare('PRAGMA table_info(observations)').all() as Array<{ name: string }>;
      assert.ok(columns.some((column) => column.name === 'learning_json'));
      const old = store.getObservations().find((event) => event.eventId === 'old-observation');
      assert.ok(old);
      assert.equal(old.learning, undefined);
      assert.ok(store.getRetentions());
    } finally {
      store.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

interface ResponseData { status: number; body: string; json: <T>() => T }
interface RunningApp { app: LivingMemoryApp; server: Server; request: (path: string, options?: { method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<ResponseData>; stop: () => Promise<void>; cleanup: () => void }

async function runningApp(): Promise<RunningApp> {
  const root = mkdtempSync(join(tmpdir(), 'living-memory-retention-api-source-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-retention-api-data-'));
  writeFileSync(join(root, 'Alpha.md'), ['---', 'type: concept', 'title: Alpha', 'summary: summary', '---', '', 'body', ''].join('\n'));
  const app = createApp({ root, dataDir, port: 4317, now: () => new Date('2026-01-02T00:00:00.000Z'), staticDir: join(dataDir, 'no-dist') });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  const request = (path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => new Promise<ResponseData>((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: '127.0.0.1:4317', ...(body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) } }, (response) => {
      let text = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text, json: <T>() => JSON.parse(text) as T }));
    });
    req.once('error', reject); if (body) req.write(body); req.end();
  });
  return { app, server, request, cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); }, stop: async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); closeApp(app); } };
}

test('retention API applies auth, source/version guards, idempotency, and manual clear', async () => {
  const client = await runningApp();
  try {
    const session = (await client.request('/api/session')).json<{ writeToken: string; sourceId: string }>();
    const headers = { 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId };
    const snapshot = (await client.request('/api/snapshot')).json<any>();
    const item = snapshot.concepts[0];
    const review = { eventId: 'api-anchor', conceptId: item.id, sourceRevision: item.source.revision, kind: 'review', occurredAt: '2026-01-02T00:00:00Z' };
    assert.equal((await client.request('/api/reviews', { method: 'POST', headers, body: review })).status, 201);
    const set = { eventId: 'api-retention-1-set', conceptId: item.id, sourceRevision: item.source.revision, occurredAt: '2026-01-02T00:00:00Z', active: true, previousEventId: null };
    assert.equal((await client.request('/api/retentions', { method: 'POST', headers, body: set })).status, 201);
    assert.equal((await client.request('/api/retentions', { method: 'POST', headers, body: set })).status, 200);
    assert.equal((await client.request('/api/snapshot')).json<any>().states[item.id].status, 'retained');
    const stale = await client.request('/api/retentions', { method: 'POST', headers, body: { ...set, eventId: 'api-retention-stale', active: false } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json<any>().error.code, 'RETENTION_CONFLICT');
    const clear = { ...set, eventId: 'api-retention-2-clear', active: false, previousEventId: set.eventId };
    assert.equal((await client.request('/api/retentions', { method: 'POST', headers, body: clear })).status, 201);
    assert.equal((await client.request('/api/snapshot')).json<any>().states[item.id].status, 'recent');
    assert.equal((await client.request('/api/retentions', { method: 'POST', body: set })).status, 401);
    assert.equal((await client.request('/api/retentions', { method: 'POST', headers: { ...headers, 'x-lm-source-id': 'wrong-source' }, body: set })).status, 409);
    const exported = (await client.request('/api/export')).json<any>();
    assert.deepEqual(exported.retentions.map((event: any) => event.eventId), [set.eventId, clear.eventId]);
  } finally {
    await client.stop();
    client.cleanup();
  }
});
