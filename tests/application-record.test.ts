import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ApplicationRecordRequest, Concept, GraphLink } from '../src/shared/types.ts';
import {
  APPLICATION_CONTENT_MAX_LENGTH,
  APPLICATION_TEXT_MAX_LENGTH,
  buildApplicationMaterial,
  buildApplicationRecordRequest,
  buildRelationSuggestion,
  createApplicationRecordDraft,
  createRelationSuggestionDraft,
  defaultApplicationMaterialFields,
  validateApplicationRecordRequest,
  type RelationSuggestionDraft,
} from '../src/web/application-record.ts';
import { ApplicationMaterialPreview, ApplicationRecordDialog } from '../src/web/ApplicationRecordDialog.tsx';

const concept: Concept = {
  id: 'math:boolean',
  title: '布尔逻辑',
  aliases: ['Boolean logic'],
  domain: 'Math',
  summary: '用真值与逻辑联结词表达规则。',
  body: '# 布尔逻辑',
  source: { path: 'Cognition/Math/Boolean.md', revision: 'revision-1' },
};

const counterpart: Concept = {
  ...concept,
  id: 'models:boolean',
  title: '布尔逻辑',
  domain: 'Model',
  source: { path: 'Cognition/Model/Boolean.md', revision: 'revision-other' },
};

const original: GraphLink = { id: 'original-edge', source: concept.id, target: counterpart.id, type: 'related', description: 'original relation text' };

function relationDraft(overrides: Partial<RelationSuggestionDraft> = {}): RelationSuggestionDraft {
  return {
    ...createRelationSuggestionDraft(), enabled: true, otherConceptId: counterpart.id,
    after: { type: 'applies-to', description: 'proposed relation text' }, ...overrides,
  };
}

function validRequest(overrides: Partial<ApplicationRecordRequest> = {}): ApplicationRecordRequest {
  return {
    eventId: 'application-1',
    conceptId: concept.id,
    sourceRevision: concept.source.revision,
    occurredAt: '2026-09-27T10:00:00.000Z',
    kind: 'application',
    context: '为 orchestrator 设计强规则校验。',
    content: '使用布尔逻辑拆分系统有关性与安全性条件。',
    outcome: 'unverified',
    assistance: 'unknown',
    result: '',
    limitations: '',
    insight: '',
    correction: '',
    references: '',
    ...overrides,
  };
}

test('application validation requires context and content while summary context is optional', () => {
  assert.equal(validateApplicationRecordRequest(validRequest()), null);
  assert.match(validateApplicationRecordRequest(validRequest({ context: '' })) ?? '', /应用场景/);
  assert.equal(validateApplicationRecordRequest(validRequest({ kind: 'summary', context: '' })), null);
  assert.match(validateApplicationRecordRequest(validRequest({ content: '   ' })) ?? '', /总结|解释/);
  assert.match(validateApplicationRecordRequest(validRequest({ content: 'x'.repeat(APPLICATION_CONTENT_MAX_LENGTH + 1) })) ?? '', /12000/);
  assert.match(validateApplicationRecordRequest(validRequest({ insight: 'x'.repeat(APPLICATION_TEXT_MAX_LENGTH + 1) })) ?? '', /4000/);
});

test('first request freezes the source identity and timestamps for retry', () => {
  const draft = createApplicationRecordDraft();
  draft.context = 'context';
  draft.content = 'content';
  const request = buildApplicationRecordRequest(concept, draft, '2026-09-27T10:00:00.000Z', 'event-fixed');
  assert.equal(request.eventId, 'event-fixed');
  assert.equal(request.occurredAt, '2026-09-27T10:00:00.000Z');
  assert.equal(request.sourceRevision, 'revision-1');
  assert.equal(Object.isFrozen(request), true);
  assert.throws(() => { (request as { content: string }).content = 'changed'; }, TypeError);
  const retry = request;
  assert.strictEqual(retry, request);
});

