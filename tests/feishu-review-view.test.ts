import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planFeishuReviewView as render, type FeishuReviewRenderInput } from '../src/server/feishu-review-view.js';
import type { FeishuReviewOperation, FeishuReviewSession } from '../src/shared/feishu-review.js';
import type { Concept } from '../src/shared/types.js';

const concept: Concept = { id: 'private-id', title: '名字 <at id=all> [链接](private)', aliases: [], domain: '', summary: 'SUMMARY_SECRET', body: 'BODY_SECRET', source: { path: 'Math/concept.md', revision: 'private-revision' } };
function session(): FeishuReviewSession {
  return { id: 'a'.repeat(32), actor: { appId: 'app', tenantKey: 'tenant', openId: 'open' }, authorization: { userId: 'private-user', bindingId: 'binding', accessRevision: 1 }, namespace: 'private-namespace', sourceFingerprint: 'b'.repeat(64), originChatId: 'chat', createdAt: '2026-10-07T00:00:00Z', expiresAt: '2026-10-08T00:00:00Z', version: 1,
    state: { conceptId: concept.id, sourceRevision: concept.source.revision, domainId: 'Math', phase: 'front', paused: false, page: 1, frozen: null } };
}
function input(): FeishuReviewRenderInput { return { session: session(), concept, operations: [], availability: 'ready' }; }
function wire(value: FeishuReviewRenderInput) { return JSON.stringify(render(value).build('c'.repeat(64))); }
function verbs(value: FeishuReviewRenderInput) { return render(value).actions.flatMap(({ target }) => target.kind === 'review' ? [target.verb] : []); }
function operation(status: FeishuReviewOperation['status'], kind: 'observation' | 'review' = 'observation'): FeishuReviewOperation {
  const request = kind === 'review' ? { eventId: 'feishu-review:' + 'a'.repeat(32), conceptId: concept.id, sourceRevision: concept.source.revision, occurredAt: '2026-10-07T00:00:00Z' }
    : { eventId: 'feishu-observation:' + 'a'.repeat(32), conceptId: concept.id, sourceRevision: concept.source.revision, observedAt: '2026-10-07T00:00:00Z', configRevision: 0, halfLifeDays: 7, anchorEventId: null, answer: '', evidenceMode: 'mental' as const, rating: 'clear' as const, exposure: 'unknown' as const, observedExposure: false };
  return { id: request.eventId, sessionId: 'a'.repeat(32), itemId: 'a'.repeat(32), intent: { kind, request } as FeishuReviewOperation['intent'], status, errorCode: null, createdAt: '2026-10-07T00:00:00Z', settledAt: null };
}

test('recall front excludes summaries, bodies, private metadata, history and write actions', () => {
  const value = input(); const before = structuredClone(value); const plan = render(value);
  assert.doesNotMatch(wire(value), /SUMMARY_SECRET|BODY_SECRET|private-id|private-revision|private-user|private-namespace|<at|\[链接\]/);
  assert.deepEqual(verbs(value), ['reveal', 'pause', 'finish']);
  assert.deepEqual(value, before);
  assert.deepEqual(plan.view, { kind: 'review', sessionId: value.session!.id, version: 1, verb: 'show', page: 1 });
  const buttons = (plan.build('c'.repeat(64)).body as { elements: Record<string, unknown>[] }).elements.filter(element => element.tag === 'button');
  buttons.forEach((button, index) => assert.deepEqual(button.behaviors, [{ type: 'callback', value: { kind: 'lm.nav.v1', cardId: 'c'.repeat(64), actionId: `a${index}` } }]));
  assert.match(wire(value), /不计入独立成功或信心校准/);
  assert.match(wire(value), /只有明确确认重温才更新锚点/);
});

