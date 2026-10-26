import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { Accounts } from '../src/server/accounts.js';
import { backupInstance, restoreInstance } from '../src/server/instance-backup.js';
import { createFeishuCardCapabilities, type PreparedFeishuCardReply } from '../src/server/feishu-cards.js';
import { feishuReviewEventId } from '../src/shared/feishu-review.js';
import type { ObservationRequest } from '../src/shared/types.js';
import type { FeishuCardNavAction } from '../src/shared/feishu-cards.js';
import { appV3Fixture, V3_NOW } from './helpers/app-v3-fixture.js';
import { instanceFixture, tableRows } from './helpers/instance-backup-fixture.js';
import { cardButtons } from './helpers/feishu-card-elements.js';

type Fixture = Awaited<ReturnType<typeof appV3Fixture>>;
const now = () => new Date(V3_NOW);
const headers = (session: any) => ({ 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId, 'x-lm-instance-id': session.instanceId });
const clearPath = (eventId: string) => `/api/observations/${eventId}/answer-clearing`;
const options = { restoreLayout: false, restoreReviewPlan: true };
async function session(f: Fixture, cookie?: string) { return (await f.send('/api/session', { cookie })).body; }
async function login(f: Fixture, username: string, password: string) {
  const result = await f.send('/api/auth/login', { method: 'POST', protocol: null, body: { username, password } });
  assert.equal(result.status, 200, result.text); return { cookie: result.cookie, headers: headers(await session(f, result.cookie)) };
}

function addFacts(f: Fixture) {
  const store = f.app.livingMemory.store, concept = f.app.livingMemory.getSource().index.concepts[0];
  store.updateConfig(11, 1);
  store.addReview({ eventId: 'integration-anchor', conceptId: concept.id, sourceRevision: concept.source.revision,
    kind: 'review', occurredAt: '2026-10-13T12:00:00.000Z' });
  const observation = { eventId: 'integration-parent', conceptId: concept.id, sourceRevision: concept.source.revision,
    observedAt: V3_NOW, configRevision: 2, anchorEventId: 'integration-anchor', answer: 'SYNTHETIC_INTEGRATION_ANSWER',
    evidenceMode: 'written', rating: 'partial', exposure: 'unexposed', observedExposure: false,
    learning: { task: 'concept', cue: 'independent', outcome: 'unverified', basis: 'self-check', confidence: 80, confidenceAt: V3_NOW } } satisfies ObservationRequest;
  store.addObservation(observation, 'integration-anchor');
  store.addRetention({ eventId: 'integration-retention', conceptId: concept.id, sourceRevision: concept.source.revision,
    occurredAt: V3_NOW, active: true, previousEventId: null }, null);
  store.observationRevisions.append({ eventId: 'integration-r1', observationEventId: 'integration-parent', previousEventId: null,
    occurredAt: V3_NOW, action: 'withdraw', reason: 'other', note: 'Independent retained audit note' });
  store.observationRevisions.append({ eventId: 'integration-r2', observationEventId: 'integration-parent', previousEventId: 'integration-r1',
    occurredAt: V3_NOW, action: 'reinstate', reason: 'other' });
  return concept;
}

test('HTTP clearing survives a nonempty JSON import with revisions, memory anchors, H and retained state intact', async () => {
  const source = await appV3Fixture(); let target: Fixture | null = null;
  try {
    const concept = addFacts(source), auth = headers(await session(source));
    const before = (await source.send('/api/export')).body;
    const memory = source.app.livingMemory.store.getStates([concept], V3_NOW);
    const cleared = await source.send(clearPath('integration-parent'), { method: 'POST', headers: auth });
    assert.equal(cleared.status, 201);
    const exported = (await source.send('/api/export')).body;
    assert.equal(exported.observations.length, 1); assert.equal(exported.observationRevisions.length, 2);
    assert.equal(exported.observations[0].answer, null); assert.doesNotMatch(JSON.stringify(exported), /SYNTHETIC_INTEGRATION_ANSWER/);
    for (const key of ['anchors', 'retentions', 'config', 'configHistory', 'observationRevisions', 'reviewPlan']) assert.deepEqual(exported[key], before[key], key);
    assert.deepEqual(source.app.livingMemory.store.getStates([concept], V3_NOW), memory);
    target = await appV3Fixture({ root: source.root });
    const targetAuth = headers(await session(target));
    const preview = await target.send('/api/import/preview', { method: 'POST', headers: targetAuth, body: { data: exported, options } });
    assert.equal(preview.status, 200, preview.text); assert.equal(preview.body.canImport, true);
    const imported = await target.send('/api/import/commit', { method: 'POST', headers: targetAuth,
      body: { data: exported, options, importId: 'integration-import', previewToken: preview.body.token, confirmed: true } });
    assert.equal(imported.status, 201, imported.text);
    assert.deepEqual((await target.send(clearPath('integration-parent'), { headers: targetAuth })).body,
      { observationEventId: 'integration-parent', status: 'cleared', clearedAt: cleared.body.clearedAt });
    const restored = (await target.send('/api/export')).body;
    for (const key of ['observations', 'anchors', 'retentions', 'configHistory', 'observationRevisions']) assert.deepEqual(restored[key], exported[key], key);
    assert.equal(restored.config.halfLifeDays, 11); assert.deepEqual(target.app.livingMemory.store.getStates([concept], V3_NOW), memory);
    const revision = await target.send('/api/observations/integration-parent/revisions');
    assert.equal(revision.body.total, 2); assert.equal(revision.body.state.status, 'active'); assert.equal(revision.body.observation.answer, null);
    const replay = await target.send('/api/import/preview', { method: 'POST', headers: targetAuth, body: { data: before, options } });
    assert.equal(replay.status, 409); assert.equal(replay.body.error.code, 'ANSWER_CLEARED');
  } finally { if (target) await target.close(); await source.close(); }
});

