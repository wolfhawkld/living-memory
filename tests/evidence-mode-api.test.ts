import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeApp, createApp } from '../src/server/app.js';

async function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'living-memory-evidence-api-'));
  writeFileSync(join(temp, 'Alpha.md'), '---\ntype: concept\ntitle: Alpha\n---\nSynthetic body');
  const app = createApp({ root: temp, dataDir: join(temp, 'data'), staticDir: join(temp, 'none'),
    port: 4317, now: () => new Date('2026-10-07T01:00:00Z') });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const send = (path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: (server.address() as { port: number }).port, path,
        method: options.method ?? 'GET', headers: { host: '127.0.0.1:4317', 'content-type': 'application/json', ...options.headers } }, res => {
        let content = ''; res.setEncoding('utf8'); res.on('data', chunk => content += chunk);
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(content) }));
      }); req.on('error', reject); if (options.body !== undefined) req.write(JSON.stringify(options.body)); req.end();
    });
  const session = (await send('/api/session')).body;
  const headers = { 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId };
  const snapshot = (await send('/api/snapshot')).body;
  return { send, headers, concept: snapshot.concepts[0], config: snapshot.config,
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); closeApp(app); rmSync(temp, { recursive: true, force: true }); } };
}

test('mental evidence survives the real API and projections without altering memory or inventing independent success', async () => {
  const f = await fixture();
  try {
    const base = { conceptId: f.concept.id, sourceRevision: f.concept.source.revision };
    const post = (path: string, body: unknown) => f.send(path, { method: 'POST', headers: f.headers, body });
    assert.equal((await post('/api/reviews', { ...base, eventId: 'anchor', kind: 'review', occurredAt: '2026-09-01T00:00:00Z' })).status, 201);
    assert.equal((await post('/api/retentions', { ...base, eventId: 'retained', active: true,
      previousEventId: null, occurredAt: '2026-10-01T00:00:00Z' })).status, 201);
    const before = (await f.send('/api/snapshot')).body;
    const observation = { ...base, eventId: 'mental-concept', evidenceMode: 'mental', answer: '', rating: 'clear',
      observedAt: '2026-10-07T00:00:00Z', configRevision: f.config.revision, anchorEventId: 'anchor',
      exposure: 'unexposed', observedExposure: false,
      // A caller's claim cannot turn an unrecorded answer into independent evidence.
      learning: { task: 'concept', cue: 'independent', outcome: 'success', basis: 'self-check',
        confidence: 90, confidenceAt: '2026-10-06T23:59:00Z' } };
    assert.equal((await post('/api/observations', observation)).status, 201);
    assert.equal((await post('/api/observations', observation)).status, 200);
    assert.equal((await post('/api/observations', { ...observation, evidenceMode: 'written' })).status, 409);
    const history = (await f.send(`/api/concepts/${encodeURIComponent(f.concept.id)}/history`)).body;
    const event = history.entries.find((entry: any) => entry.type === 'observation').event;
    assert.equal(event.evidenceMode, 'mental'); assert.equal(event.answer, '');
    assert.equal(event.anchorEventId, 'anchor'); assert.equal(event.configRevision, f.config.revision);
    assert.equal(event.halfLifeDays, f.config.halfLifeDays);
    assert.equal(history.learning.calibration.concept.count, 0);
    assert.equal(history.progress.tasks.concept.latest.evidenceMode, 'mental');
    const overview = (await f.send('/api/learning-overview')).body;
    const item = overview.items.find((entry: any) => entry.conceptId === f.concept.id);
    assert.equal(item.recall.latest.evidenceMode, 'mental');
    assert.equal(item.timeRecall.buckets.length, 1);
    assert.equal(item.timeRecall.buckets[0].condition, 'unknown');
    assert.equal(item.timeRecall.buckets[0].latest.evidenceMode, 'mental');
    assert.deepEqual((await f.send('/api/snapshot')).body.states, before.states);
    assert.deepEqual((await f.send('/api/snapshot')).body.config, before.config);
    const exported = (await f.send('/api/export')).body;
    assert.equal(exported.observations.length, 1); assert.equal(exported.observations[0].evidenceMode, 'mental');
    assert.equal(exported.retentions[0].active, true);
    assert.deepEqual((await f.send('/api/review-plan?timeZone=UTC')).body.completedConceptIds, [f.concept.id]);
  } finally { await f.close(); }
});

test('HTTP boundary preserves legacy blank replies and rejects malformed modes before any learning write', async () => {
  const f = await fixture();
  try {
    const body = { eventId: 'legacy-blank', conceptId: f.concept.id, sourceRevision: f.concept.source.revision,
      observedAt: '2026-10-07T00:00:00Z', configRevision: f.config.revision, anchorEventId: null,
      answer: '', rating: 'blank', exposure: 'unknown', observedExposure: false };
    const send = (value: unknown) => f.send('/api/observations', { method: 'POST', headers: f.headers, body: value });
    assert.equal((await send(body)).status, 201); assert.equal((await send(body)).status, 200);
    for (const change of [{ evidenceMode: null }, { evidenceMode: 'automatic' },
      { evidenceMode: 'mental', answer: 'a fabricated original answer' }, { evidenceMode: 'mental', answer: null }]) {
      const result = await send({ ...body, eventId: 'invalid-new', ...change });
      assert.equal(result.status, 400); assert.equal(result.body.error.code, 'INVALID_EVIDENCE_MODE');
    }
    const event = (await f.send('/api/export')).body.observations[0];
    assert.equal(Object.hasOwn(event, 'evidenceMode'), false); assert.equal(event.rating, 'blank');
    assert.equal((await f.send('/api/export')).body.observations.length, 1);
  } finally { await f.close(); }
});
