import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectFeishuReviewCandidates as select } from '../src/server/feishu-card-view.js';
import { planFeishuCardView as render, type FeishuCardViewPlan } from '../src/server/feishu-card-view.js';
import { createHash } from 'node:crypto';
import type { FeishuCardView } from '../src/shared/feishu-cards.js';
import type { FeishuReadContext } from '../src/server/feishu-read-view.js';
import type { Concept, MemoryState, Snapshot } from '../src/shared/types.js';
import type { ReviewPlanResponse } from '../src/shared/review-plan.js';

const asOf = '2026-10-02T10:00:00.000Z';
function node(id: string, domain = 'Math'): Concept {
  return { id, title: id, aliases: [], domain: 'ignored', summary: '', body: '', source: { path: `${domain}/${id}.md`, revision: `rev-${id}` } };
}
function state(concept: Concept, days = 20): MemoryState {
  return { conceptId: concept.id, status: 'stale', decay: 0.1, elapsedDays: days, reason: null, asOf,
    anchor: { eventId: `anchor-${concept.id}`, conceptId: concept.id, sourceRevision: concept.source.revision,
      occurredAt: '2026-09-01T00:00:00.000Z', recordedAt: '2026-09-01T00:00:00.000Z', kind: 'review' } };
}
function snapshot(concepts: Concept[]): Snapshot {
  return { concepts, links: [], source: { name: 'synthetic-full-index', mode: 'demo', limit: 1, conceptCount: concepts.length, diagnostics: [] },
    config: { modelVersion: 'time-only-v0', revision: 1, halfLifeDays: 7 }, observationsCount: 0, asOf,
    states: Object.fromEntries(concepts.map((concept) => [concept.id, state(concept)])) };
}
function plan(): ReviewPlanResponse {
  return { sourceId: 'synthetic-account', asOf, timeZone: 'Asia/Hong_Kong', dayKey: '2026-10-02',
    plan: { revision: 1, dailyBudget: 5, concepts: {} }, completedConceptIds: [] };
}

test('full-index global selection merges focus and elapsed ordering without assigning budgets to domains', () => {
  const math = Array.from({ length: 7 }, (_, index) => node(`math-${index}`));
  const ai = node('ai-focused', 'AI');
  const input = snapshot([...math, ai]);
  math.forEach((concept, index) => { input.states[concept.id].elapsedDays = 30 + index; });
  input.states[ai.id].elapsedDays = 7;
  const preferences = plan(); preferences.plan.concepts[ai.id] = { focus: true, deferUntil: null };
  assert.deepEqual(select(input, preferences, null, 5).candidates.map((candidate) => candidate.conceptId),
    ['ai-focused', 'math-6', 'math-5', 'math-4', 'math-3']);
  assert.deepEqual(select(input, preferences, 'Math', 5).candidates.map((candidate) => candidate.conceptId),
    ['math-6', 'math-5', 'math-4', 'math-3', 'math-2']);
  assert.equal(input.source.limit, 1);
});

test('daily progress is globally deduplicated and budgets are not reserved when candidates are viewed', () => {
  const input = snapshot(Array.from({ length: 7 }, (_, index) => node(`node-${index}`)));
  const progress = plan(); progress.completedConceptIds = ['node-0', 'node-0', 'outside-this-domain', 'removed-node'];
  const before = structuredClone({ input, progress });
  const result = select(input, progress, 'Math', 5);
  assert.equal(result.completedCount, 3);
  assert.equal(result.remaining, 2);
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every((candidate) => candidate.conceptId !== 'node-0'));
  assert.equal(result.timeZone, progress.timeZone);
  assert.equal(result.dayKey, progress.dayKey);
  assert.deepEqual(select(input, progress, 'Math', 5), result);
  assert.deepEqual({ input, progress }, before);
  progress.plan.dailyBudget = 2;
  assert.deepEqual(select(input, progress, null, 5), { candidates: [], completedCount: 3, remaining: 0, timeZone: progress.timeZone, dayKey: progress.dayKey });
});

test('requested three/five caps and stable binary IDs apply to globally tied candidates', () => {
  const input = snapshot(['z', 'a', 'Z', 'A', 'm', 'q'].map((id, index) => node(id, index % 2 ? 'AI' : 'Math')));
  assert.deepEqual(select(input, plan(), null, 3).candidates.map((candidate) => candidate.conceptId), ['A', 'Z', 'a']);
  assert.deepEqual(select(input, plan(), null, 5).candidates.map((candidate) => candidate.conceptId), ['A', 'Z', 'a', 'm', 'q']);
  input.concepts.push(input.concepts[0]);
  assert.equal(new Set(select(input, plan(), null, 5).candidates.map((candidate) => candidate.conceptId)).size, 5);
});

