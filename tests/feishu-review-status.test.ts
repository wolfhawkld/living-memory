import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderFeishuReviewStatus as render, type FeishuReviewStatusInput, type FeishuReviewStatusOperation } from '../src/server/feishu-review-status.js';

const asOf = '2026-11-05T10:00:00.000Z';
function input(): FeishuReviewStatusInput {
  return {
    asOf, sourceMatches: true, conceptTitle: '当前概念短名', operations: [],
    session: { expiresAt: '2026-11-06T10:00:00.000Z', state: {
      domainId: 'private-domain', conceptId: 'private-concept', sourceRevision: 'private-revision',
      phase: 'front', paused: false, page: 1, frozen: null,
    } },
  };
}
function batch(size: 3 | 5, cursor: number): FeishuReviewStatusInput {
  const value = input();
  value.session!.state.batch = { requestedSize: size, cursor, items: Array.from({ length: size }, (_, index) => ({
    id: `private-item-${index}`, conceptId: `future-private-concept-${index}`,
    sourceRevision: `private-revision-${index}`, frozen: null, disposition: 'open',
  })) };
  return value;
}
function bounded(text: string): void {
  assert.ok(Buffer.byteLength(text, 'utf8') <= 8 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify({ text }), 'utf8') <= 11 * 1024);
}

test('single-item phases distinguish recall, comparison and self-rating receipt', () => {
  for (const [phase, label] of [['front', '待回忆'], ['revealed', '资料对照阶段'], ['saved', '自评回执']] as const) {
    const value = input(); value.session!.state.phase = phase;
    const text = render(value);
    assert.match(text, /查询时点：2026-11-05T10:00:00.000Z/);
    assert.match(text, /会话时间与资料：有效/);
    assert.match(text, /复习状态：进行中/);
    assert.ok(text.includes(`阶段：${label}`));
    assert.match(text, /第 1\/1 项/);
    assert.match(text, /本轮脑中自评：已保存 0；待确认 0；冲突 0/);
    assert.match(text, /本轮明确重温：已保存 0；待确认 0；冲突 0/);
    assert.match(text, /“知识 继续复习”或“知识 结束复习”/);
    assert.doesNotMatch(text, /阶段：已阅读|已掌握。|已重温。/);
    bounded(text);
  }
});

test('three-item and five-item batches use the current cursor without exposing future items', () => {
  for (const size of [3, 5] as const) for (let cursor = 0; cursor < size; cursor++) {
    const text = render(batch(size, cursor));
    assert.ok(text.includes(`第 ${cursor + 1}/${size} 项`));
    assert.doesNotMatch(text, /private|future|revision/);
  }
});

test('paused session preserves pending and applied facts and states recovery without retrying', () => {
  const value = input(); value.session!.state.paused = true;
  value.operations = [{ kind: 'observation', status: 'applied' }, { kind: 'review', status: 'pending' }];
  const text = render(value);
  assert.match(text, /复习状态：已暂停/);
  assert.match(text, /本轮脑中自评：已保存 1；待确认 0；冲突 0/);
  assert.match(text, /本轮明确重温：已保存 0；待确认 1；冲突 0/);
  assert.match(text, /继续复习会尝试恢复原待写操作；本次查询不会重试/);
  assert.match(text, /脑中自评已保存不表示已重温或已掌握/);
});

test('expired and changed source are independent of all six mixed status counts', () => {
  const value = batch(5, 2);
  value.session!.expiresAt = asOf; value.sourceMatches = false;
  const operations: FeishuReviewStatusOperation[] = [];
  for (const [kind, counts] of [['observation', [1, 2, 3]], ['review', [4, 5, 6]]] as const) {
    for (const [index, status] of (['applied', 'pending', 'conflict'] as const).entries()) {
      operations.push(...Array.from({ length: counts[index] }, () => ({ kind, status })));
    }
  }
  value.operations = operations;
  const text = render(value);
  assert.match(text, /会话时间与资料：已过期；资料已变化/);
  assert.match(text, /本轮脑中自评：已保存 1；待确认 2；冲突 3/);
  assert.match(text, /本轮明确重温：已保存 4；待确认 5；冲突 6/);
  assert.match(text, /本次查询不会重试/);
  assert.match(text, /会话当前不可正常继续/);
  assert.match(text, /“知识 结束复习”/);
  assert.doesNotMatch(text, /可发送“知识 继续复习”|当前概念/);
});

