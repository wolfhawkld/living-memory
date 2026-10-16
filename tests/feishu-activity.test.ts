import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ActivityStore } from '../src/server/activity-store.ts';
import { prepareFeishuActivity, type FeishuActivityCoverage } from '../src/server/feishu-activity.ts';
import type { ActivityAppendRequest } from '../src/shared/activity.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE learning_fixture(value TEXT); INSERT INTO learning_fixture VALUES('unchanged');");
  const store = new ActivityStore({ db, namespace: 'synthetic-account-source', now: () => new Date('2026-10-16T09:00:00.000Z') });
  let authorized = true;
  let instant = '2026-10-16T08:30:00.000Z';
  let nowReads = 0;
  const sent: ActivityAppendRequest[] = [];
  const coverage: FeishuActivityCoverage = { coverage: 'results', refs: [{ conceptId: 'concept', sourceRevision: 'revision', path: 'Math/Concept.md', title: 'Original title', scope: 'result' }], request: { kind: 'query', resultCount: 1 } };
  const options = { operationId: 'synthetic-operation', occurredAt: '2026-10-16T08:00:00.000Z', settings: store.getSettings(), medium: 'feishu-text' as const,
    coverage, stillAuthorized: () => authorized, now: () => { nowReads += 1; return instant; },
    append(request: ActivityAppendRequest) { sent.push(structuredClone(request)); return store.append({ principalId: 'bound-account', sessionKind: 'feishu-binding', deliveryChannel: 'feishu', allowedOriginChannels: ['feishu'], inspectReference: () => ({ status: 'current' }) }, request); },
  };
  return { db, store, options, sent, setTime(value: string) { instant = value; }, get nowReads() { return nowReads; }, revoke() { authorized = false; } };
}

test('a valid query is a request fact even when platform delivery fails; it never claims content was visible', () => {
  const f = fixture();
  try {
    const prepared = prepareFeishuActivity(f.options);
    assert.equal(prepared.diagnostic.status, 'recorded');
    assert.deepEqual(f.store.export().events.map((item) => item.event.kind), ['query.submitted']);
    assert.equal(prepared.settle('failed-or-unknown').status, 'recorded');
    const events = f.store.export().events;
    assert.deepEqual(new Set(events.map((item) => item.event.kind)), new Set(['query.submitted', 'content.delivery']));
    const delivery = events.find((item) => item.event.kind === 'content.delivery')!.event;
    assert.deepEqual(delivery.payload, { medium: 'feishu-text', outcome: 'failed-or-unknown', coverage: 'results' });
    assert.ok(events.every((item) => !['reader.opened', 'content.visible'].includes(item.event.kind)));
    assert.equal(JSON.stringify(events).includes('queryText'), false);
    assert.deepEqual(f.db.prepare('SELECT value FROM learning_fixture').all().map((row) => row.value), ['unchanged']);
  } finally { f.db.close(); }
});

test('first settlement fixes outcome, epoch, IDs, time and reference snapshots across duplicate callbacks', () => {
  const f = fixture();
  try {
    const prepared = prepareFeishuActivity(f.options);
    f.options.operationId = 'changed-operation'; f.options.occurredAt = '2030-01-01T00:00:00.000Z'; f.options.settings.epoch = 99;
    f.options.coverage.refs[0]!.title = 'Changed title';
    assert.equal(prepared.settle('failed-or-unknown').status, 'recorded');
    f.setTime('2026-10-16T08:45:00.000Z');
    assert.equal(prepared.settle('platform-accepted').status, 'recorded');
    assert.deepEqual(f.sent[1], f.sent[2]);
    assert.equal(f.nowReads, 1);
    assert.equal(f.sent[1]!.epoch, 0);
    assert.equal(f.sent[1]!.event.operationId, 'synthetic-operation');
    assert.equal(f.sent[0]!.event.occurredAt, '2026-10-16T08:00:00.000Z');
    assert.equal(f.sent[1]!.event.occurredAt, '2026-10-16T08:30:00.000Z');
    assert.equal(f.sent[1]!.event.refs[0]!.title, 'Original title');
    const exported = f.store.export();
    assert.equal(exported.events.length, 2); assert.equal(exported.deliveries.length, 2);
  } finally { f.db.close(); }
});

test('paused tracking and clear epochs cannot be revived by late platform acceptance', () => {
  for (const clear of [false, true]) {
    const f = fixture();
    try {
      const prepared = prepareFeishuActivity(f.options);
      if (clear) f.store.clearAll({ expectedEpoch: 0 });
      else f.store.updateSettings({ enabled: false, expectedRevision: 0 });
      assert.equal(prepared.settle('platform-accepted').status, 'failed');
      assert.equal(f.store.export().events.filter((item) => item.event.kind === 'content.delivery').length, 0);
      assert.equal(f.sent.at(-1)!.epoch, 0);
    } finally { f.db.close(); }
  }
});

