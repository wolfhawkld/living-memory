import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { activityApiClient } from './helpers/activity-api-client.js';
import type { ActivityAppendRequest } from '../src/shared/activity.js';
import type { Concept } from '../src/shared/types.js';
import { DEFAULT_IMPORT_OPTIONS } from '../src/shared/import-data.js';

function submission(concept: Concept, eventId = 'activity_query_1', stepKey = 'submitted'): ActivityAppendRequest {
  return { epoch: 0, event: { schemaVersion: 1, eventId, operationId: 'activity_operation_1', stepKey,
    occurredAt: '2026-10-16T09:00:00+08:00', actor: { kind: 'user' }, channel: 'web', kind: 'query.submitted',
    refs: [{ conceptId: concept.id, sourceRevision: concept.source.revision, path: concept.source.path, scope: 'result' }],
    payload: { resultCount: 1 } }, delivery: { deliveryId: `${eventId}_delivery`, channel: 'web' } };
}

test('restored instance writes require their incarnation header and legacy rejects a different incarnation too', async () => {
  const instanceId = '12345678-1234-4234-8234-123456789abc';
  const restored = await activityApiClient({ instanceId });
  try {
    const session = (await restored.owner('/api/session')).value;
    assert.equal(session.instanceId, instanceId); assert.match(session.sourceRootFingerprint, /^[a-f0-9]{64}$/);
    const headers = { 'x-lm-token': restored.ownerHeaders['x-lm-token'], 'x-lm-source-id': restored.sourceId };
    const missing = await restored.request('/api/activity/clear', { method: 'POST', cookie: restored.ownerCookie, headers,
      body: { scope: 'all', expectedEpoch: 0 } });
    assert.equal(missing.value.error.code, 'INSTANCE_MISMATCH');
    assert.equal((await restored.owner('/api/activity/clear', { method: 'POST', body: { scope: 'all', expectedEpoch: 0 } })).status, 200);
  } finally { await restored.close(); }
  const legacy = await activityApiClient();
  try {
    assert.equal((await legacy.owner('/api/activity/clear', { method: 'POST', headers: { 'x-lm-instance-id': instanceId },
      body: { scope: 'all', expectedEpoch: 0 } })).value.error.code, 'INSTANCE_MISMATCH');
  } finally { await legacy.close(); }
});

test('CLI activity ingress requires a device session and keeps authenticated provenance separate from caller actor', async () => {
  const client = await activityApiClient();
  try {
    const before = (await client.owner('/api/export')).value;
    const request: ActivityAppendRequest = { epoch: 0, event: { schemaVersion: 1, eventId: 'activity_cli_workflow', operationId: 'activity_cli_operation',
      stepKey: 'workflow', occurredAt: '2026-10-16T00:00:00Z', actor: { kind: 'agent' }, channel: 'progressive-kg', kind: 'workflow.reported',
      refs: [], payload: { workflow: 'ingest', outcome: 'reported-success' } }, delivery: { deliveryId: 'activity_cli_delivery', channel: 'cli' } };
    assert.equal((await client.owner('/api/activity/cli', { method: 'POST', body: request })).status, 403);
    assert.equal((await client.device('/api/activity/cli', { method: 'POST', body: request, headers: { 'x-lm-source-id': 'other-source' } })).status, 409);
    assert.equal((await client.device('/api/activity/cli', { method: 'POST', body: request })).value.status, 'accepted');
    assert.equal((await client.device('/api/activity/cli', { method: 'POST', body: request })).value.status, 'duplicate');
    const exported = (await client.owner('/api/activity/export')).value;
    assert.equal(exported.events.length, 1);
    assert.equal(exported.events[0].recordedBy.sessionKind, 'device');
    assert.equal(exported.events[0].event.channel, 'progressive-kg');
    assert.equal(exported.events[0].event.actor.kind, 'agent');
    const after = (await client.owner('/api/export')).value; delete before.exportedAt; delete after.exportedAt;
    assert.deepEqual(after, before);
  } finally { await client.close(); }
});