test('paused, changed, expired, conflict and pending states never disclose the body', () => {
  for (const availability of ['source-changed', 'expired', 'no-candidate', 'no-session'] as const) {
    const value = input(); value.availability = availability; value.session!.state.phase = 'revealed';
    assert.doesNotMatch(wire(value), /SUMMARY_SECRET|BODY_SECRET/); assert.deepEqual(verbs(value), ['finish']);
  }
  const paused = input(); paused.session!.state.phase = 'revealed'; paused.session!.state.paused = true;
  assert.doesNotMatch(wire(paused), /BODY_SECRET/); assert.deepEqual(verbs(paused), ['resume', 'finish']);
  paused.operations = [operation('pending')];
  assert.deepEqual(verbs(paused), ['resume']);
  assert.doesNotMatch(wire(paused), /BODY_SECRET/);
  paused.availability = 'source-changed';
  assert.deepEqual(verbs(paused), ['resume']);
  const pending = input(); pending.session!.state.phase = 'revealed'; pending.operations = [operation('pending')];
  assert.deepEqual(verbs(pending), ['retry', 'pause']); assert.doesNotMatch(wire(pending), /BODY_SECRET/);
  const conflict = input(); conflict.operations = [operation('conflict')];
  assert.deepEqual(verbs(conflict), ['finish']); assert.match(wire(conflict), /未保存/);
  assert.doesNotMatch(wire(conflict), /BODY_SECRET/);
});

test('saved recall and explicit rewarm remain separate actions', () => {
  const value = input(); value.session!.state.phase = 'saved'; value.operations = [operation('applied')];
  assert.deepEqual(verbs(value), ['confirm-review', 'finish']); assert.match(wire(value), /记忆时间尚未更新/);
  value.operations.push(operation('applied', 'review'));
  assert.deepEqual(verbs(value), ['finish']); assert.match(wire(value), /重温时间已保存/);
  value.session!.state.phase = 'finished';
  assert.deepEqual(verbs(value), []); assert.equal(render(value).actions[0].target.kind, 'due');
  value.session = null; value.concept = null; value.availability = 'no-session';
  assert.deepEqual(render(value).view, { kind: 'help' }); assert.match(wire(value), /知识 继续复习/);
});

test('receipts distinguish saved recall from conflicted rewarm and preserve saved status across unavailable sources', () => {
  const value = input(); value.session!.state.phase = 'saved';
  value.operations = [operation('applied'), operation('conflict', 'review')];
  assert.match(wire(value), /脑中自评：已保存/);
  assert.match(wire(value), /确认重温：未保存\(冲突\)/);
  assert.doesNotMatch(wire(value), /本次记录未保存/);
  assert.match(wire(value), /不会覆盖已保存记录/);
  value.operations = [operation('applied')];
  for (const availability of ['expired', 'source-changed'] as const) {
    value.availability = availability;
    assert.match(wire(value), /脑中自评：已保存/);
    assert.doesNotMatch(wire(value), /确认重温：/);
  }
  value.availability = 'ready'; value.operations.push(operation('pending', 'review'));
  assert.match(wire(value), /脑中自评：已保存/);
  assert.match(wire(value), /确认重温：待保存/);
  value.operations[1].status = 'applied';
  assert.match(wire(value), /确认重温：已保存/);
  assert.match(wire(value), /如刚恢复待写操作，请再次点击结束本条/);
});

test('finished sessions stay ended across source changes, expiry and conflicts, with precise receipts', () => {
  for (const availability of ['source-changed', 'expired', 'ready'] as const) {
    const value = input(); value.availability = availability; value.session!.state.phase = 'finished';
    value.operations = [operation('applied'), operation('conflict', 'review')];
    value.concept = null;
    assert.match(wire(value), /本次复习已结束/);
    assert.match(wire(value), /脑中自评：已保存/);
    assert.match(wire(value), /确认重温：未保存\(冲突\)/);
    assert.deepEqual(verbs(value), []);
    assert.equal(render(value).actions[0].target.kind, 'due');
    assert.doesNotMatch(wire(value), /BODY_SECRET|结束复习|资料或来源已变化|会话已过期/);
  }
});

