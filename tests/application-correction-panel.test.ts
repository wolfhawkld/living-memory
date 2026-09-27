import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ApplicationRecord } from '../src/shared/types.js';
import type { CorrectionHistory } from '../src/shared/corrections.js';
import {
  ApplicationCorrectionPanel,
  buildCorrectionRequest,
  type ApplicationCorrectionPanelProps,
} from '../src/web/ApplicationCorrectionPanel.js';

function application(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    eventId: 'application-1',
    conceptId: 'concept-1',
    sourceRevision: 'revision-1',
    occurredAt: '2026-09-18T08:00:00.000Z',
    recordedAt: '2026-09-18T08:01:00.000Z',
    kind: 'application',
    context: '场景',
    content: '总结',
    outcome: 'success',
    assistance: 'independent',
    result: '',
    limitations: '',
    insight: '',
    correction: '建议把旧理解改成当前资料中的表述。',
    references: '',
    ...overrides,
  };
}

function correctionHistory(overrides: Partial<CorrectionHistory> = {}): CorrectionHistory {
  return { latest: null, events: [], total: 0, ...overrides };
}

function panel(overrides: Partial<ApplicationCorrectionPanelProps> = {}): string {
  return renderToStaticMarkup(createElement(ApplicationCorrectionPanel, {
    application: application(),
    currentRevision: 'revision-2',
    history: correctionHistory(),
    disabled: false,
    pending: false,
    onSave: async () => ({ ok: true }),
    ...overrides,
  }));
}

test('an application without a correction suggestion does not render a review control', () => {
  assert.equal(panel({ application: application({ correction: '' }) }), '');
});

test('a new correction starts as pending and source changes remain an explicit prompt', () => {
  const html = panel();
  assert.match(html, /待处理/);
  assert.match(html, /来源已更新，待人工核对/);
  assert.match(html, /原版本/);
  assert.match(html, /当前版本/);
  assert.match(html, /确认已纳入当前版本/);
});

test('resolved history from an older version stays resolved and calls out the old review version', () => {
  const event = {
    eventId: 'correction-1', applicationEventId: 'application-1', conceptId: 'concept-1',
    sourceRevision: 'revision-2', occurredAt: '2026-09-19T08:00:00.000Z',
    previousEventId: null, status: 'resolved' as const, note: '已核对当时版本。', recordedAt: '2026-09-19T08:01:00.000Z',
  };
  const html = panel({ currentRevision: 'revision-3', history: correctionHistory({ latest: event, events: [event], total: 1 }) });
  assert.match(html, /确认已纳入当前版本/);
  assert.match(html, /上次核对的是旧版资料/);
  assert.match(html, /处理说明：已核对当时版本/);
  assert.match(html, /发生于/);
  assert.match(html, /保存于/);
  assert.match(html, /确认版本 revision-2/);
  assert.doesNotMatch(html, /系统已经核验|系统自动验证/);
});

test('an older service response does not invent a correction status or allow writing', () => {
  const html = panel({ history: undefined, onSave: undefined });
  assert.match(html, /服务未提供修正复核历史/);
  assert.doesNotMatch(html, /待处理/);
  assert.doesNotMatch(html, /确认并保存决定/);
});

test('pending and disabled states render the form as read-only', () => {
  const pending = panel({ pending: true });
  assert.match(pending, /原记录待同步/);
  assert.match(pending, /<select[^>]*disabled/);
  assert.match(pending, /<textarea[^>]*disabled/);
  assert.match(panel({ disabled: true }), /<select[^>]*disabled/);
});

test('correction payload freezes the source metadata and previous event before sending', () => {
  const latest = {
    eventId: 'correction-previous', applicationEventId: 'application-1', conceptId: 'concept-1',
    sourceRevision: 'revision-1', occurredAt: '2026-09-17T08:00:00.000Z',
    previousEventId: null, status: 'dismissed' as const, note: '', recordedAt: '2026-09-17T08:01:00.000Z',
  };
  const request = buildCorrectionRequest(application(), 'revision-2', correctionHistory({ latest, events: [latest], total: 1 }), 'open', '  人工备注  ', 'correction-new', '2026-09-20T08:00:00.000Z');
  assert.deepEqual(request, {
    eventId: 'correction-new', applicationEventId: 'application-1', conceptId: 'concept-1',
    sourceRevision: 'revision-2', occurredAt: '2026-09-20T08:00:00.000Z',
    previousEventId: 'correction-previous', status: 'open', note: '人工备注',
  });
});