test('core eligibility preserves versions, retention, unknown/recent/pending states and estimates', () => {
  const names = ['valid', 'estimated', 'unknown', 'recent', 'pending', 'retained', 'old-version', 'deferred', 'invalid-time'];
  const input = snapshot(names.map((id) => node(id)));
  const progress = plan();
  input.states.estimated.anchor!.kind = 'estimated';
  input.states.unknown = { ...input.states.unknown, status: 'unknown', anchor: null, elapsedDays: null, decay: null };
  input.states.recent.status = 'recent';
  input.states.pending.status = 'pending';
  input.states.retained.retention = { eventId: 'retention', conceptId: 'retained', sourceRevision: 'rev-retained',
    occurredAt: asOf, recordedAt: asOf, active: true, previousEventId: null };
  input.states['old-version'].anchor!.sourceRevision = 'old';
  input.states['invalid-time'].elapsedDays = Infinity;
  progress.plan.concepts.deferred = { focus: true, deferUntil: '2026-10-03T00:00:00.000Z' };
  input.asOf = '2026-10-04T00:00:00.000Z';
  const result = select(input, progress, null, 5);
  assert.deepEqual(result.candidates.map((candidate) => candidate.conceptId), ['estimated', 'valid']);
  assert.equal(result.candidates[0].estimated, true);
  assert.equal(result.candidates[1].estimated, false);
});

test('the already-filtered completed input governs counting rather than scenario or browser-local state', () => {
  const input = snapshot([node('concept-observed'), node('scenario-observed'), node('browser-visited')]);
  const progress = plan();
  // API input contains accepted concept recalls only. Scenario/browser exposure
  // are not inferred or invented by this pure selector.
  progress.completedConceptIds = ['concept-observed'];
  const result = select(input, progress, null, 3);
  assert.equal(result.completedCount, 1);
  assert.deepEqual(result.candidates.map((candidate) => candidate.conceptId), ['browser-visited', 'scenario-observed']);
});

const listView = { kind: 'list', domainId: null, query: '', sort: 'elapsed', page: 1 } as const;
function readContext(input: Snapshot): FeishuReadContext { return { concepts: input.concepts, states: input.states, anchors: [], asOf: input.asOf }; }
function sha(value: string) { return createHash('sha256').update(value).digest('hex'); }
function card(plan: FeishuCardViewPlan) { return plan.build('synthetic-card-id'); }
function text(plan: FeishuCardViewPlan): string { return JSON.stringify(card(plan)); }
function next(plan: FeishuCardViewPlan, kind: FeishuCardView['kind'], page: number): FeishuCardView {
  const action = plan.actions.find((action) => action.target.kind === kind && 'page' in action.target && action.target.page === page);
  assert.ok(action); return action.target;
}
function checkBudgets(view: FeishuCardView, rendered: FeishuCardViewPlan) {
  const payload = card(rendered);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 20 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify({ content: JSON.stringify(payload) })) <= 23 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify({ view, actions: rendered.actions })) <= 12 * 1024);
  assert.ok(rendered.actions.length <= 16);
}

test('V2 cards use callback behaviors with only opaque navigation identifiers and forwarding disabled', () => {
  const rendered = render(listView, readContext(snapshot([node('own')])), plan());
  const payload = card(rendered);
  assert.equal(payload.schema, '2.0');
  assert.deepEqual(payload.config, { update_multi: true, enable_forward: false });
  const header = payload.header as { title: { tag: string } }; assert.equal(header.title.tag, 'plain_text');
  const elements = (payload.body as { elements: Record<string, unknown>[] }).elements;
  const buttons = elements.filter((element) => element.tag === 'button');
  assert.equal(buttons.length, rendered.actions.length);
  buttons.forEach((button, index) => {
    assert.equal(button.value, undefined);
    assert.deepEqual(button.behaviors, [{ type: 'callback', value: { kind: 'lm.nav.v1', cardId: 'synthetic-card-id', actionId: `a${index}` } }]);
    assert.match(rendered.actions[index].id, /^a(?:[0-9]|1[0-5])$/);
    assert.deepEqual(Object.keys(rendered.actions[index]).sort(), ['id', 'target']);
  });
  assert.doesNotMatch(JSON.stringify(buttons), /account|userId|openId|tenantKey|sourceRevision|domainId|query/);
  assert.match(text(rendered), /只有最新卡可操作/);
  assert.match(text(rendered), /不扣复习预算/);
});