test('an ineligible front offers a fixed explanation and exit without revealing content', () => {
  const value = input(); value.availability = 'ineligible'; const before = structuredClone(value);
  assert.match(wire(value), /当前已不在待复习范围，请结束后重新选择/);
  assert.doesNotMatch(wire(value), /BODY_SECRET|SUMMARY_SECRET/);
  assert.deepEqual(verbs(value), ['finish']);
  assert.ok(render(value).actions.some(action => action.target.kind === 'due'));
  assert.deepEqual(value, before);
});

test('revealed safe Unicode pages retain complete body and satisfy all wire/metadata budgets', () => {
  const value = input(); value.session!.state.phase = 'revealed'; value.session!.state.domainId = '中'.repeat(512);
  value.concept = { ...concept, body: ('中文😀 e\u0301 <at id=all> [危险](javascript:bad) ![图](private) "\\\n\t\b').repeat(900) };
  let joined = ''; let pages = 0;
  while (true) {
    const plan = render(value); const card = plan.build('c'.repeat(64));
    assert.ok(Buffer.byteLength(JSON.stringify(card)) <= 20 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify({ content: JSON.stringify(card) })) <= 24 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify({ view: plan.view, actions: plan.actions })) <= 12 * 1024);
    assert.ok(plan.actions.length <= 16);
    const elements = (card.body as { elements: { content?: string }[] }).elements;
    const body = elements[1].content!;
    assert.ok(Buffer.byteLength(body) <= 3000); assert.doesNotMatch(body, /<at|\[危险\]|!\[图\]/);
    joined += body; pages++;
    assert.ok(verbs(value).includes('rate-clear'));
    const next = plan.actions.find(({ target }) => target.kind === 'review' && target.verb === 'show' && target.page === value.session!.state.page + 1);
    if (!next || next.target.kind !== 'review') break;
    value.session!.state.page = next.target.page;
  }
  assert.ok(pages > 2);
  assert.equal(joined, value.concept.body.replaceAll('<', '＜').replaceAll('>', '＞').replaceAll('[', '［').replaceAll(']', '］'));
  value.session!.state.page = 100000;
  assert.match(wire(value), /页码超出范围/);
  assert.deepEqual(verbs(value), ['show']);
});

function batchInput(size: 3 | 5 = 3): FeishuReviewRenderInput {
  const value = input();
  value.session!.state.batch = { requestedSize: size, cursor: 0, items: Array.from({ length: size }, (_, index) => ({
    id: (index + 1).toString().repeat(32), conceptId: index ? `private-next-${index}` : concept.id,
    sourceRevision: index ? `private-revision-${index}` : concept.source.revision, frozen: null, disposition: 'open' as const,
  })) };
  return value;
}
function batchOperation(value: FeishuReviewRenderInput, index: number, status: FeishuReviewOperation['status'], kind: 'observation' | 'review' = 'observation') {
  const item = value.session!.state.batch!.items[index]; const result = operation(status, kind);
  result.itemId = item.id; result.id += ':' + item.id;
  result.intent.request = { ...result.intent.request, eventId: result.id, conceptId: item.conceptId, sourceRevision: item.sourceRevision };
  return result;
}

test('batch fronts show fixed progress with explicit skipping and saved items offer independent next and rewarm', () => {
  const value = batchInput();
  assert.match(wire(value), /本轮第 1\/3 项/); assert.ok(verbs(value).includes('skip'));
  assert.doesNotMatch(wire(value), /BODY_SECRET|SUMMARY_SECRET|private-next-/);
  value.session!.state.phase = 'saved'; value.operations = [batchOperation(value, 0, 'applied')];
  assert.deepEqual(verbs(value), ['confirm-review', 'next', 'finish']);
  assert.match(wire(value), /"content":"下一条"/); assert.doesNotMatch(wire(value), /掌握率/);
  const batch = value.session!.state.batch!; batch.cursor = 2;
  value.session!.state.conceptId = batch.items[2].conceptId; value.session!.state.sourceRevision = batch.items[2].sourceRevision;
  value.operations = [batchOperation(value, 2, 'applied')];
  assert.match(wire(value), /"content":"完成本轮"/);
  const short = batchInput(5); short.session!.state.batch!.items.splice(1);
  assert.match(wire(short), /第 1\/1 项.*请求 5 项.*候选或预算不足/);
});

