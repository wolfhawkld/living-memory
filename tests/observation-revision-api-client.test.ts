import assert from 'node:assert/strict';
import test from 'node:test';
import { api, configureSessionScope } from '../src/web/api';
import type { ObservationRevisionRequest } from '../src/shared/observation-revisions';
test('revision API wrappers bind protocol, source, instance and token without modifying frozen payload', async () => {
  const original = globalThis.fetch;
  const session = { writeToken: 'synthetic-token', sourceId: 'synthetic-source', instanceId: 'synthetic-instance', learningProtocolVersion: 2 };
  const calls: Array<{ path: string; headers: Headers; body: unknown; cache?: RequestCache }> = [];
  const request: ObservationRevisionRequest = { eventId: 'revision-1', observationEventId: 'parent / one', previousEventId: null,
    occurredAt: '2026-10-20T00:00:00.000Z', action: 'withdraw', reason: 'other', note: '  exact note  ' };
  try {
    configureSessionScope(session);
    globalThis.fetch = async (input, init) => {
      const path = String(input); calls.push({ path, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null, cache: init?.cache });
      return new Response(JSON.stringify(path === '/api/session' ? session : { status: 'accepted', eventId: request.eventId, recordedAt: request.occurredAt }), { headers: { 'Content-Type': 'application/json' } });
    };
    await api.getObservationRevisions(request.observationEventId, session.sourceId, { limit: 20, cursor: 'opaque / cursor' });
    await api.postObservationRevision(request, session.writeToken, session.sourceId);
    const reads = calls.filter(call => call.path !== '/api/session');
    assert.equal(reads[0].path, '/api/observations/parent%20%2F%20one/revisions?limit=20&cursor=opaque+%2F+cursor');
    assert.equal(reads[0].cache, 'no-store');
    assert.equal(reads[1].path, '/api/observations/parent%20%2F%20one/revisions'); assert.deepEqual(reads[1].body, request);
    for (const call of reads) { assert.equal(call.headers.get('x-lm-learning-protocol'), '2'); assert.equal(call.headers.get('x-lm-source-id'), session.sourceId); }
    assert.equal(reads[1].headers.get('x-lm-token'), session.writeToken); assert.equal(reads[1].headers.get('x-lm-instance-id'), session.instanceId);
    await assert.rejects(api.getObservationRevisions('parent', ''), { code: 'SOURCE_REQUIRED' });
  } finally { globalThis.fetch = original; configureSessionScope(null); }
});