test('HTTP clearing round-trips a multi-user instance bundle and restored App3 reports the original marker', async () => {
  const original = await instanceFixture(); let candidate: Fixture | null = null, restoredApp: Fixture | null = null;
  try {
    await backupInstance(original.options);
    const upgraded = await restoreInstance({ bundle: original.options.output, target: join(original.base, 'http-v3'), targetLearningSchemaVersion: 3, now });
    candidate = await appV3Fixture({ root: upgraded.startup.kgRoot, dataDir: upgraded.startup.dataDir, accountsEnabled: true });
    const owner = await login(candidate, 'synthetic-owner', 'synthetic-owner-password');
    const before = tableRows(join(upgraded.startup.dataDir, 'living-memory.sqlite'));
    const cleared = await candidate.send(clearPath('observation-0'), { method: 'POST', ...owner }); assert.equal(cleared.status, 201, cleared.text);
    const member = await login(candidate, 'synthetic-member', 'synthetic-member-password');
    assert.deepEqual((await candidate.send(clearPath('observation-1'), member)).body, { observationEventId: 'observation-1', status: 'saved' });
    assert.equal((await candidate.send(clearPath('observation-0'), member)).status, 404);
    await candidate.close(); candidate = null;
    const after = tableRows(join(upgraded.startup.dataDir, 'living-memory.sqlite'));
    for (const key of ['anchors', 'retentions', 'config_history', 'observation_revisions', 'review_plans']) if (before[key]) assert.deepEqual(after[key], before[key], key);
    for (const parent of before.observations) {
      const actual = after.observations.find(item => item.namespace === parent.namespace && item.event_id === parent.event_id);
      assert.deepEqual(actual, parent.event_id === 'observation-0'
        ? { ...parent, answer: null, request_payload: null, answer_cleared_at: cleared.body.clearedAt } : parent);
    }
    const bundle = join(original.base, 'http-cleared-bundle');
    const manifest = await backupInstance({ dataDir: upgraded.startup.dataDir, kgRoot: upgraded.startup.kgRoot,
      cliStateDir: upgraded.startup.cliStateDir, ...(upgraded.startup.envArchive ? { envFile: upgraded.startup.envArchive } : {}),
      procRoot: original.options.procRoot, output: bundle, now });
    assert.equal(manifest.learningSchemaVersion, 3);
    const restored = await restoreInstance({ bundle, target: join(original.base, 'http-restored'), targetLearningSchemaVersion: 3, now });
    restoredApp = await appV3Fixture({ root: restored.startup.kgRoot, dataDir: restored.startup.dataDir, accountsEnabled: true });
    const restoredOwner = await login(restoredApp, 'synthetic-owner', 'synthetic-owner-password');
    assert.deepEqual((await restoredApp.send(clearPath('observation-0'), restoredOwner)).body,
      { observationEventId: 'observation-0', status: 'cleared', clearedAt: cleared.body.clearedAt });
    const retry = await restoredApp.send(clearPath('observation-0'), { method: 'POST', ...restoredOwner });
    assert.equal(retry.status, 200); assert.equal(retry.body.clearedAt, cleared.body.clearedAt);
    const restoredMember = await login(restoredApp, 'synthetic-member', 'synthetic-member-password');
    assert.equal((await restoredApp.send(clearPath('observation-1'), restoredMember)).body.status, 'saved');
    const finalRows = tableRows(join(restored.startup.dataDir, 'living-memory.sqlite'));
    assert.deepEqual(finalRows.observations, after.observations); assert.deepEqual(finalRows.observation_revisions, after.observation_revisions);
    for (const key of ['anchors', 'retentions', 'config_history']) assert.deepEqual(finalRows[key], after[key], key);
  } finally { if (candidate) await candidate.close(); if (restoredApp) await restoredApp.close(); original.cleanup(); }
});