test('batch pending writes suppress advancing, while earlier-item conflicts never block the current grade', () => {
  const value = batchInput(); value.session!.state.phase = 'revealed';
  value.operations = [batchOperation(value, 0, 'pending')];
  assert.deepEqual(verbs(value), ['retry', 'pause']); assert.doesNotMatch(wire(value), /BODY_SECRET/);
  value.session!.state.paused = true; assert.deepEqual(verbs(value), ['resume']);
  value.session!.state.paused = false;
  const batch = value.session!.state.batch!; batch.cursor = 1;
  value.session!.state.conceptId = batch.items[1].conceptId; value.session!.state.sourceRevision = batch.items[1].sourceRevision;
  value.operations = [batchOperation(value, 0, 'conflict')];
  assert.ok(verbs(value).includes('rate-clear')); assert.match(wire(value), /BODY_SECRET/);
  assert.doesNotMatch(wire(value), /写入冲突|未保存\(冲突\)/);
  value.operations.push(batchOperation(value, 1, 'conflict'));
  assert.deepEqual(verbs(value), ['skip', 'finish']); assert.doesNotMatch(wire(value), /BODY_SECRET/);
});

test('batch ending summary distinguishes saved reports from skipped, conflicted and unstarted items without old content', () => {
  const value = batchInput(5); const batch = value.session!.state.batch!;
  batch.items[0].disposition = 'conflict'; batch.items[1].disposition = 'completed'; batch.items[2].disposition = 'skipped';
  batch.items[3].disposition = 'ended'; batch.cursor = 3;
  value.session!.state.conceptId = batch.items[3].conceptId; value.session!.state.sourceRevision = batch.items[3].sourceRevision;
  value.session!.state.phase = 'finished';
  value.operations = [batchOperation(value, 0, 'applied'), batchOperation(value, 0, 'conflict', 'review'),
    batchOperation(value, 1, 'applied'), batchOperation(value, 1, 'applied', 'review')];
  for (const availability of ['ready', 'expired', 'source-changed'] as const) {
    value.availability = availability; value.concept = null;
    assert.match(wire(value), /脑中自评已保存 2 项/); assert.match(wire(value), /明确确认重温已保存 1 项/);
    assert.match(wire(value), /确认重温未保存\(冲突\) 1 项/);
    assert.match(wire(value), /主动跳过 1 项.*冲突 1 项.*提前结束未完成 1 项.*未开始 1 项/);
    assert.match(wire(value), /不是掌握率/); assert.match(wire(value), /不代表今日完成数/);
    assert.deepEqual(verbs(value), []); assert.equal(render(value).actions[0].target.kind, 'due');
    assert.doesNotMatch(wire(value), /BODY_SECRET|SUMMARY_SECRET|private-next-|private-revision|会话已过期/);
  }
});

test('batch ineligible fronts can skip explicitly but expired or changed sources only allow ending', () => {
  const value = batchInput(); value.availability = 'ineligible'; value.concept = null;
  assert.deepEqual(verbs(value), ['skip', 'finish']); assert.doesNotMatch(wire(value), /BODY_SECRET/);
  value.session!.state.paused = true; assert.deepEqual(verbs(value), ['resume', 'finish']);
  value.session!.state.paused = false;
  for (const availability of ['expired', 'source-changed'] as const) {
    value.availability = availability; assert.deepEqual(verbs(value), ['finish']);
  }
  value.session!.state.phase = 'saved'; value.operations = [batchOperation(value, 0, 'applied')];
  value.session!.state.domainId = '\u0001'.repeat(512);
  const plan = render(value);
  assert.ok(Buffer.byteLength(JSON.stringify({ view: plan.view, actions: plan.actions })) <= 12 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(plan.build('c'.repeat(64)))) <= 20 * 1024);
  assert.ok(plan.actions.length <= 16);
});
