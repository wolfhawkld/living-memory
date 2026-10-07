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
async function fixture(extraCandidates = false, mixedDomains = false) {
  const dir = mkdtempSync(join(tmpdir(), 'lm-review-capability-'));
  const root = join(dir, 'kg'); mkdirSync(join(root, 'Math'), { recursive: true });
  function note(body: string) { writeFileSync(join(root, 'Math', 'Alpha.md'), `---\ntype: concept\ntitle: Synthetic Alpha\nsummary: SECRET_SUMMARY\n---\n${body}`); }
  note(`SECRET_BODY_START\n${'synthetic paragraph details '.repeat(400)}\nSECRET_BODY_END`);
  if (extraCandidates) for (let index = 0; index < 6; index++) {
    writeFileSync(join(root, 'Math', `Other${index}.md`), `---\ntype: concept\ntitle: Synthetic Other ${index}\n---\nOTHER_BODY_${index}`);
  }
  if (mixedDomains) {
    mkdirSync(join(root, 'Interest'));
    writeFileSync(join(root, 'Interest', 'Other.md'), '---\ntype: concept\ntitle: Synthetic Interest\n---\nINTEREST_BODY');
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
  const operations = (sessionId?: string) => accounts.getFeishuReviewOperations(sessionId ?? session().id, actor, auth);
  function sql(statement: string) { const db = new DatabaseSync(dbPath); try { db.exec(statement); } finally { db.close(); } }
  return { get accounts() { return accounts; }, get store() { return store; }, get cards() { return cards; },
    get source() { return source; }, concept, message, accept, action, send, click, session, operations, sql,
    payload: (reply: PreparedFeishuCardReply) => JSON.stringify(reply.card),
    export: () => store.exportData(source.index.source, source.index.concepts),
    advance(ms: number) { instant += ms; },
    changeSource() { note('NEW_SECRET_BODY'); source = loadKnowledgeGraph({ root }); },
    rebind() { accounts.revokeFeishuBinding(user.id, browser.sessionId, auth.bindingId); auth = bind(); },
    reopen(beforeOpen?: () => void) { store.close(); accounts.close(); beforeOpen?.(); accounts = new Accounts({ dataDir: dir, now }); store = openStore(); cards = capabilities(); },
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

test('explicit three/five batches freeze unique queues within the global budget and resume without replacing them', async () => {
  for (const size of [3, 5] as const) {
    const f = await fixture(true); try {
      const front = f.send(`知识 复习 ${size}`); const before = structuredClone(f.session());
      assert.equal(before.state.batch!.items.length, size); assert.equal(before.state.batch!.requestedSize, size);
      assert.equal(new Set(before.state.batch!.items.map(item => item.id)).size, size);
      assert.equal(new Set(before.state.batch!.items.map(item => item.conceptId)).size, size);
      assert.ok(before.state.batch!.items.every(item => item.frozen === null));
      assert.doesNotMatch(f.payload(front), /SECRET_BODY|OTHER_BODY|SECRET_SUMMARY/);
      f.reopen(); f.send(`知识 复习 ${size === 3 ? 5 : 3}`);
      assert.deepEqual(f.session().state.batch, before.state.batch);
      assert.equal(f.session().expiresAt, before.expiresAt); assert.equal(f.store.countObservations(), 0);
    } finally { f.cleanup(); }
  }
  const f = await fixture(); try {
    const front = f.send('知识 复习 5');
    assert.equal(f.session().state.batch!.items.length, 1); assert.match(f.payload(front), /请求 5 项.*按实际数量/);
    f.send('知识 结束复习');
    f.store.updateReviewPlan({ revision: f.store.getReviewPlan().revision, dailyBudget: 1 });
    f.store.addObservation({ eventId: 'batch-exhausted-budget', conceptId: f.concept.id, sourceRevision: f.concept.source.revision,
      observedAt: '2026-10-07T01:00:00Z', configRevision: 1, anchorEventId: 'original-anchor', answer: 'synthetic written answer',
      rating: 'partial', exposure: 'unexposed', observedExposure: false }, 'original-anchor');
    assert.match(f.payload(f.send('知识 复习 3')), /当前没有可用候选/); assert.equal(f.session(), null);
  } finally { f.cleanup(); }
});

test('due batch entry preserves its domain and uses the remaining account-wide budget', async () => {
  const f = await fixture(true, true); try {
    f.store.updateReviewPlan({ revision: f.store.getReviewPlan().revision, dailyBudget: 2 });
    const due = f.send('知识 待复习 域="Math" 量=5');
    const front = f.click(due, '开始本轮 5 项');
    const batch = f.session().state.batch!;
    assert.equal(f.session().state.domainId, 'Math'); assert.equal(batch.items.length, 2);
    assert.ok(batch.items.every(item => f.source.index.concepts.find(concept => concept.id === item.conceptId)!.source.path.startsWith('Math/')));
    assert.match(f.payload(front), /请求 5 项.*按实际数量/); assert.equal(f.store.countObservations(), 0);
  } finally { f.cleanup(); }
});

test('batch items freeze independently and write distinct observations and explicit rewarm events without automatic advance', async () => {
  const f = await fixture(true); try {
    const front = f.send('知识 复习 3'); const batchSession = f.session(); const initial = f.export();
    const saved1 = f.click(f.click(front, '查看资料'), '脑中回忆清楚');
    const frozen1 = f.session().state.frozen!;
    assert.equal(f.session().state.batch!.cursor, 0); assert.deepEqual(f.export().anchors, initial.anchors);
    const reviewed1 = f.click(saved1, '确认已重温，更新时间');
    assert.equal(f.session().state.batch!.cursor, 0); assert.equal(f.export().anchors.length, initial.anchors.length + 1);
    f.advance(60_000); f.store.updateConfig(5, f.store.getConfig().revision);
    const front2 = f.click(reviewed1, '下一条');
    assert.equal(f.session().state.batch!.cursor, 1); assert.equal(f.session().state.frozen, null);
    const saved2 = f.click(f.click(front2, '查看资料'), '脑中回忆模糊');
    const frozen2 = f.session().state.frozen!;
    assert.equal(frozen1.halfLifeDays, 7); assert.equal(frozen2.halfLifeDays, 5);
    assert.notEqual(frozen1.observedAt, frozen2.observedAt);
    const reviewed2 = f.click(saved2, '确认已重温，更新时间');
    const front3 = f.click(reviewed2, '下一条');
    const summary = f.click(front3, '跳过本条');
    const observations = f.store.getObservations(); assert.equal(observations.length, 2);
    assert.equal(new Set(observations.map(item => item.eventId)).size, 2);
    assert.ok(observations.every(item => item.eventId.startsWith(`feishu-observation:${batchSession.id}:`)));
    assert.equal(f.export().anchors.length, initial.anchors.length + 2);
    assert.match(f.payload(summary), /脑中自评已保存 2 项：清楚 1、模糊 1、想不起 0/);
    assert.match(f.payload(summary), /明确确认重温已保存 2 项/); assert.match(f.payload(summary), /主动跳过 1 项/);
    assert.equal(f.operations(batchSession.id).filter(item => item.status === 'applied').length, 4);
    assert.equal(f.session(), null);
  } finally { f.cleanup(); }
});

test('skipping, pausing and early ending preserve the queue and do not write evidence or reserve budget', async () => {
  const f = await fixture(true); try {
    const before = f.export(); const front = f.send('知识 复习 5'); const id = f.session().id;
    const queue = structuredClone(f.session().state.batch!.items);
    const paused = f.click(f.click(front, '查看资料'), '暂停复习');
    assert.doesNotMatch(f.payload(paused), /SECRET_BODY|OTHER_BODY/);
    f.reopen(); const resumed = f.send('知识 继续复习');
    assert.deepEqual(f.session().state.batch!.items.map(item => item.id), queue.map(item => item.id));
    const second = f.click(resumed, '跳过本条'); assert.equal(f.session().state.batch!.cursor, 1);
    const summary = f.click(second, '结束复习');
    assert.match(f.payload(summary), /主动跳过 1 项.*提前结束未完成 1 项.*未开始 3 项/);
    assert.deepEqual(f.operations(id), []); unchanged(f, before);
    assert.deepEqual(f.store.getCompletedConceptIds('2026-10-07T01:00:00Z', 'UTC'), []);
  } finally { f.cleanup(); }
});

test('pending batch recovery saves the original item and requires another explicit advance or finish', async () => {
  const f = await fixture(true); try {
    const revealed = f.click(f.send('知识 复习 3'), '查看资料');
    f.sql("CREATE TRIGGER reject_observation BEFORE INSERT ON observations BEGIN SELECT RAISE(ABORT,'synthetic batch unavailable'); END");
    const pending = f.click(revealed, '脑中想不起'); const itemId = f.operations()[0].itemId;
    assert.doesNotMatch(f.payload(pending), /"content":"下一条"|"content":"跳过本条"|"content":"结束复习"/);
    f.reopen(); f.sql('DROP TRIGGER reject_observation');
    const recovered = f.send('知识 结束复习');
    assert.equal(f.operations()[0].itemId, itemId); assert.equal(f.operations()[0].status, 'applied');
    assert.equal(f.session().state.batch!.cursor, 0); assert.equal(f.session().state.phase, 'saved');
    assert.match(f.payload(recovered), /请再次点击下一条或结束本轮/);
    f.click(recovered, '下一条'); assert.equal(f.session().state.batch!.cursor, 1);
    assert.equal(f.store.countObservations(), 1);
  } finally { f.cleanup(); }
});

test('Store commit followed by journal failure recovers the exact batch item once across reopen', async () => {
  const f = await fixture(true); try {
    const revealed = f.click(f.send('知识 复习 3'), '查看资料');
    f.accounts.settleFeishuReviewOperation = () => { throw new Error('synthetic batch settlement unavailable'); };
    f.click(revealed, '脑中回忆清楚'); const original = f.operations()[0];
    assert.equal(f.store.countObservations(), 1); assert.equal(original.status, 'pending');
    f.reopen(); const recovered = f.send('知识 继续复习');
    assert.deepEqual(f.operations()[0].intent, original.intent); assert.equal(f.operations()[0].itemId, original.itemId);
    assert.equal(f.session().state.batch!.cursor, 0); assert.equal(f.store.countObservations(), 1);
    const next = f.click(recovered, '下一条'); f.click(f.click(next, '查看资料'), '脑中回忆模糊');
    assert.equal(f.store.countObservations(), 2); assert.equal(new Set(f.operations().map(item => item.itemId)).size, 2);
  } finally { f.cleanup(); }
});

test('a conflicted rewarm retains its saved self-report and does not contaminate the next item', async () => {
  const f = await fixture(true); try {
    const saved = f.click(f.click(f.send('知识 复习 3'), '查看资料'), '脑中回忆清楚'); const id = f.session().id;
    const addReview = f.store.addReview.bind(f.store);
    f.store.addReview = () => { throw new StoreError('EVENT_CONFLICT', 'synthetic fixed business conflict', 409); };
    const conflicted = f.click(saved, '确认已重温，更新时间'); f.store.addReview = addReview;
    assert.match(f.payload(conflicted), /脑中自评：已保存/); assert.match(f.payload(conflicted), /确认重温：未保存\(冲突\)/);
    const next = f.click(conflicted, '略过冲突项，继续');
    const savedNext = f.click(f.click(next, '查看资料'), '脑中想不起');
    assert.match(f.payload(savedNext), /脑中回忆记录已保存/); assert.doesNotMatch(f.payload(savedNext), /有记录写入冲突|确认重温：未保存/);
    const summary = f.click(savedNext, '结束复习');
    assert.match(f.payload(summary), /脑中自评已保存 2 项/); assert.match(f.payload(summary), /明确确认重温已保存 0 项/);
    assert.match(f.payload(summary), /冲突 1 项.*未开始 1 项/);
    assert.equal(f.operations(id).filter(item => item.status === 'applied').length, 2);
  } finally { f.cleanup(); }
});

test('frozen batch items recheck eligibility on entry and reveal without silently replacing the queue', async () => {
  for (const reason of ['retained', 'deferred', 'recent', 'completed', 'budget'] as const) {
    const f = await fixture(true); try {
      const front = f.send('知识 复习 3'); const queue = structuredClone(f.session().state.batch!.items);
      const item = queue[1]; const occurredAt = '2026-10-07T01:00:00Z';
      if (reason === 'retained') f.store.addRetention({ eventId: 'batch-web-retained', conceptId: item.conceptId, sourceRevision: item.sourceRevision,
        active: true, previousEventId: null, occurredAt }, null);
      if (reason === 'deferred') f.store.updateReviewPlan({ revision: f.store.getReviewPlan().revision,
        concept: { conceptId: item.conceptId, sourceRevision: item.sourceRevision, focus: false, deferUntil: '2026-10-08T01:00:00Z' } });
      if (reason === 'recent') f.store.addReview({ eventId: 'batch-web-recent', conceptId: item.conceptId, sourceRevision: item.sourceRevision, kind: 'review', occurredAt });
      if (reason === 'completed') {
        const anchor = f.store.getAnchor(item.conceptId, occurredAt)!.eventId;
        f.store.addObservation({ eventId: 'batch-web-completed', conceptId: item.conceptId, sourceRevision: item.sourceRevision,
          observedAt: occurredAt, configRevision: 1, anchorEventId: anchor, answer: 'synthetic cross-channel answer',
          rating: 'partial', exposure: 'unexposed', observedExposure: false }, anchor);
      }
      const saved = f.click(f.click(front, '查看资料'), '脑中回忆清楚');
      if (reason === 'budget') f.store.updateReviewPlan({ revision: f.store.getReviewPlan().revision, dailyBudget: 1 });
      const blocked = f.click(saved, '下一条'); assert.equal(f.session().state.batch!.cursor, 1, reason);
      assert.match(f.payload(blocked), /当前已不在待复习范围/, reason); assert.doesNotMatch(f.payload(blocked), /SECRET_BODY|OTHER_BODY/, reason);
      assert.equal(f.session().state.frozen, null); assert.deepEqual(f.session().state.batch!.items.map(item => item.id), queue.map(item => item.id));
      const before = f.export(); const next = f.click(blocked, '跳过资格变化项');
      assert.equal(f.session().state.batch!.cursor, 2); assert.equal(f.session().state.batch!.items[1].disposition, 'ineligible');
      unchanged(f, before); assert.ok(next);
    } finally { f.cleanup(); }
  }
});

test('batch reveals remain eligible after ranking changes and retain evidence after scheduling changes', async () => {
  const f = await fixture(true); try {
    const front = f.send('知识 复习 3'); const current = f.session().state; const queue = structuredClone(current.batch!);
    for (const concept of f.source.index.concepts.filter(item => item.id !== current.conceptId)) f.store.updateReviewPlan({ revision: f.store.getReviewPlan().revision,
      concept: { conceptId: concept.id, sourceRevision: concept.source.revision, focus: true, deferUntil: null } });
    const revealed = f.click(front, '查看资料'); assert.equal(f.session().state.phase, 'revealed');
    assert.deepEqual(f.session().state.batch!.items.map(item => item.id), queue.items.map(item => item.id));
    f.store.addRetention({ eventId: 'batch-after-reveal-retained', conceptId: current.conceptId, sourceRevision: current.sourceRevision,
      active: true, previousEventId: null, occurredAt: '2026-10-07T01:00:00Z' }, null);
    f.store.updateReviewPlan({ revision: f.store.getReviewPlan().revision, dailyBudget: 1 });
    const other = f.source.index.concepts.find(item => item.id !== current.conceptId)!;
    const anchorEventId = f.store.getAnchor(other.id, '2026-10-07T01:00:00Z')!.eventId;
    f.store.addObservation({ eventId: 'batch-after-reveal-budget', conceptId: other.id, sourceRevision: other.source.revision,
      observedAt: '2026-10-07T01:00:00Z', configRevision: 1, anchorEventId, answer: 'synthetic cross-channel answer',
      rating: 'partial', exposure: 'unexposed', observedExposure: false }, anchorEventId);
    const frozen = structuredClone(f.session().state.frozen);
    f.click(revealed, '脑中回忆清楚'); assert.equal(f.store.countObservations(), 2);
    assert.equal(f.store.getObservations().filter(item => item.conceptId === current.conceptId).length, 1);
    assert.deepEqual(f.session().state.frozen, frozen);
    assert.equal(f.session().state.phase, 'saved'); assert.equal(f.export().retentions!.length, 1);
  } finally { f.cleanup(); }
});

test('cross-day continuation keeps the queue and absolute expiry while using the current day budget', async () => {
  const f = await fixture(true); try {
    f.store.updateReviewPlan({ revision: f.store.getReviewPlan().revision, dailyBudget: 3 });
    const front = f.send('知识 复习 3'); const expiry = f.session().expiresAt;
    const saved = f.click(f.click(front, '查看资料'), '脑中回忆清楚');
    f.store.updateReviewPlan({ revision: f.store.getReviewPlan().revision, dailyBudget: 1 });
    f.advance(23 * 60 * 60_000);
    const next = f.click(f.send('知识 继续复习'), '下一条');
    assert.equal(f.session().expiresAt, expiry); assert.equal(f.session().state.batch!.cursor, 1);
    f.click(next, '查看资料'); assert.equal(f.session().state.phase, 'revealed');
    assert.equal(f.store.getCompletedConceptIds('2026-10-08T00:00:00Z', 'UTC').length, 0); assert.ok(saved);
  } finally { f.cleanup(); }
});

test('changed or expired batches stop navigation and show a body-free honest ending summary', async () => {
  for (const reason of ['source', 'expiry']) {
    const f = await fixture(true); try {
      f.click(f.click(f.send('知识 复习 3'), '查看资料'), '脑中回忆清楚');
      if (reason === 'source') f.changeSource(); else f.advance(25 * 60 * 60_000);
      const blocked = f.send('知识 继续复习');
      assert.doesNotMatch(f.payload(blocked), /SECRET_BODY|OTHER_BODY|NEW_SECRET_BODY|"content":"下一条"|"content":"跳过本条"/);
      assert.equal(f.session().state.batch!.cursor, 0);
      const summary = f.click(blocked, '结束复习');
      assert.match(f.payload(summary), /脑中自评已保存 1 项/); assert.match(f.payload(summary), /未开始 2 项/);
      assert.doesNotMatch(f.payload(summary), /SECRET_BODY|OTHER_BODY|NEW_SECRET_BODY|"content":"结束复习"/);
      assert.equal(f.store.countObservations(), 1);
    } finally { f.cleanup(); }
  }
});

test('a failed batch advance transaction consumes neither the old card nor its receipt and can be retried exactly', async () => {
  const f = await fixture(true); try {
    const front = f.send('知识 复习 3'); const action = f.action(front, '跳过本条'); const old = structuredClone(f.session());
    const db = new DatabaseSync(f.accounts.dbPath);
    try { db.exec("CREATE TRIGGER reject_batch_advance BEFORE UPDATE ON feishu_review_sessions BEGIN SELECT RAISE(ABORT,'synthetic advance unavailable'); END"); }
    finally { db.close(); }
    assert.equal(f.cards.prepareAction(action), null); assert.deepEqual(f.session(), old);
    assert.ok(f.accounts.getFeishuCardForAction(action));
    const retryDb = new DatabaseSync(f.accounts.dbPath); try { retryDb.exec('DROP TRIGGER reject_batch_advance'); } finally { retryDb.close(); }
    const reply = f.cards.prepareAction(action); assert.ok(reply); f.accept(reply);
    assert.equal(f.session().state.batch!.cursor, 1);
    assert.equal(f.cards.prepareAction({ ...action, eventId: 'batch-duplicate-delivery' }), null);
    assert.equal(f.store.countObservations(), 0);
  } finally { f.cleanup(); }
});

test('a genuine legacy single-item pending journal upgrades and recovers through the current capability without new event IDs', async () => {
  const f = await fixture(); try {
    pendingGrade(f); const original = structuredClone(f.operations()[0]); const state = structuredClone(f.session().state);
    const dbPath = f.accounts.dbPath;
    f.reopen(() => {
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(`BEGIN IMMEDIATE;
          ALTER TABLE feishu_review_operations RENAME TO upgraded_test_operations;
          CREATE TABLE feishu_review_operations (
            id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES feishu_review_sessions(id),
            kind TEXT NOT NULL CHECK(kind IN ('observation','review')), intent_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending','applied','conflict')),
            error_code TEXT, created_at TEXT NOT NULL, settled_at TEXT, UNIQUE(session_id,kind)
          );
          INSERT INTO feishu_review_operations(id,session_id,kind,intent_json,status,error_code,created_at,settled_at)
            SELECT id,session_id,kind,intent_json,status,error_code,created_at,settled_at FROM upgraded_test_operations;
          DROP TABLE upgraded_test_operations;
          COMMIT;`);
      } finally { db.close(); }
    });
    assert.deepEqual(f.session().state, state); assert.deepEqual(f.operations()[0], original);
    assert.equal(f.operations()[0].itemId, f.session().id);
    f.sql('DROP TRIGGER reject_observation'); f.send('知识 继续复习');
    assert.equal(f.operations()[0].id, original.id); assert.deepEqual(f.operations()[0].intent, original.intent);
    assert.equal(f.operations()[0].status, 'applied'); assert.equal(f.store.countObservations(), 1);
    assert.equal(f.store.getObservations()[0].eventId, `feishu-observation:${f.session().id}`);
    assert.equal(f.session().state.batch, undefined);
  } finally { f.cleanup(); }
});