test('list/read navigation restores the complete original filters, sort and page', () => {
  const input = snapshot(Array.from({ length: 12 }, (_, index) => {
    const concept = node(`own-${index}`, 'AI models'); concept.aliases = ['agent']; return concept;
  }));
  const context = readContext(input);
  const view = { ...listView, domainId: 'AI models', query: 'agent', sort: 'title', page: 2 } as const;
  const rendered = render(view, context, plan());
  assert.equal(rendered.actions.filter((action) => action.target.kind === 'read').length, 5);
  assert.deepEqual(next(rendered, 'list', 3), { ...view, page: 3 });
  const read = rendered.actions.find((action) => action.target.kind === 'read')!.target;
  assert.equal(read.kind, 'read');
  const opened = render(read, context, plan());
  assert.ok(opened.actions.some((action) => JSON.stringify(action.target) === JSON.stringify(view)));
  const toggle = rendered.actions.find((action) => action.target.kind === 'list' && action.target.sort === 'elapsed' && action.target.domainId === view.domainId)!;
  assert.deepEqual(toggle.target, { ...view, sort: 'elapsed', page: 1 });
  assert.deepEqual(next(rendered, 'list', 1), { ...view, page: 1 });
});

test('due fronts contain names and time hints without summary/body answers and preserve their back view', () => {
  const concept = node('private-concept'); concept.summary = 'SUMMARY_ANSWER_SECRET'; concept.body = 'BODY_ANSWER_SECRET';
  const context = readContext(snapshot([concept]));
  context.states[concept.id].anchor!.kind = 'estimated';
  const view = { kind: 'due', domainId: 'Math', limit: 3 } as const;
  const rendered = render(view, context, plan());
  const contents = text(rendered);
  assert.match(contents, /private-concept/); assert.match(contents, /估算锚点/);
  assert.doesNotMatch(contents, /SUMMARY_ANSWER_SECRET|BODY_ANSWER_SECRET/);
  assert.match(contents, /Asia\/Hong_Kong/); assert.match(contents, /2026-10-02/);
  assert.match(contents, /浏览器待同步/);
  const read = rendered.actions.find((action) => action.target.kind === 'read')!.target;
  assert.ok(render(read, context, plan()).actions.some((action) => JSON.stringify(action.target) === JSON.stringify(view)));
  assert.ok(rendered.actions.some((action) => action.target.kind === 'due' && action.target.limit === 5));
});

test('safe card Markdown fully paginates Unicode and inert attachments without sending active at or link markup', () => {
  const concept = node('unicode-card');
  concept.title = '<at user_id="all">' + '名😀'.repeat(300);
  concept.body = '# 标题\n' + ('中文😀e\u0301 <at id=all> [危险](javascript:alert) ![图](file://private)\n```mermaid\na-->b\n```\n').repeat(220);
  const context = readContext(snapshot([concept]));
  const before = JSON.stringify(context);
  let view: FeishuCardView = { kind: 'read', reference: sha(concept.id).slice(0, 12), page: 1, revision: sha(concept.source.revision).slice(0, 12), back: listView };
  let joined = ''; let pages = 0;
  while (view.kind === 'read') {
    const rendered = render(view, context, plan()); checkBudgets(view, rendered);
    const payload = card(rendered);
    const elements = (payload.body as { elements: { tag: string; content?: string }[] }).elements;
    const body = elements[1].content!;
    assert.ok(Buffer.byteLength(body) <= 3000);
    assert.doesNotMatch(body, /<at|\[危险\]|!\[图\]/);
    joined += body; pages++;
    const nextAction = rendered.actions.find((action) => action.target.kind === 'read' && action.target.page === (view as { page: number }).page + 1);
    if (!nextAction) break;
    view = nextAction.target;
  }
  assert.ok(pages > 2);
  assert.equal(joined, concept.body.replaceAll('<', '＜').replaceAll('>', '＞').replaceAll('[', '［').replaceAll(']', '］'));
  assert.equal(JSON.stringify(context), before);
});

test('digest failures, source revision changes and out-of-range pages return safe navigation errors', () => {
  const concept = node('versions'); const context = readContext(snapshot([concept]));
  const valid = { kind: 'read', reference: sha(concept.id).slice(0, 12), revision: sha(concept.source.revision).slice(0, 12), page: 1, back: listView } as const;
  for (const reference of ['', 'ABCDEF012345', 'a'.repeat(65)]) assert.match(text(render({ ...valid, reference }, context, plan())), /失效/);
  assert.match(text(render({ ...valid, reference: sha('other-private').slice(0, 12) }, context, plan())), /不存在或不唯一/);
  assert.match(text(render(valid, { ...context, concepts: [concept, concept] }, plan())), /不存在或不唯一/);
  concept.source.revision = 'changed'; assert.match(text(render(valid, context, plan())), /资料已变化/);
  assert.match(text(render({ ...listView, page: 100000 }, context, plan())), /超出范围/);
  assert.match(text(render({ ...listView, page: 1.5 }, context, plan())), /超出范围/);
});

