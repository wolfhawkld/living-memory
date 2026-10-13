import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planFeishuReviewView as render, type FeishuReviewRenderInput } from '../src/server/feishu-review-view.js';
import type { FeishuReviewOperation, FeishuReviewSession } from '../src/shared/feishu-review.js';
import type { Concept } from '../src/shared/types.js';
import { cardButtons, cardElements } from './helpers/feishu-card-elements.js';

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
  const buttons = cardButtons(plan.build('c'.repeat(64)));
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
    const body = cardElements(card).find(element => element.tag === 'markdown' && element.text_size === 'normal' && element.text_align === 'left')!.content as string;
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

test('zero daily budget preserves current-item actions and recovery but hides entry to later batch items', () => {
  const value = batchInput(); value.dailyBudgetPaused = true;
  assert.deepEqual(verbs(value), ['reveal', 'pause', 'finish']);
  assert.match(wire(value), /日常复习已暂停.*当前条目仍可完成/);
  value.session!.state.phase = 'revealed';
  assert.ok(verbs(value).includes('rate-clear'));
  assert.ok(!verbs(value).includes('skip'));
  value.session!.state.phase = 'saved';
  value.operations = [batchOperation(value, 0, 'applied')];
  assert.deepEqual(verbs(value), ['confirm-review', 'pause', 'finish']);
  value.operations = [batchOperation(value, 0, 'pending')];
  assert.deepEqual(verbs(value), ['retry', 'pause']);
  value.session!.state.paused = true;
  assert.deepEqual(verbs(value), ['resume']);
  value.session!.state.paused = false;
  const batch = value.session!.state.batch!; batch.cursor = 2;
  value.session!.state.conceptId = batch.items[2].conceptId;
  value.session!.state.sourceRevision = batch.items[2].sourceRevision;
  value.operations = [batchOperation(value, 2, 'applied')];
  assert.deepEqual(verbs(value), ['confirm-review', 'next', 'finish']);
  assert.match(wire(value), /完成本轮/);
  const empty = input(); empty.dailyBudgetPaused = true;
  empty.session = null; empty.concept = null; empty.availability = 'no-candidate';
  assert.match(wire(empty), /每日复习预算为 0.*仍可浏览知识和主动学习/);
  empty.availability = 'no-session';
  assert.match(wire(empty), /每日复习预算为 0.*仍可浏览知识和主动学习/);
  assert.doesNotMatch(wire(empty), /发送.*开始/);
});

test('zero budget never promises completion of an invalid or conflicted current item', () => {
  for (const availability of ['expired', 'source-changed', 'ineligible'] as const) {
    const value = batchInput(); value.dailyBudgetPaused = true; value.availability = availability;
    assert.doesNotMatch(wire(value), /当前条目仍可完成/);
    assert.match(wire(value), /原进度和已保存记录保留/);
    assert.ok(!verbs(value).includes('skip'));
    if (availability === 'ineligible') assert.ok(verbs(value).includes('pause'));
  }
  const value = batchInput(); value.dailyBudgetPaused = true;
  value.operations = [batchOperation(value, 0, 'conflict')];
  assert.doesNotMatch(wire(value), /当前条目仍可完成/);
  assert.deepEqual(verbs(value), ['finish']);
});

