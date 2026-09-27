import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LearningProgress, LearningProgressPoint } from '../src/shared/learning-progress.js';
import { LearningProgressPanel } from '../src/web/LearningProgressPanel.js';

function point(overrides: Partial<LearningProgressPoint> = {}): LearningProgressPoint {
  return {
    eventId: 'private-event-id',
    observedAt: '2026-09-20T10:00:00.000Z',
    recordedAt: '2026-09-20T10:01:00.000Z',
    rating: 'partial',
    cue: 'independent',
    exposure: 'unexposed',
    observedExposure: false,
    confidence: 75,
    outcome: 'success',
    basis: 'self-check',
    elapsedDays: 2.5,
    halfLifeDays: 7.125,
    configRevision: 4,
    ...overrides,
  };
}

function progress(overrides: Partial<LearningProgress> = {}): LearningProgress {
  return {
    conceptId: 'private-concept-id',
    sourceRevision: 'private-revision',
    asOf: '2026-09-21T00:00:00.000Z',
    tasks: {
      concept: { total: 0, previous: null, latest: null, intervalDays: null, conditions: 'insufficient' },
      scenario: { total: 0, previous: null, latest: null, intervalDays: null, conditions: 'insufficient' },
    },
    excluded: { previousRevision: 0, invalidTime: 0 },
    ...overrides,
  };
}

function render(value: LearningProgress | undefined): string {
  return renderToStaticMarkup(createElement(LearningProgressPanel, { progress: value }));
}

test('old service absence differs from a loaded empty result, with both collapsed', () => {
  assert.match(render(undefined), /当前服务尚未返回/);
  assert.doesNotMatch(render(undefined), /记录数：0/);
  const html = render(progress());
  assert.match(html, /<details class="learning-progress-panel">/);
  assert.match(html, /<summary>回忆变化追踪<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]+ open/);
  assert.match(html, /概念解释/);
  assert.match(html, /场景调用/);
  assert.match(html, /暂无当前资料版本回忆记录/);
  assert.match(html, /记录数：0/);
  assert.match(html, /记录不足，无法判断条件/);
});

test('single records are identified without pretending that a comparison exists', () => {
  const html = render(progress({
    tasks: {
      concept: { total: 1, previous: null, latest: point(), intervalDays: null, conditions: 'insufficient' },
      scenario: { total: 0, previous: null, latest: null, intervalDays: null, conditions: 'insufficient' },
    },
  }));
  assert.match(html, /当前资料版本只有 1 条记录，无法形成两次对照/);
  assert.match(html, /最近一条/);
  assert.match(html, /自评/);
  assert.doesNotMatch(html, /核对结果：成功/);
});

test('two task groups expose metadata only, including frozen values and caveats', () => {
  const html = render(progress({
    tasks: {
      concept: {
        total: 2,
        previous: point({ observedAt: '2026-09-18T10:00:00.000Z', rating: 'clear' }),
        latest: point({ observedAt: '2026-09-20T10:00:00.000Z', confidence: null, observedExposure: true }),
        intervalDays: 2,
        conditions: 'same',
      },
      scenario: {
        total: 2,
        previous: point({ observedAt: '2026-09-19T10:00:00.000Z', outcome: 'partial', basis: 'application', cue: 'hinted' }),
        latest: point({ observedAt: '2026-09-19T22:00:00.000Z', outcome: 'unverified', basis: 'unknown', cue: 'lookup' }),
        intervalDays: 0.5,
        conditions: 'different',
      },
    },
  }));
  assert.match(html, /记录数：2/);
  assert.match(html, /上一条/);
  assert.match(html, /最近一条/);
  assert.match(html, /真实作答间隔：2\.0 天/);
  assert.match(html, /真实作答间隔：12\.0 小时/);
  assert.match(html, /所报条件相同/);
  assert.match(html, /所报条件不同/);
  assert.match(html, /核对结果/);
  assert.match(html, /核对依据/);
  assert.match(html, /提示方式/);
  assert.match(html, /曝光/);
  assert.match(html, /<dt>事前信心<\/dt><dd>未记录<\/dd>/);
  assert.match(html, /距重温/);
  assert.match(html, /H/);
  assert.match(html, /参数版本/);
  assert.match(html, /两次作答间隔不代表期间未接触资料/);
  assert.match(html, /场景题目可能不同/);
  assert.match(html, /不据此推断记忆改善或自动改变记忆状态/);
  assert.doesNotMatch(html, /private-event-id|private-concept-id|private-revision/);
});

test('time preview explicitly keeps the real saved observations', () => {
  const html = renderToStaticMarkup(createElement(LearningProgressPanel, { progress: progress(), simulated: true }));
  assert.match(html, /当前为时间预览，以下仍为真实学习记录/);
});

test('same-time intervals and legacy missing metadata remain readable', () => {
  const html = render(progress({
    tasks: {
      concept: {
        total: 2,
        previous: point({ observedAt: '2026-09-20T10:00:00.000Z' }),
        latest: point({ observedAt: '2026-09-20T10:00:00.000Z', confidence: null, cue: undefined, halfLifeDays: undefined, configRevision: undefined }),
        intervalDays: 0,
        conditions: 'unknown',
      },
      scenario: {
        total: 2,
        previous: point(),
        latest: point({ outcome: undefined, basis: undefined, exposure: undefined, observedExposure: undefined }),
        intervalDays: null,
        conditions: undefined,
      },
    },
    excluded: { previousRevision: 2, invalidTime: 1 },
  } as unknown as Partial<LearningProgress>));
  assert.match(html, /同一时刻/);
  assert.match(html, /所报条件不明/);
  assert.match(html, /旧资料版本记录排除 2 条/);
  assert.match(html, /时间异常记录排除 1 条/);
  assert.match(html, /未记录/);
});