test('material defaults to insight, correction and references and excludes private business text', () => {
  const request = validRequest({
    context: 'secret customer data',
    content: 'private raw work response',
    result: 'private result',
    insight: '把规则拆成可组合的条件。',
    correction: '不能把规则校验误当作概率预测。',
    references: 'Boolean algebra notes',
  });
  assert.deepEqual(defaultApplicationMaterialFields(request), ['insight', 'correction', 'references']);
  const material = buildApplicationMaterial(concept, request, defaultApplicationMaterialFields(request));
  assert.match(material, /把规则拆成可组合的条件/);
  assert.doesNotMatch(material, /secret customer data|private raw work response|private result/);
  const explicit = buildApplicationMaterial(concept, request, ['content']);
  assert.match(explicit, /private raw work response/);
  assert.doesNotMatch(explicit, /secret customer data/);
  const code = buildApplicationMaterial(concept, { ...request, sourceRevision: 'older-revision', content: '    indented code\n    next line' }, ['content']);
  assert.match(code, /知识版本：older-revision/);
  assert.match(code, /\n    indented code\n    next line/);
});

test('dialog SSR renders the safety note and does not render private source body', () => {
  const html = renderToStaticMarkup(createElement(ApplicationRecordDialog, {
    concept,
    busy: false,
    onSave: async () => true,
    onClose: () => undefined,
  }));
  assert.match(html, /记录一次实际应用/);
  assert.match(html, /不会自动改变衰减状态/);
  assert.doesNotMatch(html, /# 布尔逻辑/);
});

test('material preview renders selected field controls and explicit Markdown preview', () => {
  const request = validRequest({ insight: '新的连接' });
  const html = renderToStaticMarkup(createElement(ApplicationMaterialPreview, { concept, record: request }));
  assert.match(html, /选择要交给 progressive-kg 整理的字段/);
  assert.match(html, /新的连接/);
  assert.match(html, /业务上下文和原始内容默认不选/);
});

test('relation drafts require a counterpart, type, and an exact directed original relation', () => {
  assert.equal(buildRelationSuggestion(concept, undefined, [], []), undefined);
  assert.equal(buildRelationSuggestion(concept, { ...relationDraft(), enabled: false }, [], []), undefined);
  assert.throws(() => buildRelationSuggestion(concept, relationDraft({ otherConceptId: '' }), [counterpart], []), /第二个概念/);
  assert.throws(() => buildRelationSuggestion(concept, relationDraft({ otherConceptId: concept.id }), [concept], []), /第二个概念/);
  assert.throws(() => buildRelationSuggestion(concept, relationDraft({ after: { type: '', description: '' } }), [counterpart], []), /type/);
  assert.throws(() => buildRelationSuggestion(concept, relationDraft({ operation: 'change' }), [counterpart], [original]), /原关系/);
  assert.throws(() => buildRelationSuggestion(concept, relationDraft({ operation: 'remove', before: { type: original.type, description: 'different description' } }), [counterpart], [original]), /原关系/);
  assert.throws(() => buildRelationSuggestion(concept, relationDraft({ operation: 'remove', direction: 'incoming', before: original }), [counterpart], [original]), /原关系/);
});

test('add/change/remove preserve direction and exact values without accepting existing after tuples', () => {
  const added = buildRelationSuggestion(concept, relationDraft({ direction: 'incoming' }), [counterpart], [original]);
  assert.ok(added);
  assert.equal(added.operation, 'add');
  assert.equal(added.source.conceptId, counterpart.id);
  assert.equal(added.target.conceptId, concept.id);
  const before = { type: original.type, description: original.description };
  const changed = buildRelationSuggestion(concept, relationDraft({ operation: 'change', before }), [counterpart], [original]);
  assert.ok(changed?.operation === 'change');
  assert.deepEqual(changed.before, before);
  assert.deepEqual(changed.after, relationDraft().after);
  assert.equal(Object.hasOwn(changed.before, 'id'), false);
  const removed = buildRelationSuggestion(concept, relationDraft({ operation: 'remove', before }), [counterpart], [original]);
  assert.ok(removed?.operation === 'remove');
  assert.deepEqual(removed.before, before);
  assert.equal(Object.hasOwn(removed, 'after'), false);
  assert.throws(() => buildRelationSuggestion(concept, relationDraft({ after: before }), [counterpart], [original]), /已有相同/);
  assert.throws(() => buildRelationSuggestion(concept, relationDraft({ operation: 'change', before, after: before }), [counterpart], [original]), /前后必须不同/);
  const existingAfter: GraphLink = { ...original, id: 'second-edge', ...relationDraft().after };
  assert.throws(() => buildRelationSuggestion(concept, relationDraft({ operation: 'change', before }), [counterpart], [original, existingAfter]), /已有相同/);
});

test('application request freezes independent nested relation snapshots and never synthesizes correction', () => {
  const current = structuredClone(concept);
  const other = structuredClone(counterpart);
  const before = { type: original.type, description: original.description };
  const draft = { ...createApplicationRecordDraft('summary'), content: 'A synthetic summary.', relationSuggestion: relationDraft({ operation: 'change', before }) };
  const request = buildApplicationRecordRequest(current, draft, '2026-09-27T10:00:00.000Z', 'relation-event', { concepts: [other], links: [original] });
  const suggestion = request.relationSuggestion;
  assert.ok(suggestion?.operation === 'change');
  for (const value of [request, suggestion, suggestion.source, suggestion.target, suggestion.before, suggestion.after]) assert.equal(Object.isFrozen(value), true);
  assert.notStrictEqual(suggestion.before, before);
  assert.notStrictEqual(suggestion.after, draft.relationSuggestion.after);
  draft.relationSuggestion.after.type = 'edited after first save';
  before.description = 'changed graph text';
  current.source.revision = 'new parent version';
  other.title = 'new counterpart title';
  other.source.path = 'new path';
  assert.equal(suggestion.source.sourceRevision, 'revision-1');
  assert.equal(suggestion.target.title, counterpart.title);
  assert.equal(suggestion.target.path, counterpart.source.path);
  assert.equal(suggestion.before.description, original.description);
  assert.equal(suggestion.after.type, 'applies-to');
  assert.equal(request.correction, '');
  assert.equal(validateApplicationRecordRequest(request), null);
  assert.throws(() => buildApplicationRecordRequest(concept, { ...draft, relationSuggestion: relationDraft({ otherConceptId: '' }) }), /第二个概念/);
  const disabled = buildApplicationRecordRequest(concept, { ...draft, relationSuggestion: { ...relationDraft(), enabled: false } });
  assert.equal(Object.hasOwn(disabled, 'relationSuggestion'), false);
});

test('relation material includes frozen before/after only when its independent field is selected', () => {
  const suggestion = buildRelationSuggestion(concept, relationDraft({ operation: 'change', before: { type: original.type, description: original.description } }), [counterpart], [original]);
  assert.ok(suggestion);
  const request = validRequest({ relationSuggestion: suggestion, insight: 'shareable insight', context: 'private context', content: 'private body', result: 'private result' });
  assert.deepEqual(defaultApplicationMaterialFields(request), ['insight', 'relationSuggestion']);
  const included = buildApplicationMaterial(concept, request, defaultApplicationMaterialFields(request));
  for (const text of [counterpart.id, counterpart.source.path, counterpart.source.revision, original.description, 'proposed relation text', '记录时快照，整理前核对当前知识源', '待核对建议，尚未验证采纳']) assert.ok(included.includes(text));
  assert.doesNotMatch(included, /private context|private body|private result/);
  const excluded = buildApplicationMaterial(concept, request, ['insight']);
  assert.doesNotMatch(excluded, /models:boolean|Cognition\/Model|revision-other|original relation text|proposed relation text|关系建议/);
  assert.equal(excluded, buildApplicationMaterial(concept, validRequest({ insight: 'shareable insight' }), ['insight']));
});

test('material without a relation retains the exact original Markdown format', () => {
  assert.equal(buildApplicationMaterial(concept, validRequest({ insight: 'One insight.' }), ['insight']), '# 布尔逻辑\n\n- 知识节点：math:boolean\n- 知识源：Cognition/Math/Boolean.md\n- 知识版本：revision-1\n- 记录类型：实际应用\n\n## 新的 insight\n\nOne insight.\n');
});