test('batch fronts show fixed progress with explicit skipping and saved items offer independent next and rewarm', () => {
  const value = batchInput();
  assert.match(wire(value), /第 1\/3 项/); assert.ok(verbs(value).includes('skip'));
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


test('review cards show step and actual queue progress with equal self-report buttons', () => {
  const value = batchInput(5); value.session!.state.batch!.items.splice(3);
  const front = render(value).build('c'.repeat(64));
  assert.match(JSON.stringify(front.header), /先回忆/);
  assert.match(JSON.stringify(front.header), /第 1\/3 项/);
  assert.equal((front.header as { template: string }).template, 'turquoise');
  const frontButtons = cardButtons(front);
  assert.equal(frontButtons.find(button => button.text.content === '查看资料')!.type, 'primary_filled');
  assert.equal(frontButtons.filter(button => button.type === 'primary_filled').length, 1);
  value.session!.state.phase = 'revealed';
  const revealed = render(value).build('c'.repeat(64));
  const ratings = cardButtons(revealed).filter(button => ['清楚', '模糊', '想不起'].includes(button.text.content));
  assert.deepEqual(ratings.map(button => button.text.content), ['清楚', '模糊', '想不起']);
  assert.deepEqual(ratings.map(button => button.type), ['default', 'default', 'default']);
  const columns = cardElements(revealed).find(element => element.tag === 'column_set' && JSON.stringify(element).includes('清楚'));
  assert.ok(columns); assert.equal(columns.columns.length, 3);
  assert.equal(new Set(columns.columns.map((column: Record<string, unknown>) => JSON.stringify([column.width, column.weight]))).size, 1);
  assert.match(JSON.stringify(revealed), /对照下方资料后，评价打开资料前的脑中回忆/);
  assert.equal(cardButtons(revealed).some(button => button.type === 'primary_filled'), false);
  value.session!.state.phase = 'saved'; value.operations = [batchOperation(value, 0, 'applied')];
  const saved = render(value).build('c'.repeat(64));
  assert.equal((saved.header as { template: string }).template, 'turquoise');
  assert.ok(cardButtons(saved).some(button => button.text.content === '确认已重温，更新时间'));
  assert.ok(cardButtons(saved).some(button => button.text.content === '下一条'));
  const savedElements = (saved.body as { elements: Record<string, any>[] }).elements;
  const confirmation = savedElements.find(element => element.tag === 'button' && element.text.content === '确认已重温，更新时间');
  assert.ok(confirmation, 'explicit rewarm confirmation occupies its own top-level row');
  assert.equal(cardButtons({ ...saved, body: { elements: [confirmation] } }).length, 1);
  assert.ok(savedElements.some(element => element !== confirmation && JSON.stringify(element).includes('下一条')));
  value.session!.state.phase = 'finished';
  assert.equal((render(value).build('c'.repeat(64)).header as { template: string }).template, 'turquoise');
});

test('review visual tones identify pending, unavailable, paused and conflict without success inference', () => {
  const cases: [FeishuReviewRenderInput, string][] = [];
  const pending = input(); pending.operations = [operation('pending')]; cases.push([pending, 'orange']);
  const conflict = input(); conflict.operations = [operation('conflict')]; cases.push([conflict, 'red']);
  const paused = input(); paused.session!.state.paused = true; cases.push([paused, 'grey']);
  for (const availability of ['source-changed', 'ineligible', 'expired'] as const) {
    const value = input(); value.availability = availability;
    cases.push([value, availability === 'expired' ? 'grey' : 'orange']);
  }
  for (const [value, expected] of cases) {
    const card = render(value).build('c'.repeat(64));
    assert.equal((card.header as { template: string }).template, expected);
    assert.doesNotMatch(JSON.stringify(card), /BODY_SECRET|SUMMARY_SECRET/);
    assert.match(JSON.stringify(card), /仅最新卡可操作/);
  }
});


test('an earlier batch conflict colors the finished summary red but never the active last item', () => {
  const value = batchInput(); const batch = value.session!.state.batch!;
  batch.cursor = batch.items.length - 1;
  value.session!.state.conceptId = batch.items[batch.cursor].conceptId;
  value.session!.state.sourceRevision = batch.items[batch.cursor].sourceRevision;
  value.session!.state.phase = 'revealed';
  value.operations = [batchOperation(value, 0, 'conflict')];
  const active = render(value).build('c'.repeat(64));
  assert.equal((active.header as { template: string }).template, 'turquoise');
  assert.ok(verbs(value).includes('rate-clear'));
  assert.match(JSON.stringify(active), /BODY_SECRET/);
  assert.doesNotMatch(JSON.stringify(active), /写入冲突/);
  value.operations.push(batchOperation(value, batch.cursor, 'applied'));
  value.session!.state.phase = 'finished';
  const finished = render(value).build('c'.repeat(64));
  assert.equal((finished.header as { template: string }).template, 'red');
  assert.deepEqual(verbs(value), []);
  assert.match(JSON.stringify(finished), /脑中自评未保存\(冲突\) 1 项/);
  assert.doesNotMatch(JSON.stringify(finished), /BODY_SECRET/);
});


test('minimal learning layout centers the concept and puts equal reports before complete source with original callback IDs', () => {
  const value = batchInput();
  value.concept = { ...concept, body: 'complete original source '.repeat(300) };
  const front = render(value).build('c'.repeat(64));
  assert.equal((front.header as { title: { content: string } }).title.content, '先回忆');
  const heading = cardElements(front).find(element => element.tag === 'markdown' && element.text_size === 'heading-1');
  assert.ok(heading); assert.equal(heading.text_align, 'center');
  assert.equal(cardElements(front).filter(element => element.tag === 'markdown' && element.content === heading.content).length, 1);
  assert.match(JSON.stringify(front), /想想它的原理，以及会用在哪个场景/);
  assert.doesNotMatch(JSON.stringify(front), /complete original source/);
  value.session!.state.phase = 'revealed'; value.session!.state.page = 2;
  const plan = render(value); const revealed = plan.build('c'.repeat(64)); const elements = cardElements(revealed);
  const headingIndex = elements.findIndex(element => element.tag === 'markdown' && element.text_size === 'heading-2');
  const guideIndex = elements.findIndex(element => element.tag === 'markdown' && element.content === '对照下方资料后，评价打开资料前的脑中回忆');
  const firstRatingIndex = elements.findIndex(element => element.tag === 'button' && element.text.content === '清楚');
  const pageIndex = elements.findIndex(element => element.tag === 'markdown' && /^资料 2\//.test(element.content));
  const sourceIndex = elements.findIndex(element => element.tag === 'markdown' && element.text_size === 'normal' && element.text_align === 'left');
  assert.ok(headingIndex < guideIndex && guideIndex < firstRatingIndex && firstRatingIndex < pageIndex && pageIndex < sourceIndex);
  assert.equal(elements[headingIndex].text_align, 'center');
  const actionById = new Map(plan.actions.map(action => [action.id, action.target]));
  const captionVerb = new Map([['清楚', 'rate-clear'], ['模糊', 'rate-partial'], ['想不起', 'rate-blank'], ['上一页', 'show'], ['下一页', 'show'], ['暂停复习', 'pause'], ['结束复习', 'finish'], ['跳过本条', 'skip']]);
  for (const button of cardButtons(revealed)) {
    const callback = button.behaviors[0].value;
    assert.equal(callback.kind, 'lm.nav.v1'); assert.equal(callback.cardId, 'c'.repeat(64));
    const target = actionById.get(callback.actionId);
    assert.ok(target && target.kind === 'review');
    assert.equal(target.verb, captionVerb.get(button.text.content));
    if (button.text.content === '上一页') assert.equal(target.page, 1);
    if (button.text.content === '下一页') assert.equal(target.page, 3);
  }
  // Original controls put page navigation first, even though ratings are displayed first.
  assert.equal(plan.actions[0].target.kind === 'review' && plan.actions[0].target.verb, 'show');
  assert.equal(cardButtons(revealed)[0].text.content, '清楚');
  assert.notEqual(cardButtons(revealed)[0].behaviors[0].value.actionId, plan.actions[0].id);
  const progress = cardElements(revealed).filter(element => element.tag === 'markdown' && /第 1\/3 项/.test(element.content));
  assert.equal(progress.length, 0);
  const queueNote = elements.find(element => element.tag === 'markdown' && element.content.includes('队列固定'));
  assert.equal(queueNote!.text_size, 'notation');
});