test('adaptive collection pages preserve maximum domain/query targets within persisted and payload budgets', () => {
  const domain = '中'.repeat(512); const query = '概'.repeat(120);
  const input = snapshot(Array.from({ length: 16 }, (_, index) => {
    const concept = node(`long-${String(index).padStart(2, '0')}`, domain);
    concept.title = '"\\'.repeat(300); concept.aliases = [query]; return concept;
  }));
  const context = readContext(input);
  let view: FeishuCardView = { ...listView, domainId: domain, query };
  const seen = new Set<string>();
  while (view.kind === 'list') {
    const rendered = render(view, context, plan()); checkBudgets(view, rendered);
    const reads = rendered.actions.filter((action) => action.target.kind === 'read');
    assert.ok(reads.length > 0 && reads.length <= 5);
    for (const action of reads) {
      if (action.target.kind === 'read') {
        seen.add(action.target.reference);
        assert.deepEqual(action.target.back, view);
      }
    }
    const nextAction = rendered.actions.find((action) => action.target.kind === 'list' && action.target.page === (view as { page: number }).page + 1);
    if (!nextAction) break; view = nextAction.target;
  }
  assert.equal(seen.size, input.concepts.length);
});

test('long-domain card navigation retains complete targets and supported domains remain selectable', () => {
  const concepts = Array.from({ length: 11 }, (_, index) => node(`domain-${index}`, `${'中'.repeat(509)}${String(index).padStart(3, '0')}`));
  const context = readContext(snapshot(concepts));
  const seen = new Set<string>(); let view: FeishuCardView = { kind: 'domains', page: 1 };
  while (view.kind === 'domains') {
    const rendered = render(view, context, plan()); checkBudgets(view, rendered);
    for (const action of rendered.actions) if (action.target.kind === 'list' && action.target.domainId !== null) {
      seen.add(action.target.domainId);
      assert.match(text(render(action.target, context, plan())), /1 个节点/);
    }
    const nextAction = rendered.actions.find((action) => action.target.kind === 'domains' && action.target.page === (view as { page: number }).page + 1);
    if (!nextAction) break; view = nextAction.target;
  }
  assert.equal(seen.size, concepts.length);
});

test('empty budgets and unsupported source domains offer explicit safe navigation rather than blank cards', () => {
  const concept = node('overlong', 'x'.repeat(513)); const context = readContext(snapshot([concept]));
  assert.match(text(render({ kind: 'domains', page: 1 }, context, plan())), /超过 512 字元/);
  const progress = plan(); progress.completedConceptIds = ['a', 'b', 'c', 'd', 'e'];
  const rendered = render({ kind: 'due', domainId: null, limit: 3 }, context, progress);
  assert.match(text(rendered), /当前没有可用候选/);
  assert.equal(rendered.actions.filter((action) => action.target.kind === 'read').length, 0);
});

test('control-heavy body pages and maximum back filters satisfy final card budgets with no lost content', () => {
  const domain = '中'.repeat(512); const query = '概'.repeat(120);
  const concept = node('control-body', domain);
  concept.title = '"\\'.repeat(500); concept.body = '"\\\n\t\r\b\f'.repeat(1600);
  const context = readContext(snapshot([concept]));
  const back = { ...listView, domainId: domain, query };
  let view: FeishuCardView = { kind: 'read', reference: sha(concept.id).slice(0, 12), revision: sha(concept.source.revision).slice(0, 12), page: 1, back };
  let joined = '';
  while (view.kind === 'read') {
    const rendered = render(view, context, plan()); checkBudgets(view, rendered);
    const payload = card(rendered);
    const body = (payload.body as { elements: { content?: string }[] }).elements[1].content!;
    assert.ok(Buffer.byteLength(body) <= 3000); joined += body;
    assert.ok(rendered.actions.some((action) => JSON.stringify(action.target) === JSON.stringify(back)));
    const nextAction = rendered.actions.find((action) => action.target.kind === 'read' && action.target.page === (view as { page: number }).page + 1);
    if (!nextAction) break; view = nextAction.target;
  }
  assert.equal(joined, concept.body);
});
