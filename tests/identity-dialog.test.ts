import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IdentityBinding, IdentityConcept, IdentityLinkPreview } from '../src/shared/identity.js';
import {
  IdentityDialog,
  buildIdentityLinkCommit,
  filterIdentityConcepts,
  recentIdentityBindings,
  sortIdentityTargets,
} from '../src/web/IdentityDialog.js';

function concept(overrides: Partial<IdentityConcept> = {}): IdentityConcept {
  return {
    conceptId: 'old-a',
    title: '注意力机制',
    path: null,
    sourceRevision: 'revision-a',
    counts: { anchors: 2, observations: 3, retentions: 1, applications: 4 },
    hasLayout: false,
    preference: null,
    ...overrides,
  };
}

function preview(overrides: Partial<IdentityLinkPreview> = {}): IdentityLinkPreview {
  return {
    sourceId: 'source-a',
    token: 'preview-token',
    canLink: true,
    from: concept(),
    to: concept({ conceptId: 'new-a', title: '注意力机制（当前）', path: 'Math/attention.md' }),
    revisionMatches: true,
    issues: [],
    layoutAction: 'keep-original',
    ...overrides,
  };
}

test('SSR keeps the identity dialog explanation and does not render private source content', () => {
  const html = renderToStaticMarkup(createElement(IdentityDialog, {
    sourceId: 'source-a',
    lockedReason: '知识源正在重新连接',
    onLoad: async () => ({ sourceId: 'source-a', orphans: [], targets: [], bindings: [] }),
    onPreview: async () => preview(),
    onCommit: async () => ({ status: 'accepted' as const, operationId: 'op-a', sourceId: 'source-a', conceptId: 'old-a', linkedPath: 'Math/attention.md', confirmedAt: '2026-09-27T00:00:00.000Z', backupId: 'backup-a' }),
    onLinked: () => undefined,
    onClose: () => undefined,
  }));
  assert.match(html, /历史衔接/);
  assert.match(html, /学习事件和原时间不会改写/);
  assert.match(html, /当前暂不能开始新的历史衔接：知识源正在重新连接/);
  assert.match(html, /读取中…/);
  assert.doesNotMatch(html, /原始回答|业务场景|正文内容/);
});

test('target sorting puts exact source revisions first without selecting one', () => {
  const exact = concept({ conceptId: 'target-exact', title: 'Zeta', path: 'z.md' });
  const other = concept({ conceptId: 'target-other', title: 'Alpha', path: 'a.md', sourceRevision: 'revision-other' });
  const source = [other, exact];
  const sorted = sortIdentityTargets(source, 'revision-a');
  assert.deepEqual(sorted.map((item) => item.conceptId), ['target-exact', 'target-other']);
  assert.deepEqual(source.map((item) => item.conceptId), ['target-other', 'target-exact']);
});

test('search includes title, id, path and revision while keeping unknown paths searchable by id', () => {
  const items = [concept(), concept({ conceptId: 'new-b', title: '别的概念', path: 'Physics/old.md', sourceRevision: 'revision-b' })];
  assert.deepEqual(filterIdentityConcepts(items, 'physics').map((item) => item.conceptId), ['new-b']);
  assert.deepEqual(filterIdentityConcepts(items, 'revision-a').map((item) => item.conceptId), ['old-a']);
  assert.deepEqual(filterIdentityConcepts(items, 'old-a').map((item) => item.conceptId), ['old-a']);
});

test('binding list is newest first and limited without mutating input', () => {
  const bindings: IdentityBinding[] = Array.from({ length: 31 }, (_, index) => ({
    operationId: `op-${index}`,
    rawConceptId: `raw-${index}`,
    conceptId: `target-${index}`,
    fromPath: null,
    toPath: `current/${index}.md`,
    sourceRevision: 'revision-a',
    confirmedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    backupId: `backup-${index}`,
  }));
  const recent = recentIdentityBindings(bindings);
  assert.equal(recent.length, 30);
  assert.equal(recent[0].operationId, 'op-30');
  assert.equal(recent.at(-1)?.operationId, 'op-1');
  assert.equal(bindings[0].operationId, 'op-0');
});

test('commit freezes the selected pair, preview token, confirmation and operation id for retries', () => {
  const request = { fromConceptId: 'old-a', toConceptId: 'new-a' } as const;
  const result = buildIdentityLinkCommit(request, preview(), 'operation-fixed');
  assert.deepEqual(result, {
    fromConceptId: 'old-a',
    toConceptId: 'new-a',
    operationId: 'operation-fixed',
    previewToken: 'preview-token',
    confirmed: true,
  });
  assert.equal(result.operationId, 'operation-fixed');
  assert.equal(result.previewToken, 'preview-token');
  assert.deepEqual(request, { fromConceptId: 'old-a', toConceptId: 'new-a' });
});
