import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ApplicationRecordRequest, Concept } from '../src/shared/types.ts';
import {
  APPLICATION_CONTENT_MAX_LENGTH,
  APPLICATION_TEXT_MAX_LENGTH,
  buildApplicationMaterial,
  buildApplicationRecordRequest,
  createApplicationRecordDraft,
  defaultApplicationMaterialFields,
  validateApplicationRecordRequest,
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
