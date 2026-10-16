import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseActivityAppendRequest, type ActivityAppendRequest } from '../src/shared/activity.js';

function input(channel: 'cli' | 'feishu' | 'progressive-kg', kind: 'content.delivery' | 'workflow.reported', payload: unknown, refs: unknown[] = []) {
  return { epoch: 0, event: { schemaVersion: 1, eventId: 'activity_event', operationId: 'activity_operation', stepKey: 'provided',
    occurredAt: '2026-10-16T00:00:00Z', actor: { kind: 'unknown' }, channel, kind, payload, refs },
    delivery: { deliveryId: 'activity_delivery', channel: channel === 'progressive-kg' ? 'cli' : channel } };
}
const ref = { conceptId: 'concept', path: 'Math/Concept.md', sourceRevision: 'revision', scope: 'body' };

test('CLI prepared results are distinct from visible reading and reject platform delivery claims', () => {
  const request = input('cli', 'content.delivery', { medium: 'cli-result', outcome: 'prepared', coverage: 'body' }, [ref]);
  assert.equal(parseActivityAppendRequest(request).event.kind, 'content.delivery');
  for (const outcome of ['platform-accepted', 'failed-or-unknown']) assert.throws(() => parseActivityAppendRequest({ ...request,
    event: { ...request.event, payload: { ...request.event.payload as object, outcome } } }));
  assert.throws(() => parseActivityAppendRequest({ ...request, event: { ...request.event, kind: 'reader.opened', payload: { section: 'body' } } }));
});

test('Feishu accepts page-level receipt facts without claiming exact visible blocks', () => {
  const request = input('feishu', 'content.delivery', { medium: 'feishu-card', outcome: 'platform-accepted', coverage: 'body-page', page: 2, pageCount: 4 }, [ref]);
  assert.deepEqual(parseActivityAppendRequest(request).event.payload, request.event.payload);
  for (const fields of [{ page: 0 }, { page: 5 }, { pageCount: 100001 }, { messageId: 'platform-id' }, { body: 'private content' }]) {
    assert.throws(() => parseActivityAppendRequest({ ...request, event: { ...request.event, payload: { ...request.event.payload as object, ...fields } } }));
  }
  assert.throws(() => parseActivityAppendRequest({ ...request, event: { ...request.event, refs: [{ ...ref, scope: 'result' }] } }));
});

test('workflow reports preserve caller-reported success and never attach inferred concept reading', () => {
  const request = input('progressive-kg', 'workflow.reported', { workflow: 'ingest', outcome: 'reported-success' });
  assert.equal(parseActivityAppendRequest(request).event.channel, 'progressive-kg');
  assert.throws(() => parseActivityAppendRequest({ ...request, event: { ...request.event, refs: [ref] } }));
  assert.throws(() => parseActivityAppendRequest({ ...request, event: { ...request.event, payload: { workflow: 'ingest', outcome: 'learned' } } }));
});

test('old Web envelopes remain valid and cannot disguise channel deliveries or platform identifiers', () => {
  const web: ActivityAppendRequest = { epoch: 0, event: { schemaVersion: 1, eventId: 'old-web', operationId: 'old-op', stepKey: 'submitted',
    occurredAt: '2026-10-16T00:00:00Z', actor: { kind: 'user' }, channel: 'web', kind: 'query.submitted', refs: [], payload: { resultCount: 0 } },
    delivery: { deliveryId: 'old-web-delivery', channel: 'web' } };
  assert.deepEqual(parseActivityAppendRequest(web), web);
  const channelDelivery = input('feishu', 'content.delivery', { medium: 'feishu-text', outcome: 'platform-accepted', coverage: 'results' });
  assert.throws(() => parseActivityAppendRequest({ ...channelDelivery, event: { ...channelDelivery.event, channel: 'web' } }));
});