test('activity append keeps independent steps, original receipts and trusted provenance without changing learning', async () => {
  const client = await activityApiClient();
  try {
    const before = (await client.owner('/api/export')).value;
    const concept = (await client.owner('/api/snapshot?scope=all')).value.concepts[0] as Concept;
    const input = submission(concept);
    assert.equal((await client.request('/api/activity', { method: 'POST', body: input })).status, 401);
    assert.equal((await client.request('/api/activity', { method: 'POST', cookie: client.ownerCookie, body: input })).status, 401);
    assert.equal((await client.owner('/api/activity', { method: 'POST', body: input, headers: { 'x-lm-source-id': 'other' } })).status, 409);
    assert.equal((await client.owner('/api/activity', { method: 'POST', body: { ...input, principalId: 'forged' } })).status, 400);
    const created = await client.owner('/api/activity', { method: 'POST', body: input });
    assert.equal(created.status, 200);
    assert.equal(created.value.status, 'accepted');
    const replay = await client.owner('/api/activity', { method: 'POST', body: input });
    assert.deepEqual(replay.value, { ...created.value, status: 'duplicate' });
    const anotherDelivery = await client.owner('/api/activity', { method: 'POST', body: {
      ...input, delivery: { ...input.delivery, deliveryId: 'activity_delivery_2' },
    } });
    assert.deepEqual(anotherDelivery.value, replay.value);
    const selected: ActivityAppendRequest = { ...input, event: { ...input.event, eventId: 'activity_selection',
      stepKey: 'selected', kind: 'query.selected', payload: {} }, delivery: { deliveryId: 'activity_selection_delivery', channel: 'web' } };
    assert.equal((await client.owner('/api/activity', { method: 'POST', body: selected })).value.status, 'accepted');
    const changed = { ...input, event: { ...input.event, payload: { resultCount: 2 } } };
    assert.equal((await client.owner('/api/activity', { method: 'POST', body: changed })).value.error.code, 'ACTIVITY_CONFLICT');
    for (const channel of ['cli', 'progressive-kg', 'feishu']) {
      const forbidden = submission(concept, `activity_forged_${channel}`);
      forbidden.event.operationId = `activity_forged_operation_${channel}`;
      Object.assign(forbidden.event, { channel });
      if (channel === 'progressive-kg') Object.assign(forbidden.event, { kind: 'workflow.reported', refs: [], payload: { workflow: 'query', outcome: 'reported-success' } });
      assert.equal((await client.owner('/api/activity', { method: 'POST', body: forbidden })).value.error.code, 'ACTIVITY_CHANNEL_FORBIDDEN');
    }
    const page = await client.owner(`/api/activity?${new URLSearchParams({ conceptId: concept.id, limit: '1' })}`);
    assert.equal(page.status, 200); assert.equal(page.value.items.length, 1); assert.ok(page.value.nextCursor);
    assert.equal(page.value.items[0].currentReferenceStatuses[0].status, 'current');
    const second = await client.owner(`/api/activity?${new URLSearchParams({ conceptId: concept.id, limit: '1', cursor: page.value.nextCursor })}`);
    assert.equal(second.value.items.length, 1);
    assert.notEqual(second.value.items[0].event.eventId, page.value.items[0].event.eventId);
    const exported = (await client.owner('/api/activity/export')).value;
    assert.equal(exported.format, 'living-memory-activity'); assert.equal(exported.version, 1);
    assert.equal(exported.events.length, 2); assert.equal(exported.deliveries.length, 3);
    assert.ok(exported.events.every((item: any) => !Object.hasOwn(item, 'currentReferenceStatuses')));
    assert.equal(exported.events[0].recordedBy.sessionKind, 'browser');
    assert.ok(exported.events.every((item: any) => item.recordedBy.principalId && !Object.hasOwn(item.event.actor, 'principalId')));
    assert.ok(exported.events.every((item: any) => item.event.occurredAt === input.event.occurredAt));
    assert.ok(exported.events.every((item: any) => !Object.hasOwn(item.event.payload, 'queryText')));
    assert.equal((await client.owner('/api/import/preview', { method: 'POST', body: { data: exported, options: DEFAULT_IMPORT_OPTIONS } })).status, 400);
    const after = (await client.owner('/api/export')).value;
    delete before.exportedAt; delete after.exportedAt; assert.deepEqual(after, before);
  } finally { await client.close(); }
});

