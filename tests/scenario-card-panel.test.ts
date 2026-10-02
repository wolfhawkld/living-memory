import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Concept } from '../src/shared/types.ts';
import type { PracticeHandlers } from '../src/shared/practice.ts';
import { PracticeBlindAnswer, PracticeCardsDialog } from '../src/web/PracticeCardsDialog.tsx';

const concept: Concept = {
  id: 'private:source',
  title: 'PRIVATE_CONCEPT_TITLE',
  aliases: [],
  domain: 'Private',
  summary: 'PRIVATE_CONCEPT_SUMMARY',
  body: 'PRIVATE_SOURCE_BODY',
  source: { path: 'Private/Source.md', revision: 'revision-1' },
};

const handlers: PracticeHandlers = {
  loadCards: async () => ({ sourceId: 'source:test', asOf: '2026-10-02T00:00:00.000Z', items: [] }),
  loadHistory: async (cardId) => ({ sourceId: 'source:test', cardId, cards: [], attempts: [] }),
  saveCard: async () => true,
  saveAttempt: async () => true,
  readConcept: async () => concept,
};

test('SSR dialog and blind answer keep reference material and source choices out of the initial markup', () => {
  const html = renderToStaticMarkup(createElement(PracticeCardsDialog, {
    sourceId: 'source:test',
    concepts: [concept],
    lockedReason: null,
    handlers,
    wasSourceViewed: () => false,
    onSourceExposed: () => undefined,
    onClose: () => undefined,
  }));
  assert.match(html, /私人练习卡：细节、辨别与场景练习/);
  assert.doesNotMatch(html, /PRIVATE_SOURCE_BODY|PRIVATE_CONCEPT_TITLE|核对答案/);

  const blind = renderToStaticMarkup(createElement(PracticeBlindAnswer, {
    prompt: '面对边界案例时先判断什么？',
    answer: '先列出约束和证据。',
    onAnswer: () => undefined,
    onSubmit: () => undefined,
  }));
  assert.match(blind, /面对边界案例时先判断什么？/);
  assert.match(blind, /先列出约束和证据。/);
  assert.doesNotMatch(blind, /PRIVATE_|核对答案|来源|案例族|历史|结构提示/);
});

test('SSR hint stage exposes only the actual hint and still has no title, source or history payload', () => {
  const html = renderToStaticMarkup(createElement(PracticeBlindAnswer, {
    prompt: '同一个案例题干',
    answer: '提示后的回答',
    hint: '按约束、证据和风险拆开。',
    hintLabel: '结构提示',
    onAnswer: () => undefined,
    onSubmit: () => undefined,
  }));
  assert.match(html, /结构提示/);
  assert.match(html, /按约束、证据和风险拆开。/);
  assert.doesNotMatch(html, /PRIVATE_CONCEPT_TITLE|PRIVATE_SOURCE_BODY|案例族|旧历史|核对答案/);
});
