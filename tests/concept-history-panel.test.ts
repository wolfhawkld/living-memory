import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  AnchorEvent,
  ConceptHistory,
  MemoryState,
  Observation,
} from '../src/shared/types.js';
import {
  ConceptHistoryPanel,
  HistoryObservationAnswer,
  type ConceptHistoryPanelProps,
} from '../src/web/ConceptHistoryPanel.js';

function anchor(overrides: Partial<AnchorEvent> = {}): AnchorEvent {
  return {
    eventId: 'anchor-1',
    conceptId: 'concept-1',
    sourceRevision: 'revision-2',
    occurredAt: '2026-09-18T08:00:00.000Z',
    recordedAt: '2026-09-18T08:01:00.000Z',
    kind: 'review',
    ...overrides,
  };
}

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    eventId: 'observation-1',
    conceptId: 'concept-1',
    sourceRevision: 'revision-2',
    observedAt: '2026-09-19T10:00:00.000Z',
    recordedAt: '2026-09-19T10:02:00.000Z',
    configRevision: 4,
    halfLifeDays: 7.125,
    anchorEventId: 'anchor-1',
    elapsedDays: 1.25,
    decay: 0.882,
    answer: '秘密的原始回答，不应在默认历史 HTML 中出现。',
    rating: 'partial',
    exposure: 'unexposed',
    observedExposure: false,
    ...overrides,
  };
}

function state(overrides: Partial<MemoryState> = {}): MemoryState {
  return {
    conceptId: 'concept-1',
    status: 'recent',
    decay: 0.882,
    elapsedDays: 1.25,
    anchor: anchor(),
    reason: null,
    asOf: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

function history(overrides: Partial<ConceptHistory> = {}): ConceptHistory {
  return {
    sourceId: 'source-test',
    conceptId: 'concept-1',
    sourceRevision: 'revision-2',
    asOf: '2026-09-20T00:00:00.000Z',
    state: state(),
    entries: [
      { type: 'anchor', event: anchor() },
      { type: 'observation', event: observation() },
    ],
    total: 2,
    nextCursor: null,
    ...overrides,
  };
}

function panel(overrides: Partial<ConceptHistoryPanelProps> = {}): string {
  return renderToStaticMarkup(createElement(ConceptHistoryPanel, {
    history: history(),
    loading: false,
    loadingMore: false,
    error: null,
    onRetry: () => undefined,
    onLoadMore: () => undefined,
    onRevealAnswer: () => undefined,
    pendingCount: 0,
    simulated: false,
    ...overrides,
  }));
}

test('does not show an empty loaded state before the first history response', () => {
  assert.equal(panel({ history: null }), '');
  assert.match(panel({ history: null, loading: true }), /正在加载学习历史/);
});

test('renders an explicit empty history response', () => {
  const html = panel({ history: history({ entries: [], total: 0 }) });
  assert.match(html, /还没有已保存的学习记录/);
  assert.match(html, /学习历史/);
  assert.doesNotMatch(html, /正在加载学习历史/);
});

test('keeps observation answers out of SSR HTML until the answer is actively revealed', () => {
  const pendingAnchor = anchor({ eventId: 'pending-anchor', sourceRevision: 'revision-2' });
  const oldEntry = anchor({ eventId: 'old-anchor', sourceRevision: 'revision-1', kind: 'estimated' });
  const event = observation({
    eventId: 'old-observation',
    sourceRevision: 'revision-1',
    elapsedDays: 4.25,
    decay: 0.6,
    halfLifeDays: 7.125,
    configRevision: 9,
    exposure: 'exposed',
    observedExposure: true,
  });
  const html = panel({
    history: history({
      state: state({ status: 'pending', anchor: pendingAnchor }),
      entries: [
        { type: 'anchor', event: oldEntry },
        { type: 'observation', event },
      ],
      total: 2,
    }),
    pendingCount: 2,
  });

  assert.doesNotMatch(html, /秘密的原始回答/);
  assert.match(html, /展开原始回答/);
  assert.match(html, /最新起点 · 待确认/);
  assert.doesNotMatch(html, /当前有效起点/);
  assert.match(html, /补记起点/);
  assert.match(html, /来源版本已变化 · 不用于当前曲线/);
  assert.match(html, /Δt 4\.25 天/);
  assert.match(html, /D 0\.600/);
  assert.match(html, /H 7\.125 天/);
  assert.match(html, /配置 v9/);
  assert.match(html, /资料已查看/);
  assert.match(html, /还有 2 条记录待同步/);
  assert.match(html, /它们不会混入已保存历史/);
});

test('current anchor summary remains visible when its event is outside the current page', () => {
  const current = anchor({ eventId: 'current-anchor', occurredAt: '2026-09-17T06:00:00.000Z' });
  const html = panel({
    history: history({
      state: state({ anchor: current }),
      entries: [{ type: 'observation', event: observation({ eventId: 'older-observation' }) }],
      total: 8,
      nextCursor: 'next-page',
    }),
  });

  assert.match(html, /当前有效起点/);
  assert.match(html, /2026/);
  assert.match(html, /加载更多历史/);
  assert.doesNotMatch(html, /current-anchor/);
});

test('preserves visible history alongside an error, pagination state, and simulation notice', () => {
  const html = panel({
    error: '网络暂时不可用',
    loadingMore: true,
    pendingCount: 1,
    simulated: true,
    history: history({ nextCursor: 'next-page' }),
  });

  assert.match(html, /历史加载失败：网络暂时不可用/);
  assert.match(html, />重试</);
  assert.match(html, /学习观察/);
  assert.doesNotMatch(html, /秘密的原始回答/);
  assert.match(html, /正在加载更多/);
  assert.match(html, /当前为时间预览，真实学习历史不会随预览时间改变/);
  assert.match(html, /还有 1 条记录待同步/);
});

test('renders an error and retry affordance when the initial request has no history', () => {
  const html = panel({ history: null, error: '服务暂时不可用' });
  assert.match(html, /历史加载失败：服务暂时不可用/);
  assert.match(html, /重试加载/);
  assert.doesNotMatch(html, /还没有已保存的学习记录/);
});

test('the standalone answer component also keeps the answer out of SSR markup', () => {
  const event = observation({ answer: '只在主动展开后可见' });
  const html = renderToStaticMarkup(createElement(HistoryObservationAnswer, {
    event,
    onRevealAnswer: () => undefined,
  }));
  assert.match(html, /展开原始回答/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /只在主动展开后可见/);
});