test('activity HTTP validates frozen references, query consent, deletion and account isolation', async () => {
  const client = await activityApiClient();
  try {
    const concept = (await client.owner('/api/snapshot?scope=all')).value.concepts[0] as Concept;
    const input = submission(concept);
    const post = (body: unknown) => client.owner('/api/activity', { method: 'POST', body });
    assert.equal((await post({ ...input, event: { ...input.event, payload: { resultCount: 1, queryText: 'never save implicitly' } } })).status, 400);
    assert.equal((await post({ ...input, event: { ...input.event, refs: [{ ...input.event.refs[0], path: '../private.md' }] } })).status, 400);
    const metadata = (await client.owner(`/api/knowledge/references?${new URLSearchParams({ conceptId: concept.id, sourceRevision: concept.source.revision })}`)).value;
    const bodyBlock = metadata.blocks.find((item: any) => item.contentPart === 'body');
    assert.ok(bodyBlock);
    const visible = { ...submission(concept, 'activity_visible', 'visible'), event: { ...input.event,
      eventId: 'activity_visible', operationId: 'activity_reading', stepKey: 'visible', kind: 'content.visible', payload: {},
      refs: [{ ...input.event.refs[0], scope: 'block', ...bodyBlock, kind: undefined }] } };
    delete visible.event.refs[0].kind;
    assert.equal((await post(visible)).status, 200);
    assert.equal((await post({ ...visible, delivery: { deliveryId: 'activity_invalid_range_delivery', channel: 'web' }, event: { ...visible.event, eventId: 'activity_invalid_range', stepKey: 'bad-range',
      refs: [{ ...visible.event.refs[0], bodyRange: { ...bodyBlock.bodyRange, endOffset: bodyBlock.bodyRange.endOffset + 1 } }] } })).value.error.code, 'INVALID_ACTIVITY_REFERENCE');
    const opened = { ...submission(concept, 'activity_opened', 'opened'), event: { ...input.event, eventId: 'activity_opened',
      operationId: 'activity_reading', stepKey: 'opened', kind: 'reader.opened', payload: { section: 'body', requestedSectionId: 'missing-section' },
      refs: [{ ...input.event.refs[0], scope: 'body' }] } };
    assert.equal((await post(opened)).value.error.code, 'INVALID_ACTIVITY_REFERENCE');
    const historic = submission(concept, 'activity_historical');
    historic.event.refs[0].sourceRevision = 'old-version';
    assert.equal((await post(historic)).value.status, 'accepted');
    const historicalPage = (await client.owner('/api/activity')).value;
    const historicalRecord = historicalPage.items.find((item: any) => item.event.eventId === historic.event.eventId);
    assert.deepEqual(historicalRecord.referenceInspections, [{ status: 'historical-or-unresolved' }]);
    assert.equal(historicalRecord.event.refs[0].sourceRevision, 'old-version');
    assert.equal(historicalRecord.currentReferenceStatuses[0].status, 'source-changed');
    const saved = submission(concept, 'activity_saved_query', 'saved');
    Object.assign(saved.event.payload, { queryText: 'user explicitly kept this', queryTextSavedByUser: true });
    assert.equal((await post(saved)).value.status, 'accepted');
    const member = await client.owner('/api/admin/users', { method: 'POST', body: { username: 'activity-isolated', password: 'activity-isolated-password-2026' } });
    assert.equal(member.status, 201);
    const login = await client.request('/api/auth/login', { method: 'POST', body: { username: 'activity-isolated', password: 'activity-isolated-password-2026' } });
    assert.equal((await client.request('/api/activity', { cookie: login.cookie })).value.items.length, 0);
    assert.equal((await client.request('/api/activity/export', { cookie: login.cookie })).value.events.length, 0);
    assert.equal((await client.owner('/api/activity?limit=0')).status, 400);
    assert.equal((await client.owner('/api/activity?limit=1&limit=2')).status, 400);
    assert.equal((await client.owner('/api/activity?principalId=other')).status, 400);
    const cleared = await client.owner('/api/activity/clear', { method: 'POST', body: { scope: 'operation', expectedEpoch: 0, operationId: input.event.operationId } });
    assert.equal(cleared.value.deletedEvents, 2); assert.equal(cleared.value.deletedDeliveries, 2);
    assert.equal((await post(input)).value.error.code, 'ACTIVITY_DELETED');
    assert.equal((await post(saved)).value.error.code, 'ACTIVITY_DELETED');
    const remaining = (await client.owner('/api/activity/export')).value.events;
    assert.equal(remaining.length, 1); assert.equal(remaining[0].event.operationId, 'activity_reading');
    const clearedAll = await client.owner('/api/activity/clear', { method: 'POST', body: { scope: 'all', expectedEpoch: 0 } });
    assert.equal(clearedAll.value.settings.epoch, 1);
    assert.equal((await post(input)).value.error.code, 'ACTIVITY_EPOCH_CHANGED');
  } finally { await client.close(); }
});