test('operation tombstones and authorization revocation block late writes without affecting send settlement', () => {
  const f = fixture();
  try {
    const prepared = prepareFeishuActivity(f.options);
    f.store.clearOperation({ operationId: f.options.operationId, expectedEpoch: 0 });
    assert.doesNotThrow(() => prepared.settle('platform-accepted'));
    assert.equal(f.store.export().events.length, 0);
    f.revoke();
    const count = f.sent.length;
    assert.deepEqual(prepared.settle('platform-accepted'), { status: 'skipped', code: 'ACTIVITY_NOT_AUTHORIZED' });
    assert.equal(f.sent.length, count);
    assert.equal(prepareFeishuActivity(f.options).diagnostic.code, 'ACTIVITY_NOT_AUTHORIZED');
  } finally { f.db.close(); }
});

test('disabled settings, missing coverage and failed appends are nonthrowing and disclose no private diagnostics', () => {
  const f = fixture();
  try {
    assert.equal(prepareFeishuActivity({ ...f.options, settings: { ...f.options.settings, enabled: false } }).settle('platform-accepted').status, 'skipped');
    assert.equal(prepareFeishuActivity({ ...f.options, coverage: undefined }).settle('platform-accepted').status, 'skipped');
    const prepared = prepareFeishuActivity({ ...f.options, append() { throw new Error('private raw query/token/body'); } });
    assert.deepEqual(prepared.diagnostic, { status: 'failed', code: 'ACTIVITY_UNAVAILABLE' });
    assert.deepEqual(prepared.settle('platform-accepted'), { status: 'failed', code: 'ACTIVITY_UNAVAILABLE' });
    assert.equal(f.sent.length, 0);
  } finally { f.db.close(); }
});

test('a body page produces selected-result plus truthful delivery coverage without invented block ranges', () => {
  const f = fixture();
  try {
    const body = { ...f.options.coverage.refs[0]!, scope: 'body' as const };
    const prepared = prepareFeishuActivity({ ...f.options, medium: 'feishu-card', coverage: { coverage: 'body-page', refs: [body], page: 2, pageCount: 4, request: { kind: 'selected' } } });
    prepared.settle('platform-accepted');
    const events = f.store.export().events;
    assert.equal(events.find((item) => item.event.kind === 'query.selected')!.event.refs[0]!.scope, 'result');
    const delivery = events.find((item) => item.event.kind === 'content.delivery')!.event;
    assert.deepEqual(delivery.payload, { medium: 'feishu-card', outcome: 'platform-accepted', coverage: 'body-page', page: 2, pageCount: 4 });
    assert.equal(delivery.refs[0]!.scope, 'body');
    assert.equal(delivery.refs[0]!.bodyRange, undefined); assert.equal(delivery.refs[0]!.blockId, undefined);
  } finally { f.db.close(); }
});

test('tracking settings and append faults never block the original prepared card receipt or activation', async () => {
  const { createFeishuCardCapabilities } = await import('../src/server/feishu-cards.ts');
  for (const fault of ['settings', 'append'] as const) {
    let activated = 0, discarded = 0, finished = 0, learningWrites = 0;
    const actor = { appId: 'synthetic-app', tenantKey: 'synthetic-tenant', openId: 'synthetic-user' };
    const accounts = {
      resolveFeishuAccount() { return { id: 'bound-user', accessRevision: 1 }; },
      getFeishuBindingState() { return { binding: { id: 'binding' } }; },
      claimFeishuRead() { return true; }, createFeishuCardDraft() { return { id: 'a'.repeat(32) }; },
      isFeishuCardDraftAuthorized() { return true; }, finishFeishuRead() { finished += 1; },
      activateFeishuCard() { activated += 1; return true; }, discardFeishuCard() { discarded += 1; },
    };
    const concept = { id: 'concept', title: 'Concept', aliases: [], domain: 'Math', summary: 'summary', body: 'body', source: { path: 'Math/Concept.md', revision: 'revision' } };
    const graph = { concepts: [concept], links: [], source: { mode: 'local', name: 'synthetic', conceptCount: 1, limit: 1, diagnostics: [] } };
    const source = { graph, index: graph, namespace: 'synthetic-source', root: '/synthetic-unused' };
    const store = {
      getStates() { return {}; }, getAnchors() { return []; }, getReviewPlan() { return { revision: 0, dailyBudget: 5, concepts: {} }; }, getCompletedConceptIds() { return []; },
      addReview() { learningWrites += 1; }, addObservation() { learningWrites += 1; },
      activity: { getSettings() { if (fault === 'settings') throw new Error('synthetic tracking failure'); return { enabled: true, epoch: 0, revision: 0 }; }, append() { throw new Error('synthetic tracking failure'); } },
    };
    const capabilities = createFeishuCardCapabilities({ accounts: accounts as never, scope: actor, timeZone: 'UTC', now: () => new Date('2026-10-16T08:00:00.000Z'), contextForUser: () => ({ source, store }) as never });
    const prepared = capabilities.prepareMessage({ ...actor, messageId: `message-${fault}`, eventId: `event-${fault}`, chatId: 'private-chat', text: '知识 卡片' });
    assert.ok(prepared); assert.equal(prepared.stillAuthorized(), true);
    assert.doesNotThrow(() => prepared.settle({ status: 'platform-accepted', messageId: 'platform-message', chatId: 'private-chat' }));
    assert.equal(activated, 1); assert.equal(finished, 1); assert.equal(discarded, 0); assert.equal(learningWrites, 0);
  }
});