test('HTTP-cleared Feishu collision survives unknown settlement without repeating budget or moving memory time', async () => {
  const f = await appV3Fixture({ accountsEnabled: true }); let accounts: Accounts | null = null;
  const actor = { appId: 'synthetic-http-feishu', tenantKey: 'synthetic-tenant', openId: 'synthetic-owner' };
  try {
    const setup = await f.send('/api/auth/setup', { method: 'POST', protocol: null, body: { username: 'synthetic', password: 'synthetic-feishu-password' } });
    assert.equal(setup.status, 201);
    const browserSession = await session(f, setup.cookie), auth = headers(browserSession);
    accounts = new Accounts({ dataDir: f.dataDir, now });
    const browser = accounts.issueSession(setup.body.user.id);
    const issued = accounts.issueFeishuBindingRequest(browser.user.id, browser.sessionId, actor);
    assert.equal(accounts.confirmFeishuBinding({ ...actor, code: issued.command.split(' ')[1], eventId: 'binding', messageId: 'binding', chatId: 'private' }).status, 'confirmed');
    const authorization = { userId: browser.user.id, accessRevision: browser.user.accessRevision, bindingId: accounts.getFeishuBindingState(browser.user.id).binding!.id };
    const source = f.app.livingMemory.getSource(), store = f.app.livingMemory.store;
    const due = source.index.concepts[0];
    store.addReview({ eventId: 'feishu-original-anchor', conceptId: due.id, sourceRevision: due.source.revision, kind: 'review', occurredAt: '2026-10-13T12:00:00.000Z' });
    const cards = createFeishuCardCapabilities({ accounts, scope: actor, timeZone: 'UTC', now,
      contextForUser: userId => { assert.equal(userId, browser.user.id); return { source, store }; } });
    let serial = 0;
    function accept(reply: PreparedFeishuCardReply | null) {
      assert.ok(reply); assert.equal(reply.stillAuthorized(), true);
      reply.settle({ status: 'platform-accepted', messageId: `platform-${reply.operationId}`, chatId: 'private' }); return reply;
    }
    const send = (text: string) => accept(cards.prepareMessage({ ...actor, text, eventId: `event-${++serial}`, messageId: `message-${serial}`, chatId: 'private' }));
    function click(reply: PreparedFeishuCardReply, caption: string) {
      const button = cardButtons(reply.card).find(item => item.text?.content === caption); assert.ok(button, `missing ${caption}`);
      const action = { ...actor, ...button.behaviors![0].value, eventId: `click-${++serial}`, messageId: `platform-${reply.operationId}`, chatId: 'private' } as FeishuCardNavAction;
      return accept(cards.prepareAction(action));
    }
    const revealed = click(send('知识 复习'), '查看资料');
    const review = accounts.getFeishuReviewSession(actor, authorization, source.namespace)!, frozen = review.state.frozen!;
    const eventId = feishuReviewEventId(review, 'observation');
    const concept = source.index.concepts.find(item => item.id === review.state.conceptId)!;
    // Normal Feishu mental answers are empty. This synthetic cross-channel event
    // collision exercises a pending mental intent against a genuinely cleared written answer.
    store.addObservation({ eventId, conceptId: concept.id, sourceRevision: concept.source.revision, observedAt: frozen.observedAt,
      configRevision: frozen.configRevision, anchorEventId: frozen.anchorEventId, answer: 'SYNTHETIC_HTTP_FEISHU_ANSWER', evidenceMode: 'written',
      rating: 'clear', exposure: 'unexposed', observedExposure: false }, frozen.anchorEventId);
    const memory = store.getStates(source.index.concepts, V3_NOW);
    const before = store.exportData(source.index.source, source.index.concepts);
    assert.equal((await f.send(clearPath(eventId), { method: 'POST', cookie: setup.cookie, headers: auth })).status, 201);
    const settle = accounts.settleFeishuReviewOperation;
    accounts.settleFeishuReviewOperation = () => { throw new Error('synthetic unknown settlement'); };
    click(revealed, '清楚');
    const pending = accounts.getFeishuReviewOperations(review.id, actor, authorization)[0];
    assert.equal(pending.status, 'pending'); assert.equal(store.countObservations(), 1);
    accounts.settleFeishuReviewOperation = settle;
    send('知识 继续复习');
    const terminal = accounts.getFeishuReviewOperations(review.id, actor, authorization)[0];
    assert.equal(terminal.status, 'conflict'); assert.equal(terminal.errorCode, 'ANSWER_CLEARED'); assert.deepEqual(terminal.intent, pending.intent);
    send('知识 继续复习');
    assert.deepEqual(accounts.getFeishuReviewOperations(review.id, actor, authorization)[0], terminal);
    assert.equal(store.countObservations(), 1); assert.deepEqual(store.getCompletedConceptIds(V3_NOW, 'UTC'), [concept.id]);
    assert.deepEqual(store.getStates(source.index.concepts, V3_NOW), memory);
    const after = store.exportData(source.index.source, source.index.concepts);
    for (const key of ['anchors', 'retentions', 'config', 'configHistory', 'reviewPlan'] as const) assert.deepEqual(after[key], before[key], key);
    assert.equal(after.observations[0].answer, null); assert.doesNotMatch(JSON.stringify(after), /SYNTHETIC_HTTP_FEISHU_ANSWER/);
  } finally { accounts?.close(); await f.close(); }
});