test('activity settings and clearing are private, use revisions and epochs, and leave learning exports unchanged', async () => {
  const client = await activityApiClient();
  try {
    assert.equal((await client.request('/api/activity/settings')).status, 401);
    const initial = await client.owner('/api/activity/settings');
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.value, { sourceId: client.sourceId, settings: { enabled: true, epoch: 0, revision: 0 } });
    const before = (await client.owner('/api/export')).value;
    assert.equal((await client.request('/api/activity/settings', { method: 'POST', cookie: client.ownerCookie,
      body: { enabled: false, expectedRevision: 0 } })).status, 401);
    for (const path of ['/api/activity/settings', '/api/activity/clear']) assert.equal((await client.request(path, {
      method: 'POST', cookie: client.ownerCookie, headers: { 'x-lm-token': client.ownerHeaders['x-lm-token'] }, body: {},
    })).value.error.code, 'SOURCE_REQUIRED');
    assert.equal((await client.owner('/api/activity/settings', { headers: { 'x-lm-source-id': 'foreign' } })).status, 409);
    assert.equal((await client.owner('/api/activity/settings', { method: 'POST', body: { enabled: false, expectedRevision: 0, sourceId: 'foreign' } })).status, 400);
    const disabled = await client.owner('/api/activity/settings', { method: 'POST', body: { enabled: false, expectedRevision: 0 } });
    assert.equal(disabled.status, 200);
    assert.deepEqual(disabled.value.settings, { enabled: false, epoch: 1, revision: 1 });
    assert.equal((await client.owner('/api/activity/settings', { method: 'POST', body: { enabled: true, expectedRevision: 0 } })).status, 409);
    const enabled = await client.owner('/api/activity/settings', { method: 'POST', body: { enabled: true, expectedRevision: 1 } });
    assert.deepEqual(enabled.value.settings, { enabled: true, epoch: 1, revision: 2 });
    const clearOperation = await client.owner('/api/activity/clear', { method: 'POST', body: { scope: 'operation', expectedEpoch: 1, operationId: 'operation-to-clear' } });
    assert.equal(clearOperation.status, 200);
    assert.equal(clearOperation.value.deletedEvents, 0);
    const clearAll = await client.owner('/api/activity/clear', { method: 'POST', body: { scope: 'all', expectedEpoch: 1 } });
    assert.equal(clearAll.status, 200);
    assert.deepEqual(clearAll.value.settings, { enabled: true, epoch: 2, revision: 3 });
    assert.equal((await client.owner('/api/activity/clear', { method: 'POST', body: { scope: 'operation', expectedEpoch: 1, operationId: 'operation-to-clear' } })).status, 409);
    assert.equal((await client.owner('/api/activity/clear', { method: 'POST', body: { scope: 'all', expectedEpoch: 2, operationId: 'not-allowed' } })).status, 400);
    const member = await client.owner('/api/admin/users', { method: 'POST', body: { username: 'activity-member', password: 'activity-member-password-2026' } });
    assert.equal(member.status, 201);
    const loggedIn = await client.request('/api/auth/login', { method: 'POST', body: { username: 'activity-member', password: 'activity-member-password-2026' } });
    assert.equal(loggedIn.status, 200);
    const memberSettings = await client.request('/api/activity/settings', { cookie: loggedIn.cookie });
    assert.deepEqual(memberSettings.value.settings, { enabled: true, epoch: 0, revision: 0 });
    assert.notEqual(memberSettings.value.sourceId, client.sourceId);
    const after = (await client.owner('/api/export')).value;
    delete before.exportedAt; delete after.exportedAt;
    assert.deepEqual(after, before);
  } finally { await client.close(); }
});
