import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { chooseDomain, domainIdOf } from '../../src/core/domain-view';
import type { ApplicationRecordRequest, Concept, ExportData, Snapshot } from '../../src/shared/types';
import type { RelationReviewRequest } from '../../src/shared/relation-reviews';

async function exported(request: APIRequestContext): Promise<ExportData> {
  const result = await request.get('/api/export');
  expect(result.ok()).toBe(true);
  return result.json();
}
async function snapshot(request: APIRequestContext): Promise<Snapshot> {
  const result = await request.get('/api/snapshot?scope=all');
  expect(result.ok()).toBe(true);
  return result.json();
}
async function realMode(page: Page) {
  const real = page.getByRole('button', { name: '查看真实记录', exact: true });
  const demo = page.getByRole('button', { name: '查看示例状态', exact: true });
  await expect(real.or(demo)).toBeVisible();
  if (await real.isVisible()) await real.click();
  await expect(demo).toBeVisible();
}
async function selectExactConcept(page: Page, concept: Concept) {
  await page.getByRole('combobox', { name: '搜索概念', exact: true }).fill(concept.title);
  const option = page.getByRole('listbox', { name: '概念搜索结果', exact: true }).getByRole('option').filter({
    has: page.locator('.concept-search-option-title', { hasText: new RegExp(`^${concept.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
  });
  await expect(option).toHaveCount(1);
  await option.click();
}

test('relation decisions persist separately from text corrections and retain their own draft navigation lock', async ({ page, request }) => {
  const before = await exported(request);
  const graphBefore = await snapshot(request);
  const domain = chooseDomain(graphBefore);
  // Resolve stable IDs and paths first; only globally unique fixture titles enter the UI selector.
  const candidates = graphBefore.concepts.filter((item) => domainIdOf(item) === domain
    && graphBefore.concepts.filter((other) => other.title === item.title).length === 1);
  expect(candidates.length).toBeGreaterThanOrEqual(2);
  const [primary, secondary] = candidates;
  expect(primary.id).not.toBe(secondary.id);
  expect(primary.source.path).not.toBe(secondary.source.path);
  const type = `review-e2e-${randomUUID()}`;
  expect(graphBefore.links.some((link) => link.source === primary.id && link.target === secondary.id && link.type === type)).toBe(false);
  const endpoint = (concept: Concept) => ({ conceptId: concept.id, sourceRevision: concept.source.revision, title: concept.title, path: concept.source.path });
  const content = `合成关系复核记录 ${randomUUID()}`;
  const application: ApplicationRecordRequest = {
    eventId: randomUUID(), conceptId: primary.id, sourceRevision: primary.source.revision,
    occurredAt: new Date().toISOString(), kind: 'summary', context: '', content,
    outcome: 'unverified', assistance: 'independent', result: '', limitations: '', insight: '',
    correction: '独立的文字建议：保留处理链边界。', references: '',
    relationSuggestion: { operation: 'add', source: endpoint(primary), target: endpoint(secondary), after: { type, description: '仅用于隔离测试，不写知识源。' } },
  };
  const sessionResponse = await request.get('/api/session');
  expect(sessionResponse.ok()).toBe(true);
  const session = await sessionResponse.json() as { writeToken: string; sourceId: string };
  const created = await request.post('/api/applications', { headers: { 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId }, data: application });
  expect(created.ok()).toBe(true);
  await page.goto('/');
  await realMode(page);
  const selectedHistory = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === `/api/concepts/${encodeURIComponent(primary.id)}/history`);
  await selectExactConcept(page, primary);
  expect((await selectedHistory).ok()).toBe(true);
  await expect(page.locator('.detail-head h2')).toHaveText(primary.title);

  const entry = page.getByRole('region', { name: '概念学习历史' }).locator('.concept-history-entry').filter({ hasText: content });
  // Content is intentionally hidden until expanded, so identify the newest summary first.
  const initialEntry = page.getByRole('region', { name: '概念学习历史' }).locator('.concept-history-entry').filter({ hasText: '总结 / insight' }).first();
  await initialEntry.getByRole('button', { name: '展开应用 / 总结内容', exact: true }).click();
  await expect(entry).toHaveCount(1);
  let panel = entry.getByRole('region', { name: '关系建议复核', exact: true });
  await expect(panel).toContainText('不符合建议结果');
  await expect(panel).toContainText(primary.id);
  await expect(panel).toContainText(primary.source.path);
  await expect(panel).toContainText(secondary.id);
  await panel.getByRole('combobox', { name: '关系处理决定', exact: true }).selectOption('resolved');
  await expect(panel.getByRole('checkbox', { name: '我已核对当前知识源，确认该关系建议已采纳', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '保存关系决定', exact: true })).toBeDisabled();
  await panel.getByRole('combobox', { name: '关系处理决定', exact: true }).selectOption('dismissed');
  await panel.getByLabel('关系处理说明（可选）', { exact: true }).fill('当前没有该精确关系，暂不采用。');
  const reviewPath = `/api/applications/${application.eventId}/relation-review`;
  let rejectFirst = true;
  let blockFollowupReads = false;
  await page.route('**/api/relation-reviews', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    if (rejectFirst) {
      rejectFirst = false;
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'RELATION_REVIEW_SOURCE_CHANGED', message: '合成测试：当前核对依据已变化。' } }) });
      return;
    }
    blockFollowupReads = true;
    await route.continue();
  });
  await page.route(`**${reviewPath}`, async (route) => {
    if (blockFollowupReads) await route.abort('failed');
    else await route.continue();
  });
  const rejectedSave = page.waitForRequest((value) => value.method() === 'POST' && new URL(value.url()).pathname === '/api/relation-reviews');
  await panel.getByRole('button', { name: '保存关系决定', exact: true }).click();
  const rejectedPayload = (await rejectedSave).postDataJSON() as RelationReviewRequest;
  await expect(panel).toContainText('服务已明确拒绝本次依据或前序事件');
  await panel.getByRole('button', { name: '重新核对当前状态', exact: true }).click();
  await expect(panel.getByLabel('关系处理说明（可选）', { exact: true })).toHaveValue('当前没有该精确关系，暂不采用。');
  await expect(panel.getByRole('button', { name: '保存关系决定', exact: true })).toBeEnabled();
  const firstSave = page.waitForRequest((value) => value.method() === 'POST' && new URL(value.url()).pathname === '/api/relation-reviews');
  await panel.getByRole('button', { name: '保存关系决定', exact: true }).click();
  const firstPayload = (await firstSave).postDataJSON() as RelationReviewRequest;
  expect(firstPayload.eventId).not.toBe(rejectedPayload.eventId);
  expect(firstPayload.status).toBe('dismissed');
  expect(firstPayload.previousEventId).toBeNull();
  expect(firstPayload.basis.afterPresent).toBe(false);
  await expect.poll(async () => (await exported(request)).relationReviews?.some((event) => event.eventId === firstPayload.eventId)).toBe(true);
  // The write succeeded, but its follow-up GET failed. Read refresh must stay enabled.
  await expect(panel).toContainText('已有决定保持不变');
  const refresh = panel.getByRole('button', { name: '刷新关系核对', exact: true });
  await expect(refresh).toBeEnabled(); blockFollowupReads = false; await refresh.click();
  await expect(panel.getByRole('heading')).toHaveText('关系建议复核：暂不采用');
  await page.unroute('**/api/relation-reviews');
  await page.unroute(`**${reviewPath}`);

  await page.reload(); await realMode(page); await selectExactConcept(page, primary);
  await initialEntry.getByRole('button', { name: '展开应用 / 总结内容', exact: true }).click();
  panel = entry.getByRole('region', { name: '关系建议复核', exact: true });
  await expect(panel.getByRole('heading')).toHaveText('关系建议复核：暂不采用');
  await expect(panel).toContainText('当前没有该精确关系，暂不采用。');
  await panel.getByRole('combobox', { name: '关系处理决定', exact: true }).selectOption('open');
  await panel.getByLabel('关系处理说明（可选）', { exact: true }).fill('关系草稿仍需保留，等待后续整理。');
  const textPanel = entry.getByRole('region', { name: '知识修正复核', exact: true });
  await textPanel.locator('select').selectOption('dismissed');
  await textPanel.getByLabel('处理说明（可选）', { exact: true }).fill('文字建议独立处理。');
  await textPanel.getByRole('button', { name: '确认并保存决定', exact: true }).click();
  await expect(textPanel).toContainText('人工决定：暂不采用');
  await expect(textPanel.getByRole('button', { name: '确认并保存决定', exact: true })).toBeEnabled();

  const confirmation = page.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.message()).toBe('当前复核说明尚未提交，继续操作会关闭这份草稿。确定继续吗？');
    await dialog.dismiss();
  });
  await Promise.all([confirmation, selectExactConcept(page, secondary)]);
  await expect(page.locator('.detail-head h2')).toHaveText(primary.title);
  await expect(panel.getByLabel('关系处理说明（可选）', { exact: true })).toHaveValue('关系草稿仍需保留，等待后续整理。');
  const secondSave = page.waitForRequest((value) => value.method() === 'POST' && new URL(value.url()).pathname === '/api/relation-reviews');
  await panel.getByRole('button', { name: '保存关系决定', exact: true }).click();
  const secondPayload = (await secondSave).postDataJSON() as RelationReviewRequest;
  expect(secondPayload.status).toBe('open'); expect(secondPayload.previousEventId).toBe(firstPayload.eventId);
  await expect(panel.getByRole('heading')).toHaveText('关系建议复核：待处理');
  await expect.poll(async () => (await exported(request)).relationReviews?.filter((event) => event.applicationEventId === application.eventId).length).toBe(2);

  const after = await exported(request);
  const decisions = after.relationReviews!.filter((event) => event.applicationEventId === application.eventId);
  expect(decisions.map((event) => event.eventId).sort()).toEqual([firstPayload.eventId, secondPayload.eventId].sort());
  expect(decisions.find((event) => event.eventId === firstPayload.eventId)?.basis).toEqual(firstPayload.basis);
  expect(after.corrections?.filter((event) => event.applicationEventId === application.eventId)).toHaveLength(1);
  expect(after.corrections?.find((event) => event.applicationEventId === application.eventId)?.note).toBe('文字建议独立处理。');
  expect(after.relationReviews?.filter((event) => event.applicationEventId !== application.eventId)).toEqual(before.relationReviews ?? []);
  expect(after.corrections?.filter((event) => event.applicationEventId !== application.eventId)).toEqual(before.corrections ?? []);
  for (const field of ['anchors', 'observations', 'retentions', 'config', 'configHistory'] as const) expect(after[field]).toEqual(before[field]);
  expect(after.applications?.find((record) => record.eventId === application.eventId)?.relationSuggestion).toEqual(application.relationSuggestion);
  const graphAfter = await snapshot(request);
  expect(graphAfter.concepts).toEqual(graphBefore.concepts); expect(graphAfter.links).toEqual(graphBefore.links);
});

test('relation overview filters directed endpoints and locates the exact older record without revealing its body', async ({ page, request }) => {
  const graph = await snapshot(request);
  const unique = graph.concepts.filter(item => graph.concepts.filter(other => other.title === item.title).length === 1);
  const primary = unique[0];
  const secondary = unique.find(item => domainIdOf(item) !== domainIdOf(primary));
  expect(secondary).toBeTruthy();
  const endpoint = (concept: Concept) => ({ conceptId: concept.id, sourceRevision: concept.source.revision,
    title: concept.title, path: concept.source.path });
  const session = await (await request.get('/api/session')).json() as { writeToken: string; sourceId: string };
  const headers = { 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId };
  const application: ApplicationRecordRequest = {
    eventId: randomUUID(), conceptId: primary.id, sourceRevision: primary.source.revision,
    occurredAt: '2025-01-01T00:00:00.000Z', kind: 'summary', context: '', content: `PRIVATE_OLD_BODY_${randomUUID()}`,
    outcome: 'unverified', assistance: 'independent', result: '', limitations: '', insight: '', correction: '', references: '',
    relationSuggestion: { operation: 'add', source: endpoint(primary), target: endpoint(secondary!),
      after: { type: `overview-${randomUUID()}`, description: `PRIVATE_RELATION_${randomUUID()}` } },
  };
  expect((await request.post('/api/applications', { headers, data: application })).ok()).toBe(true);
  expect((await request.post('/api/applications', { headers, data: { ...application,
    eventId: randomUUID(), occurredAt: new Date().toISOString(), content: 'Newer unrelated summary', relationSuggestion: undefined } })).ok()).toBe(true);
  const beforeBrowsing = await exported(request);
  await page.goto('/');
  // Real 3D views legitimately persist initial and cross-domain layouts. Keep
  // this browsing-only workflow in text mode so the full export stays stable.
  await expect(page.getByRole('button', { name: '查看真实记录', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '文字列表', exact: true }).click();
  await expect(page.locator('.graph-canvas')).toHaveCount(0);
  await realMode(page);
  await selectExactConcept(page, secondary!);
  await page.getByRole('button', { name: '知识薄弱点总览', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '关系待办', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: '关系建议待办', exact: true })).toBeVisible();
  await expect(dialog).toContainText('本总览未包含');
  await dialog.getByRole('combobox', { name: '知识域', exact: true }).selectOption('');
  await dialog.getByRole('searchbox', { name: '搜索关系双端或记录', exact: true }).fill(secondary!.title);
  await expect(dialog.locator('[data-relation-overview-item="true"]').filter({ hasText: application.eventId })).toHaveCount(1);
  await dialog.getByRole('searchbox', { name: '搜索关系双端或记录', exact: true }).fill(application.eventId);
  const row = dialog.locator('[data-relation-overview-item="true"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(primary.title);
  await expect(row).toContainText(secondary!.title);
  await expect(row).toContainText('待处理');
  await expect(row).not.toContainText(application.content);
  await expect(row).not.toContainText(application.relationSuggestion!.operation === 'add'
    ? application.relationSuggestion!.after.description : 'PRIVATE_RELATION');
  await dialog.getByRole('button', { name: /^暂不采用 \(/ }).click();
  await expect(row).toHaveCount(0);
  await dialog.getByRole('button', { name: /^待跟进 \(/ }).click();
  await expect(row).toHaveCount(1);

  const inspectionPath = `**/api/applications/${application.eventId}/relation-review`;
  let releaseInspection!: () => void;
  let inspectionArrived!: () => void;
  let inspectionFinished!: () => void;
  const gate = new Promise<void>(resolve => { releaseInspection = resolve; });
  const arrived = new Promise<void>(resolve => { inspectionArrived = resolve; });
  const finished = new Promise<void>(resolve => { inspectionFinished = resolve; });
  await page.route(inspectionPath, async route => {
    try {
      const response = await route.fetch();
      inspectionArrived();
      await gate;
      // Closing the dialog aborts the browser request; its delayed reply may be discarded by Playwright too.
      await route.fulfill({ response }).catch(() => undefined);
    } finally { inspectionFinished(); }
  });
  await row.getByRole('button', { name: `定位原记录：${primary.title}`, exact: true }).click();
  await arrived;
  await dialog.getByRole('button', { name: '关闭关系建议待办', exact: true }).click();
  releaseInspection();
  await finished;
  await page.unroute(inspectionPath);
  await expect(page.locator('.detail-head h2')).toHaveText(secondary!.title);
  await page.getByRole('button', { name: '知识薄弱点总览', exact: true }).click();
  await dialog.getByRole('button', { name: '关系待办', exact: true }).click();
  await dialog.getByRole('combobox', { name: '知识域', exact: true }).selectOption('');
  await dialog.getByRole('searchbox', { name: '搜索关系双端或记录', exact: true }).fill(application.eventId);

  // Changing only the server's inspected exact-relation flag must invalidate selection.
  await page.route(inspectionPath, async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, basis: { ...body.basis, afterPresent: true } } });
  });
  await row.getByRole('button', { name: `定位原记录：${primary.title}`, exact: true }).click();
  await expect(dialog).toContainText('关系依据或处理决定已变化');
  await page.unroute(inspectionPath);
  await dialog.getByRole('button', { name: '刷新数据', exact: true }).click();
  await expect(row.getByRole('button', { name: `定位原记录：${primary.title}`, exact: true })).toBeEnabled();
  const focused = page.waitForResponse(response => response.request().method() === 'GET'
    && new URL(response.url()).pathname === `/api/concepts/${encodeURIComponent(primary.id)}/history`
    && new URL(response.url()).searchParams.get('applicationEventId') === application.eventId);
  await row.getByRole('button', { name: `定位原记录：${primary.title}`, exact: true }).click();
  expect((await focused).ok()).toBe(true);
  await expect(dialog).not.toBeVisible();
  const history = page.getByRole('region', { name: '概念学习历史', exact: true });
  await expect(history.locator('.concept-history-focus')).toContainText(application.eventId);
  await expect(history).not.toContainText(application.content);
  await history.getByRole('button', { name: '展开应用 / 总结内容', exact: true }).click();
  await expect(history).toContainText(application.content);
  await expect(history.getByRole('region', { name: '关系建议复核', exact: true })).toBeVisible();
  await expect(page.locator('.graph-canvas')).toHaveCount(0);
  // In text mode no layout is generated; all persisted export content stays unchanged.
  const { exportedAt: _afterExportedAt, ...afterBrowsingRecords } = await exported(request);
  const { exportedAt: _beforeExportedAt, ...beforeBrowsingRecords } = beforeBrowsing;
  expect(afterBrowsingRecords).toEqual(beforeBrowsingRecords);
});
