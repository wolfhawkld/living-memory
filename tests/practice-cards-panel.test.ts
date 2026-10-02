import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Concept } from '../src/shared/types.ts';
import type { PracticeHandlers } from '../src/shared/practice.ts';
import { PracticeBlindAnswer, PracticeCardsDialog } from '../src/web/PracticeCardsDialog.tsx';

const concept: Concept = {
  id: 'math:boolean',
  title: '布尔逻辑',
  aliases: [],
  domain: 'Math',
  summary: '真值与规则。',
  body: '# 私密正文\n不应在盲答阶段出现',
  source: { path: 'Math/Boolean.md', revision: 'revision-1' },
};

const handlers: PracticeHandlers = {
  loadCards: async () => ({ sourceId: 'source:test', asOf: '2026-10-02T00:00:00.000Z', items: [] }),
  loadHistory: async (cardId) => ({ sourceId: 'source:test', cardId, cards: [], attempts: [] }),
  saveCard: async () => true,
  saveAttempt: async () => true,
  readConcept: async () => concept,
};

test('server-rendered dialog starts with a safe loading shell and no reference answer', () => {
  const html = renderToStaticMarkup(createElement(PracticeCardsDialog, {
    sourceId: 'source:test',
    concepts: [concept],
    lockedReason: null,
    handlers,
    wasSourceViewed: () => false,
    onSourceExposed: () => undefined,
    onClose: () => undefined,
  }));
  assert.match(html, /私人练习卡/);
  assert.doesNotMatch(html, /不应在盲答阶段出现/);
});

test('blind answer export renders only the prompt and learner answer', () => {
  const html = renderToStaticMarkup(createElement(PracticeBlindAnswer, {
    prompt: '如何拆分规则？',
    answer: '先拆出独立条件。',
    onAnswer: () => undefined,
    onSubmit: () => undefined,
  }));
  assert.match(html, /如何拆分规则？/);
  assert.match(html, /先拆出独立条件。/);
  assert.doesNotMatch(html, /核对答案|历史|布尔逻辑/);
});
