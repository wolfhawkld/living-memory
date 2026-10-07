import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '../src/server/accounts.js';
import { Store, StoreError } from '../src/server/store.js';
import { loadKnowledgeGraph } from '../src/server/kg.js';
import { createFeishuCardCapabilities, type PreparedFeishuCardReply } from '../src/server/feishu-cards.js';
import { selectFeishuReviewCandidates } from '../src/server/feishu-card-view.js';
import { summarizeLearning } from '../src/core/learning-evidence.js';
import type { FeishuCardNavAction } from '../src/shared/feishu-cards.js';

const actor = { appId: 'synthetic-app', tenantKey: 'synthetic-tenant', openId: 'synthetic-owner' };
async function fixture(extraCandidates = false) {
  const dir = mkdtempSync(join(tmpdir(), 'lm-review-capability-'));
  const root = join(dir, 'kg'); mkdirSync(join(root, 'Math'), { recursive: true });
  function note(body: string) { writeFileSync(join(root, 'Math', 'Alpha.md'), `---\ntype: concept\ntitle: Synthetic Alpha\nsummary: SECRET_SUMMARY\n---\n${body}`); }
  note(`SECRET_BODY_START\n${'synthetic paragraph details '.repeat(400)}\nSECRET_BODY_END`);
  if (extraCandidates) for (let index = 0; index < 6; index++) {
    writeFileSync(join(root, 'Math', `Other${index}.md`), `---\ntype: concept\ntitle: Synthetic Other ${index}\n---\nOTHER_BODY_${index}`);
  }
  let source = loadKnowledgeGraph({ root });
  let instant = Date.parse('2026-10-07T01:00:00Z'); let sequence = 0;
  const now = () => new Date(instant);
  let accounts = new Accounts({ dataDir: dir, now });
  const user = await accounts.setup('synthetic', 'synthetic-integration-password');
  const browser = accounts.issueSession(user.id);
  const bind = () => {
    const issued = accounts.issueFeishuBindingRequest(user.id, browser.sessionId, actor);
    assert.equal(accounts.confirmFeishuBinding({ ...actor, code: issued.command.split(' ')[1], eventId: `bind-${++sequence}`, messageId: `binding-${sequence}`, chatId: 'private-chat' }).status, 'confirmed');
    return { userId: user.id, accessRevision: user.accessRevision, bindingId: accounts.getFeishuBindingState(user.id).binding!.id };
  };
  let auth = bind();
  const dbPath = join(dir, 'learning.sqlite');
  const openStore = () => new Store({ dbPath, namespace: source.namespace, now });
  let store = openStore();
  const concept = source.index.concepts.find(item => item.title === 'Synthetic Alpha')!;
  store.addReview({ eventId: 'original-anchor', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review', occurredAt: '2026-09-30T01:00:00Z' });
  if (extraCandidates) for (const item of source.index.concepts.filter(item => item.id !== concept.id)) {
    store.addReview({ eventId: `old-${item.title.replaceAll(' ', '-')}`, conceptId: item.id, sourceRevision: item.source.revision, kind: 'review', occurredAt: '2026-09-30T01:00:00Z' });
  }
  let cards = capabilities();
  function capabilities() { return createFeishuCardCapabilities({ accounts, scope: actor, timeZone: 'UTC', now,
    contextForUser: id => { assert.equal(id, user.id); return { source, store }; } }); }
  function message(text: string, id = `message-${++sequence}`) { return { ...actor, text, messageId: id, eventId: `event-${id}`, chatId: 'private-chat' }; }
  function accept(reply: PreparedFeishuCardReply) {
    assert.equal(reply.stillAuthorized(), true);
    reply.settle({ status: 'platform-accepted', messageId: `platform-${reply.operationId}`, chatId: 'private-chat' });
    return reply;
  }
  function action(reply: PreparedFeishuCardReply, caption: string): FeishuCardNavAction {
    const elements = (reply.card.body as { elements: Array<{ tag: string; text?: { content: string }; behaviors?: Array<{ value: { cardId: string; actionId: string } }> }> }).elements;
    const button = elements.find(item => item.tag === 'button' && item.text?.content === caption);
    assert.ok(button, `missing ${caption}: ${JSON.stringify(reply.card)}`);
    const value = button.behaviors![0].value;
    return { ...actor, ...value, eventId: `click-${++sequence}`, messageId: `platform-${reply.operationId}`, chatId: 'private-chat' };
  }
  function send(text: string) { const reply = cards.prepareMessage(message(text)); assert.ok(reply); return accept(reply); }
  function click(reply: PreparedFeishuCardReply, caption: string) { const next = cards.prepareAction(action(reply, caption)); assert.ok(next); return accept(next); }
  const session = () => accounts.getFeishuReviewSession(actor, auth, source.namespace)!;
  const operations = () => accounts.getFeishuReviewOperations(session().id, actor, auth);
  function sql(statement: string) { const db = new DatabaseSync(dbPath); try { db.exec(statement); } finally { db.close(); } }
  return { get accounts() { return accounts; }, get store() { return store; }, get cards() { return cards; },
    get source() { return source; }, concept, message, accept, action, send, click, session, operations, sql,
    payload: (reply: PreparedFeishuCardReply) => JSON.stringify(reply.card),
    export: () => store.exportData(source.index.source, source.index.concepts),
    advance(ms: number) { instant += ms; },
    changeSource() { note('NEW_SECRET_BODY'); source = loadKnowledgeGraph({ root }); },
    rebind() { accounts.revokeFeishuBinding(user.id, browser.sessionId, auth.bindingId); auth = bind(); },
    reopen() { store.close(); accounts.close(); accounts = new Accounts({ dataDir: dir, now }); store = openStore(); cards = capabilities(); },
    cleanup() { store.close(); accounts.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function unchanged(f: Awaited<ReturnType<typeof fixture>>, before: ReturnType<typeof f.export>) {
  const after = f.export();
  for (const key of ['anchors', 'observations', 'retentions', 'config', 'configHistory'] as const) assert.deepEqual(after[key], before[key], key);
}
function pendingGrade(f: Awaited<ReturnType<typeof fixture>>) {
  const revealed = f.click(f.send('知识 复习'), '查看资料');
  f.sql("CREATE TRIGGER reject_observation BEFORE INSERT ON observations BEGIN SELECT RAISE(ABORT,'synthetic write unavailable'); END");
  const pending = f.click(revealed, '脑中回忆清楚');
  assert.equal(f.operations()[0].status, 'pending'); assert.equal(f.store.countObservations(), 0);
  return pending;
}

test('front card omits private body, summary and history; browsing, pause and paging are read only', async () => {
  const f = await fixture(); try {
    f.store.addObservation({ eventId: 'old-written-history', conceptId: f.concept.id, sourceRevision: f.concept.source.revision,
      observedAt: '2026-10-01T01:00:00Z', configRevision: 1, anchorEventId: 'original-anchor',
      answer: 'SECRET_HISTORY_ANSWER', rating: 'clear', exposure: 'unexposed', observedExposure: false }, 'original-anchor');
    const before = f.export(); const front = f.send('知识 复习');
    assert.doesNotMatch(f.payload(front), /SECRET_BODY|SECRET_SUMMARY|SECRET_HISTORY_ANSWER|old-written-history|original-anchor/);
    const revealed = f.click(front, '查看资料'); assert.match(f.payload(revealed), /SECRET_BODY_START/);
    const page = f.click(revealed, '下一页');
    const paused = f.click(page, '暂停复习'); assert.doesNotMatch(f.payload(paused), /SECRET_BODY|synthetic paragraph/);
    const resumed = f.send('知识 继续复习'); assert.equal(f.session().state.paused, false);
    assert.ok(resumed); unchanged(f, before);
    f.send('知识 结束复习');
    const due = f.send('知识 待复习'); const reading = f.click(due, '阅读 1'); assert.match(f.payload(reading), /SECRET_BODY_START/);
    unchanged(f, before);
  } finally { f.cleanup(); }
});

test('due candidate starts mental review; grade completes budget without confidence or anchor updates; review confirmation is separate', async () => {
  const f = await fixture(); try {
    const before = f.export(); const front = f.click(f.send('知识 待复习'), '回忆 1');
    const saved = f.click(f.click(front, '查看资料'), '脑中回忆模糊');
    const [observation] = f.store.getObservations();
    assert.equal(observation.answer, ''); assert.equal(observation.evidenceMode, 'mental'); assert.equal(observation.rating, 'partial');
    assert.equal(observation.exposure, 'unknown'); assert.equal(observation.observedExposure, false);
    assert.deepEqual(observation.learning, { task: 'concept', cue: 'unknown', outcome: 'unverified', basis: 'self-check', confidence: null, confidenceAt: null });
    assert.equal(summarizeLearning([observation]).calibration.concept.count, 0);
    assert.deepEqual(f.store.getCompletedConceptIds('2026-10-07T01:00:00Z', 'UTC'), [f.concept.id]);
    assert.deepEqual(f.export().anchors, before.anchors); assert.deepEqual(f.export().config, before.config);
    f.store.addRetention({ eventId: 'manual-retained', conceptId: f.concept.id, sourceRevision: f.concept.source.revision, active: true, previousEventId: null, occurredAt: '2026-10-07T01:00:00Z' }, null);
    const retained = f.export().retentions;
    f.advance(60_000); f.click(saved, '确认已重温，更新时间');
    assert.equal(f.export().anchors.length, before.anchors.length + 1); assert.deepEqual(f.export().retentions, retained);
    assert.deepEqual(f.export().config, before.config); assert.equal(f.store.countObservations(), 1);
  } finally { f.cleanup(); }
});

test('reveal freezes H, config and original anchor despite later H and historical anchor changes', async () => {
  const f = await fixture(); try {
    const revealed = f.click(f.send('知识 复习'), '查看资料'); const frozen = f.session().state.frozen!;
    f.store.updateConfig(30, frozen.configRevision);
    f.store.addReview({ eventId: 'later-history', conceptId: f.concept.id, sourceRevision: f.concept.source.revision, kind: 'review', occurredAt: '2026-10-06T01:00:00Z' });
    f.advance(60_000); f.click(revealed, '脑中回忆清楚');
    const [event] = f.store.getObservations(); assert.equal(event.configRevision, frozen.configRevision); assert.equal(event.halfLifeDays, frozen.halfLifeDays);
    assert.equal(event.anchorEventId, 'original-anchor'); assert.equal(event.elapsedDays, 7); assert.equal(event.decay, 0.5);
    assert.equal(event.observedAt, frozen.observedAt);
  } finally { f.cleanup(); }
});

test('real learning SQLite failure retains immutable pending intent across reopen and explicit retry writes once', async () => {
  const f = await fixture(); try {
    pendingGrade(f); const original = f.operations()[0]; f.reopen(); f.sql('DROP TRIGGER reject_observation');
    f.send('知识 继续复习'); assert.equal(f.operations()[0].id, original.id); assert.equal(f.operations()[0].status, 'applied');
    assert.deepEqual(f.operations()[0].intent, original.intent); assert.equal(f.store.countObservations(), 1);
    f.send('知识 继续复习'); assert.equal(f.store.countObservations(), 1);
  } finally { f.cleanup(); }
});

test('committed Store event with failed journal settlement compares exact duplicate after reopening', async () => {
  const f = await fixture(); try {
    const revealed = f.click(f.send('知识 复习'), '查看资料');
    f.accounts.settleFeishuReviewOperation = () => { throw new Error('synthetic settlement unavailable'); };
    f.click(revealed, '脑中想不起'); assert.equal(f.store.countObservations(), 1); assert.equal(f.operations()[0].status, 'pending');
    const intent = f.operations()[0].intent; assert.equal(intent.kind, 'observation');
    f.reopen(); f.changeSource(); f.advance(25 * 60 * 60_000);
    const recovered = f.send('知识 继续复习'); assert.equal(f.operations()[0].status, 'applied'); assert.equal(f.store.countObservations(), 1);
    assert.doesNotMatch(f.payload(recovered), /SECRET_BODY|NEW_SECRET_BODY/);
    assert.equal(f.store.addObservation(intent.request as Parameters<Store['addObservation']>[0], 'original-anchor').status, 'duplicate');
  } finally { f.cleanup(); }
});

test('unknown send never rolls back saved learning, activates failed card or automatically repeats message', async () => {
  const f = await fixture(); try {
    const revealed = f.click(f.send('知识 复习'), '查看资料'); const click = f.action(revealed, '脑中回忆清楚');
    const saved = f.cards.prepareAction(click)!; assert.ok(saved); saved.settle({ status: 'failed-or-unknown' });
    assert.equal(f.store.countObservations(), 1); assert.equal(saved.stillAuthorized(), false);
    assert.equal(f.cards.prepareAction({ ...click, eventId: 'redelivery' }), null);
    assert.equal(f.cards.prepareAction(f.action(saved, '确认已重温，更新时间')), null);
    f.reopen(); assert.equal(f.cards.prepareAction({ ...click, eventId: 'restart-redelivery' }), null);
    assert.match(f.payload(f.send('知识 继续复习')), /脑中回忆记录已保存/); assert.equal(f.store.countObservations(), 1);
  } finally { f.cleanup(); }
});

test('resuming advances version even when new send fails, invalidating earlier prepared guard', async () => {
  const f = await fixture(); try {
    f.send('知识 复习'); const old = f.cards.prepareMessage(f.message('知识 继续复习'))!; assert.equal(old.stillAuthorized(), true);
    const failed = f.cards.prepareMessage(f.message('知识 继续复习'))!; failed.settle({ status: 'failed-or-unknown' });
    assert.equal(old.stillAuthorized(), false); assert.equal(f.store.countObservations(), 0);
  } finally { f.cleanup(); }
});

for (const reason of ['source', 'expiry'] as const) test(`${reason} invalidation rejects pending new learning and hides stale body`, async () => {
  const f = await fixture(); try {
    pendingGrade(f); f.sql('DROP TRIGGER reject_observation');
    if (reason === 'source') f.changeSource(); else f.advance(24 * 60 * 60_000);
    const reply = f.send('知识 继续复习'); assert.equal(f.store.countObservations(), 0);
    assert.equal(f.operations()[0].status, 'conflict'); assert.equal(f.operations()[0].errorCode, reason === 'source' ? 'SOURCE_CHANGED' : 'SESSION_EXPIRED');
    assert.doesNotMatch(f.payload(reply), /SECRET_BODY|NEW_SECRET_BODY/);
  } finally { f.cleanup(); }
});

test('same event ID with different existing payload is a terminal conflict, never a false success', async () => {
  const f = await fixture(); try {
    pendingGrade(f); f.sql('DROP TRIGGER reject_observation'); const intent = f.operations()[0].intent;
    assert.equal(intent.kind, 'observation');
    f.store.addObservation({ ...(intent.request as Parameters<Store['addObservation']>[0]), rating: 'blank' }, 'original-anchor');
    const reply = f.send('知识 继续复习'); assert.equal(f.operations()[0].status, 'conflict'); assert.equal(f.operations()[0].errorCode, 'EVENT_CONFLICT');
    assert.match(f.payload(reply), /写入冲突/); assert.equal(f.store.getObservations()[0].rating, 'blank'); assert.equal(f.session().state.phase, 'revealed');
  } finally { f.cleanup(); }
});

test('finish touches pending session, recovers save without finishing, and second finish closes it', async () => {
  const f = await fixture(); try {
    pendingGrade(f); f.sql('DROP TRIGGER reject_observation');
    f.send('知识 结束复习'); assert.equal(f.session().state.phase, 'saved'); assert.equal(f.store.countObservations(), 1);
    const finished = f.send('知识 结束复习'); assert.equal(f.session(), null); assert.match(f.payload(finished), /已结束/);
  } finally { f.cleanup(); }
});

test('30 minute card TTL does not end 24 hour session; wrong actors, forwarding and binding ABA cannot write', async () => {
  const f = await fixture(); try {
    const front = f.send('知识 复习'); const reveal = f.action(front, '查看资料');
    for (const change of [{ openId: 'other' }, { tenantKey: 'other' }, { chatId: 'forwarded' }, { messageId: 'forwarded' }]) assert.equal(f.cards.prepareAction({ ...reveal, ...change }), null);
    f.advance(31 * 60_000); assert.equal(f.cards.prepareAction(reveal), null); assert.equal(f.session().state.phase, 'front');
    const resumed = f.send('知识 继续复习'); const fresh = f.action(resumed, '查看资料');
    f.rebind(); assert.equal(f.cards.prepareAction(fresh), null); assert.equal(resumed.stillAuthorized(), false); assert.equal(f.session(), null);
    assert.equal(f.store.countObservations(), 0);
  } finally { f.cleanup(); }
});

test('changed source or expired session before grading never creates a new learning intent', async () => {
  for (const reason of ['source', 'expiry'] as const) {
    const f = await fixture(); try {
      const revealed = f.click(f.send('知识 复习'), '查看资料');
      const grade = f.action(revealed, '脑中回忆清楚');
      if (reason === 'source') f.changeSource(); else f.advance(24 * 60 * 60_000);
      assert.equal(f.cards.prepareAction(grade), null);
      const resumed = f.send('知识 继续复习');
      assert.doesNotMatch(f.payload(resumed), /SECRET_BODY|NEW_SECRET_BODY/);
      assert.deepEqual(f.operations(), []); assert.equal(f.store.countObservations(), 0);
      assert.equal(f.export().anchors.length, 1);
    } finally { f.cleanup(); }
  }
});


test('first reveal rechecks current eligibility; retained, deferred, recent, completed and exhausted budget fronts do not freeze or expose', async () => {
  for (const reason of ['retained', 'deferred', 'recent', 'completed', 'budget'] as const) {
    const f = await fixture(reason === 'budget'); try {
      if (reason === 'budget') f.store.updateReviewPlan({ revision: f.store.getReviewPlan().revision,
        concept: { conceptId: f.concept.id, sourceRevision: f.concept.source.revision, focus: true, deferUntil: null } });
      const front = f.send('知识 复习');
      assert.equal(f.session().state.conceptId, f.concept.id);
      const occurredAt = '2026-10-07T01:00:00Z';
      if (reason === 'retained') f.store.addRetention({ eventId: 'web-retained', conceptId: f.concept.id,
        sourceRevision: f.concept.source.revision, active: true, previousEventId: null, occurredAt }, null);
      if (reason === 'deferred') f.store.updateReviewPlan({ revision: f.store.getReviewPlan().revision,
        concept: { conceptId: f.concept.id, sourceRevision: f.concept.source.revision, focus: false, deferUntil: '2026-10-08T01:00:00Z' } });
      if (reason === 'recent') f.store.addReview({ eventId: 'web-recent-review', conceptId: f.concept.id,
        sourceRevision: f.concept.source.revision, kind: 'review', occurredAt });
      if (reason === 'completed') f.store.addObservation({ eventId: 'web-completed', conceptId: f.concept.id,
        sourceRevision: f.concept.source.revision, observedAt: occurredAt, configRevision: 1, anchorEventId: 'original-anchor',
        answer: 'synthetic written answer', rating: 'partial', exposure: 'unexposed', observedExposure: false }, 'original-anchor');
      if (reason === 'budget') {
        f.store.updateReviewPlan({ revision: f.store.getReviewPlan().revision, dailyBudget: 1 });
        const other = f.source.index.concepts.find(item => item.title === 'Synthetic Other 0')!;
        const anchorEventId = f.store.getAnchor(other.id, occurredAt)!.eventId;
        f.store.addObservation({ eventId: 'web-other-completed', conceptId: other.id, sourceRevision: other.source.revision,
          observedAt: occurredAt, configRevision: 1, anchorEventId, answer: 'synthetic other answer', rating: 'partial',
          exposure: 'unexposed', observedExposure: false }, anchorEventId);
        assert.deepEqual(f.store.getCompletedConceptIds(occurredAt, 'UTC'), [other.id]);
      }
      const before = f.export();
      const blocked = f.click(front, '查看资料');
      assert.match(f.payload(blocked), /当前已不在待复习范围/, reason);
      assert.doesNotMatch(f.payload(blocked), /SECRET_BODY|SECRET_SUMMARY/, reason);
      assert.equal(f.session().state.phase, 'front', reason); assert.equal(f.session().state.frozen, null, reason);
      unchanged(f, before); assert.deepEqual(f.operations(), []);
      f.click(blocked, '结束复习'); assert.equal(f.session(), null);
    } finally { f.cleanup(); }
  }
  const f = await fixture(); try {
    const revealed = f.click(f.send('知识 复习'), '查看资料');
    f.store.addRetention({ eventId: 'web-retained-after-reveal', conceptId: f.concept.id, sourceRevision: f.concept.source.revision,
      active: true, previousEventId: null, occurredAt: '2026-10-07T01:00:00Z' }, null);
    const retained = f.export().retentions;
    f.click(revealed, '脑中回忆清楚'); assert.equal(f.store.countObservations(), 1);
    assert.equal(f.session().state.phase, 'saved'); assert.deepEqual(f.export().retentions, retained);
  } finally { f.cleanup(); }
});

test('an eligible front remains revealable after moving below global top five without source changes', async () => {
  const f = await fixture(true); try {
    const preference = (id: string, focus: boolean) => {
      const concept = f.source.index.concepts.find(item => item.id === id)!;
      f.store.updateReviewPlan({ revision: f.store.getReviewPlan().revision,
        concept: { conceptId: id, sourceRevision: concept.source.revision, focus, deferUntil: null } });
    };
    preference(f.concept.id, true);
    const front = f.send('知识 复习'); assert.equal(f.session().state.conceptId, f.concept.id);
    preference(f.concept.id, false);
    for (const concept of f.source.index.concepts.filter(item => item.id !== f.concept.id)) preference(concept.id, true);
    const asOf = '2026-10-07T01:00:00Z';
    const selected = selectFeishuReviewCandidates({ ...f.source.index, states: f.store.getStates(f.source.index.concepts, asOf),
      asOf, config: f.store.getConfig(), observationsCount: 0 }, { sourceId: f.source.namespace, asOf,
      timeZone: 'UTC', dayKey: '2026-10-07', plan: f.store.getReviewPlan(), completedConceptIds: [] }, null, 5);
    assert.equal(selected.candidates.length, 5); assert.ok(selected.candidates.every(item => item.conceptId !== f.concept.id));
    const revealed = f.click(front, '查看资料'); assert.match(f.payload(revealed), /SECRET_BODY_START/);
    assert.equal(f.session().state.phase, 'revealed'); assert.equal(f.store.countObservations(), 0);
  } finally { f.cleanup(); }
});

test('unclassified temporary Store errors remain pending and recover once without becoming terminal conflicts', async () => {
  const f = await fixture(); try {
    const revealed = f.click(f.send('知识 复习'), '查看资料');
    const addObservation = f.store.addObservation.bind(f.store);
    f.store.addObservation = () => { throw new StoreError('UNCLASSIFIED_TEMPORARY', 'synthetic temporary storage error', 503); };
    f.click(revealed, '脑中回忆清楚');
    const operation = f.operations()[0]; assert.equal(operation.status, 'pending'); assert.equal(operation.errorCode, null);
    assert.equal(f.store.countObservations(), 0);
    f.store.addObservation = addObservation;
    f.send('知识 继续复习'); assert.equal(f.operations()[0].id, operation.id); assert.equal(f.operations()[0].status, 'applied');
    assert.equal(f.store.countObservations(), 1); f.send('知识 继续复习'); assert.equal(f.store.countObservations(), 1);
  } finally { f.cleanup(); }
});

test('review status browse buttons obey session version even after a newer reply fails to send', async () => {
  for (const advanceVersion of [false, true]) {
    const f = await fixture(); try {
      const front = f.send('知识 复习');
      f.store.addRetention({ eventId: 'web-retained-status', conceptId: f.concept.id, sourceRevision: f.concept.source.revision,
        active: true, previousEventId: null, occurredAt: '2026-10-07T01:00:00Z' }, null);
      const status = f.click(front, '查看资料');
      assert.match(f.payload(status), /当前已不在待复习范围/);
      const browse = f.action(status, '查看待复习');
      if (advanceVersion) {
        const newer = f.cards.prepareMessage(f.message('知识 继续复习'))!;
        assert.ok(newer); newer.settle({ status: 'failed-or-unknown' });
      }
      const source = f.source;
      const before = f.export();
      const receiptCount = () => {
        const db = new DatabaseSync(f.accounts.dbPath);
        try { return db.prepare('SELECT COUNT(*) AS count FROM feishu_read_receipts').get()!.count; }
        finally { db.close(); }
      };
      const receipts = receiptCount();
      assert.ok(f.accounts.getFeishuCardForAction(browse));
      const result = f.cards.prepareAction(browse);
      if (advanceVersion) {
        assert.equal(result, null);
        assert.ok(f.accounts.getFeishuCardForAction(browse), 'version rejection must not consume the status card');
        assert.equal(receiptCount(), receipts, 'version rejection must not create a read receipt');
      } else {
        assert.ok(result, 'current status card may browse without learning writes');
        f.accept(result); assert.match(f.payload(result), /少量复习候选/);
        assert.equal(receiptCount(), Number(receipts) + 1);
      }
      assert.equal(f.source, source); unchanged(f, before);
    } finally { f.cleanup(); }
  }
});
