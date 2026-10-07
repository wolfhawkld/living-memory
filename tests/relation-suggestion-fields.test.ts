import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Concept, GraphLink, RelationSuggestion } from '../src/shared/types.js';
import { RelationSuggestionFields } from '../src/web/RelationSuggestionFields.js';
import { RelationSuggestionPreview } from '../src/web/RelationSuggestionPreview.js';
import { ApplicationMaterialPreview, ApplicationRecordDialog } from '../src/web/ApplicationRecordDialog.js';
import { buildApplicationRecordRequest, buildRelationSuggestion, createApplicationRecordDraft, createRelationSuggestionDraft } from '../src/web/application-record.js';
import type { RelationSuggestionDraft } from '../src/web/application-record.js';

const concept: Concept = { id: 'synthetic-owner', title: '同名概念', domain: 'Math', aliases: [], summary: '', body: '', source: { path: 'Cognition/Math/owner.md', revision: 'owner-rev' } };
const other: Concept = { ...concept, id: 'synthetic-other', domain: 'Model', source: { path: 'Cognition/Model/other.md', revision: 'other-rev' } };
const third: Concept = { ...other, id: 'synthetic-third', source: { path: 'Notes/Research/third.md', revision: 'third-rev' } };
const forward: GraphLink = { id: 'forward', source: concept.id, target: other.id, type: 'relates', description: 'forward description' };
const reverse: GraphLink = { id: 'reverse', source: other.id, target: concept.id, type: 'depends', description: 'reverse description' };

function draft(overrides: Partial<RelationSuggestionDraft> = {}): RelationSuggestionDraft {
  return { ...createRelationSuggestionDraft(), enabled: true, otherConceptId: other.id, after: { type: 'connects', description: 'new description' }, ...overrides };
}

function fields(value: RelationSuggestionDraft, disabled = false): string {
  return renderToStaticMarkup(createElement(RelationSuggestionFields, { concept, concepts: [concept, other, third], links: [forward, reverse], draft: value, disabled, onChange: () => {} }));
}

test('optional fields select concepts by ID with title/domain/path disambiguation and explicit direction', () => {
  const disabled = fields(createRelationSuggestionDraft());
  assert.match(disabled, /<details class="application-record-details relation-suggestion-fields">/);
  assert.doesNotMatch(disabled, /<details[^>]* open|第二个概念（全部领域）/);
  const html = fields(draft());
  assert.match(html, /搜索第二个概念/);
  assert.match(html, /value="synthetic-other" selected="">同名概念 · AI \/ 模型 · Cognition\/Model\/other.md · synthetic-other/);
  assert.match(html, /value="synthetic-third">同名概念 · Research · Notes\/Research\/third.md · synthetic-third/);
  assert.doesNotMatch(html, /<option[^>]*value="synthetic-owner"/);
  assert.match(html, /当前概念 → 第二个概念/);
  assert.match(html, /第二个概念 → 当前概念/);
  assert.match(html, /待核对建议，尚未验证采纳/);
  assert.match(html, /取消勾选会放弃/);
});

test('change/remove list only exact relations in the chosen direction and lock all editable fields', () => {
  const changed = fields(draft({ operation: 'change', before: { type: forward.type, description: forward.description } }));
  assert.match(changed, /relates · forward description/);
  assert.doesNotMatch(changed, /depends · reverse description/);
  assert.match(changed, /修改方向请分别记录移除和新增建议/);
  const removed = fields(draft({ operation: 'remove', direction: 'incoming', before: { type: reverse.type, description: reverse.description } }), true);
  assert.match(removed, /depends · reverse description/);
  assert.doesNotMatch(removed, /relates · forward description|建议关系类型|建议关系描述/);
  for (const tag of removed.match(/<(?:input|select|textarea)\b[^>]*>/g) ?? []) assert.match(tag, /disabled=""/);
});

test('snapshot preview shows frozen identities and before/after for each operation without current lookups', () => {
  for (const operation of ['add', 'change', 'remove'] as const) {
    const suggestion = buildRelationSuggestion(concept, draft({ operation, before: { type: forward.type, description: forward.description } }), [other], [forward])!;
    const frozen = { ...suggestion, source: { ...suggestion.source, title: '冻结源标题' }, target: { ...suggestion.target, title: '冻结目标标题' } } as RelationSuggestion;
    const html = renderToStaticMarkup(createElement(RelationSuggestionPreview, { suggestion: frozen }));
    assert.match(html, /冻结源标题 → 冻结目标标题/);
    assert.match(html, /synthetic-owner|synthetic-other/);
    assert.match(html, /Cognition\/Model\/other.md/);
    assert.match(html, /owner-rev|other-rev/);
    assert.match(html, /记录时快照，整理前核对当前知识源/);
    assert.match(html, /待核对建议，尚未验证采纳/);
    if (operation !== 'add') assert.match(html, /原关系描述<\/dt><dd>forward description/);
    else assert.doesNotMatch(html, /原关系类型/);
    if (operation !== 'remove') assert.match(html, /建议关系描述<\/dt><dd>new description/);
    else assert.doesNotMatch(html, /建议关系类型/);
  }
});

test('dialog accepts the optional draft and material uses a separate selected relation field', () => {
  const value = { ...createApplicationRecordDraft('summary'), content: 'synthetic learning explanation', relationSuggestion: draft() };
  const html = renderToStaticMarkup(createElement(ApplicationRecordDialog, { concept, concepts: [other], links: [], initialDraft: value, busy: true, onSave: async () => true, onClose: () => {} }));
  assert.match(html, /关系建议（可选）/);
  assert.match(html, /value="synthetic-other" selected=""/);
  for (const tag of html.match(/<(?:input|select|textarea)\b[^>]*>/g) ?? []) assert.match(tag, /disabled=""/);
  const request = buildApplicationRecordRequest(concept, value, '2026-10-01T00:00:00.000Z', 'synthetic-event', { concepts: [other] });
  const material = renderToStaticMarkup(createElement(ApplicationMaterialPreview, { concept, record: request }));
  assert.match(material, /<input type="checkbox" checked=""\/>关系建议（待核对）/);
  assert.doesNotMatch(material, /synthetic learning explanation/);
  assert.match(material, /new description/);
});