test('unavailable source and expiration separately never promise normal continuation', () => {
  for (const change of ['source', 'expiry']) {
    const value = input();
    if (change === 'source') value.sourceMatches = false;
    else value.session!.expiresAt = '2026-11-04T10:00:00.000Z';
    const text = render(value);
    assert.match(text, change === 'source' ? /资料已变化/ : /已过期/);
    assert.doesNotMatch(text, /可发送“知识 继续复习”/);
  }
});

test('absent and finished sessions explain the limit without inventing historical summaries', () => {
  for (const finished of [false, true]) {
    const value = input();
    if (finished) value.session!.state.phase = 'finished'; else value.session = null;
    value.operations = [{ kind: 'review', status: 'applied' }];
    const text = render(value);
    assert.match(text, /当前没有未结束的复习会话；这不表示没有已保存记录/);
    assert.doesNotMatch(text, /本轮|当前概念|小结|第 1|已保存 1/);
    bounded(text);
  }
});

test('only the short current title is projected; body, answers, IDs and URLs never escape', () => {
  const value = batch(3, 0);
  Object.assign(value.session!, { id: 'private-session', actor: { openId: 'private-actor' } });
  Object.assign(value.session!.state, { body: 'secret-body', answer: 'secret-answer' });
  value.operations = [Object.assign({ kind: 'observation' as const, status: 'applied' as const }, {
    id: 'private-operation', intent: { request: { answer: 'secret-intent-answer' } },
  })];
  value.conceptTitle = '<at>名字</at>';
  const text = render(value);
  assert.match(text, /＜at＞名字＜\/at＞/);
  assert.doesNotMatch(text, /<|>|https:|private\.example|secret|private-session|private-actor|private-operation|private-concept|future-private/);
  for (const title of ['名字 https://private.example/secret', 'www.private.example 名字']) {
    value.conceptTitle = title;
    assert.doesNotMatch(render(value), /当前概念|名字|private\.example/);
  }
  value.conceptTitle = '名字';
  value.sourceMatches = false;
  assert.doesNotMatch(render(value), /private-tag|名字|当前概念/);
});

test('Unicode, lone surrogates, controls and JSON-heavy titles stay bounded and inert', () => {
  for (const title of ['😀汉字'.repeat(10000), '\u0000\u0001\r\n\t\u202e\u2066'.repeat(10000), '\\"'.repeat(10000), '\ud800'.repeat(10000)]) {
    const value = input(); value.conceptTitle = title;
    const text = render(value);
    bounded(text);
    assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f\u202e\u2066\ud800]/u);
    const line = text.split('\n').find(line => line.startsWith('当前概念：'));
    if (line) assert.ok(Buffer.byteLength(line.slice('当前概念：'.length), 'utf8') <= 200);
  }
});

test('malformed state, clocks and operations receive a fixed conservative explanation', () => {
  const cases: unknown[] = [null, {}, { ...input(), session: undefined }, { ...input(), sourceMatches: 'yes' }];
  for (const date of ['', 'tomorrow', '2026-02-30T10:00:00.000Z', '2026-11-05T25:00:00Z']) {
    cases.push({ ...input(), asOf: date });
    const value = input(); value.session!.expiresAt = date; cases.push(value);
  }
  for (const cursor of [-1, 1.5, 3]) { const value = batch(3, 0); value.session!.state.batch!.cursor = cursor; cases.push(value); }
  const phase = input(); Object.assign(phase.session!.state, { phase: 'unknown' }); cases.push(phase);
  cases.push({ ...input(), operations: [{ kind: 'observation', status: 'unknown' }] });
  cases.push({ ...input(), operations: [{ kind: '__proto__', status: 'applied' }] });
  for (const value of cases) {
    const text = render(value as FeishuReviewStatusInput);
    assert.match(text, /^复习状态暂无法确认：/);
    assert.doesNotMatch(text, /会话时间与资料：有效|继续复习/);
    bounded(text);
  }
});

test('rendering leaves all inputs, operation counts and expiration unchanged', () => {
  const value = batch(5, 1);
  value.operations = [{ kind: 'observation', status: 'pending' }, { kind: 'review', status: 'conflict' }];
  const before = structuredClone(value);
  Object.freeze(value.operations[0]); Object.freeze(value.operations);
  Object.freeze(value.session!.state.batch!.items); Object.freeze(value.session!.state.batch);
  Object.freeze(value.session!.state); Object.freeze(value.session); Object.freeze(value);
  assert.equal(render(value), render(value));
  assert.deepEqual(value, before);
});
