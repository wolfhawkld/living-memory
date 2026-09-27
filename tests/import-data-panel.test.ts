import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ImportPreview, ImportPreviewRequest } from '../src/shared/import-data.js';
import {
  ImportDataDialog,
  buildImportCommitRequest,
  classifyImportCommitFailure,
  parseImportJsonText,
} from '../src/web/ImportDataDialog.js';

const data = {
  schemaVersion: 1,
  concepts: [{ id: 'concept-a', body: 'PRIVATE_BODY', answer: 'PRIVATE_ANSWER' }],
  observations: [{ eventId: 'observation-a' }],
};

function counts() {
  return {
    added: { anchors: 2, observations: 3, retentions: 1, applications: 2 },
    duplicates: 4,
    configurations: 1,
    matchedConcepts: 2,
    remappedConcepts: 1,
    unresolvedConcepts: 1,
  };
}

function preview(overrides: Partial<ImportPreview> = {}): ImportPreview {
  return {
    sourceId: 'source-current',
    token: 'preview-token',
    canImport: true,
    exportedAt: '2026-09-27T08:00:00.000Z',
    counts: counts(),
    matches: [
      { fromId: 'old-a', toId: 'current-a', title: '概念 A', path: 'Math/a.md', backupRevision: 'sha256:old', currentRevision: 'sha256:new', match: 'path-revision' },
      { fromId: 'old-b', toId: null, title: '旧概念 B', path: 'Old/b.md', backupRevision: 'sha256:old-b', currentRevision: null, match: 'unresolved' },
    ],
    issues: [{ severity: 'warning', code: 'UNRESOLVED_CONCEPT', message: '1 条历史记录暂未关联当前概念。', conceptId: 'old-b' }],
    issueCount: 1,
    config: {
      before: { modelVersion: 'time-only-v0', halfLifeDays: 7, revision: 2 },
      after: { modelVersion: 'time-only-v0', halfLifeDays: 14, revision: 3 },
    },
    layoutChanged: true,
    reviewPlanChanged: true,
    options: { restoreLayout: false, restoreReviewPlan: true },
    ...overrides,
  };
}

function dialog(overrides: Partial<React.ComponentProps<typeof ImportDataDialog>> = {}): string {
  return renderToStaticMarkup(createElement(ImportDataDialog, {
    sourceId: 'source-current',
    accountLabel: 'damon',
    lockedReason: null,
    onPreview: async () => preview(),
    onCommit: async () => ({ status: 'accepted' as const, importId: 'import-a', sourceId: 'source-current', importedAt: '2026-09-27T08:00:00.000Z', counts: counts(), backupId: 'backup-a' }),
    onClose: () => undefined,
    onImported: () => undefined,
    ...overrides,
  }));
}

test('SSR renders the local-only file flow, restore choices, account scope, and no private payload', () => {
  const html = dialog();
  assert.match(html, /导入学习数据/);
  assert.match(html, /当前账号：damon/);
  assert.match(html, /选择 JSON 备份文件/);
  assert.match(html, /上限 20 MiB/);
  assert.match(html, /恢复备份布局/);
  assert.match(html, /恢复每日预算并合并重点 \/ 暂缓/);
  assert.match(html, /修改文件或选项后，之前的预览和确认会自动作废/);
  assert.match(html, /知识 Markdown 仍需先放入知识目录并刷新/);
  assert.doesNotMatch(html, /PRIVATE_BODY|PRIVATE_ANSWER/);
});

test('locked state keeps the dialog closable while stopping the preview action', () => {
  const html = dialog({ lockedReason: '知识空间正在重新连接' });
  assert.match(html, /当前暂不能确认新导入：知识空间正在重新连接/);
  const previewButton = html.match(/<button[^>]*>预览导入影响<\/button>/)?.[0] ?? '';
  assert.match(previewButton, /disabled/);
  const closeButton = html.match(/<button[^>]*aria-label="关闭导入窗口"[^>]*>/)?.[0] ?? '';
  assert.doesNotMatch(closeButton, /disabled/);
});

test('commit request freezes preview token, options, data, confirmation, and import id', () => {
  const request: ImportPreviewRequest = { data, options: { restoreLayout: true, restoreReviewPlan: false } };
  const result = buildImportCommitRequest(request, preview(), 'import-fixed');
  assert.equal(result.importId, 'import-fixed');
  assert.equal(result.previewToken, 'preview-token');
  assert.equal(result.confirmed, true);
  assert.strictEqual(result.data, data);
  assert.deepEqual(result.options, request.options);
  const changed = { ...result.options, restoreReviewPlan: true };
  assert.deepEqual(result.options, { restoreLayout: true, restoreReviewPlan: false });
  assert.notDeepEqual(changed, result.options);
});

test('local JSON parser enforces object shape and the 20 MiB boundary', () => {
  assert.deepEqual(parseImportJsonText('{"schemaVersion":1}'), { schemaVersion: 1 });
  assert.throws(() => parseImportJsonText('{broken'), /有效的 JSON/);
  assert.throws(() => parseImportJsonText('[]'), /JSON 对象/);
  const oversized = `{"value":"${'x'.repeat(20 * 1024 * 1024)}"}`;
  assert.throws(() => parseImportJsonText(oversized), /超过 20 MiB/);
});

test('commit failure policy requires preview again for stale or uncertain file/options results', () => {
  assert.equal(classifyImportCommitFailure(Object.assign(new Error('stale'), { code: 'IMPORT_STALE' })), 'stale');
  assert.equal(classifyImportCommitFailure(Object.assign(new Error('file'), { code: 'IMPORT_FILE' })), 'unknown-file-options');
  assert.equal(classifyImportCommitFailure(Object.assign(new Error('options'), { code: 'OPTIONS_INVALID' })), 'unknown-file-options');
  assert.equal(classifyImportCommitFailure(Object.assign(new Error('offline'), { code: 'NETWORK_OFFLINE' })), 'retry');
  assert.equal(classifyImportCommitFailure(new Error('temporary failure')), 'retry');
});
