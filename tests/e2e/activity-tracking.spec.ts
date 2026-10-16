import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import type { ActivityExport } from '../../src/shared/activity';
import type { KnowledgeReferences } from '../../src/shared/knowledge-references';
import type { ExportData, Snapshot } from '../../src/shared/types';
import { chooseDomain, domainIdOf } from '../../src/core/domain-view';

async function activity(request: APIRequestContext): Promise<ActivityExport> {
  const response = await request.get('/api/activity/export');
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<ActivityExport>;
}
async function learning(request: APIRequestContext) {
  const response = await request.get('/api/export');
  expect(response.ok()).toBeTruthy();
  const { exportedAt: _time, ...data } = await response.json() as ExportData;
  return data;
}
async function openHistory(page: Page) {
  await page.getByRole('button', { name: '查阅记录', exact: true }).click();
  const history = page.getByRole('dialog', { name: '查阅记录', exact: true });
  await expect(history).toBeVisible();
  return history;
}
async function clearHistory(page: Page) {
  const history = await openHistory(page);
  await history.getByRole('button', { name: '清除全部查阅记录', exact: true }).click();
  await expect(history.getByRole('region', { name: '确认清除范围', exact: true })).toContainText('不会修改学习记录或记忆状态');
  await history.getByRole('button', { name: '确认清除', exact: true }).click();
  await expect(history.locator('.activity-history-notice')).toContainText('已清除');
  return history;
}

test('actual query gestures and verified reader blocks form a separate clearable history without learning writes', async ({ page, request }) => {
  const snapshotResponse = await request.get('/api/snapshot?scope=all');
  expect(snapshotResponse.ok()).toBeTruthy();
  const snapshot = await snapshotResponse.json() as Snapshot;
  const domain = chooseDomain(snapshot)!;
  const concept = snapshot.concepts.find((item) => domainIdOf(item) === domain && item.body.trim().length > 0)!;
  expect(concept).toBeTruthy();
  // All source text, revisions and block catalogs remain the actual fixture
  // server values. No append receipt or current-version inspection is mocked.
  await page.goto('/');
  await page.getByRole('button', { name: '文字列表', exact: true }).click();
  await page.getByRole('button', { name: '查看真实记录', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '仅本次保存查询原文', exact: true })).toBeEnabled();
  const search = page.getByRole('combobox', { name: '搜索概念', exact: true });
  let history = await openHistory(page);
  const resume = history.getByRole('button', { name: '恢复记录', exact: true });
  if (await resume.count()) await resume.click();
  await history.getByRole('button', { name: '关闭查阅记录', exact: true }).click();
  history = await clearHistory(page);
  await history.getByRole('button', { name: '关闭查阅记录', exact: true }).click();
  await expect.poll(async () => (await activity(request)).events.length).toBe(0);
  await expect(page.getByRole('checkbox', { name: '仅本次保存查询原文', exact: true })).toBeEnabled();
  const beforeLearning = await learning(request);

  const rawQuery = 'activity-no-match-default-20261016';
  await search.fill(rawQuery);
  await expect(page.locator('.concept-search-meta')).toHaveText('没有匹配概念');
  expect((await activity(request)).events).toEqual([]); // Typing alone is not a query event.
  await search.press('Enter');
  await expect.poll(async () => (await activity(request)).events.filter((item) => item.event.kind === 'query.submitted').length).toBe(1);
  let exported = await activity(request);
  const defaultQuery = exported.events.find((item) => item.event.kind === 'query.submitted')!;
  expect(defaultQuery.event.refs).toEqual([]);
  expect(defaultQuery.event.payload).toEqual({ resultCount: 0 });
  expect(JSON.stringify(exported)).not.toContain(rawQuery);

  const explicitQuery = 'activity-no-match-explicit-20261016';
  await search.fill(explicitQuery);
  await page.getByRole('checkbox', { name: '仅本次保存查询原文', exact: true }).check();
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect.poll(async () => (await activity(request)).events.filter((item) => item.event.kind === 'query.submitted').length).toBe(2);
  exported = await activity(request);
  expect(exported.events.filter((item) => 'queryText' in item.event.payload && item.event.payload.queryText === explicitQuery)).toHaveLength(1);
  await search.fill(concept.title);
  await expect(page.getByRole('checkbox', { name: '仅本次保存查询原文', exact: true })).not.toBeChecked();
  const option = page.getByRole('listbox', { name: '概念搜索结果', exact: true }).getByRole('option')
    .filter({ has: page.getByText(concept.title, { exact: true }) });
  await expect(option).toHaveCount(1);
  await option.click();
  await expect(page.locator('.detail-head h2')).toHaveText(concept.title);

  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let metadata: KnowledgeReferences | undefined;
  await page.route('**/api/knowledge/references?*', async route => {
    const fetched = await route.fetch(); metadata = await fetched.json() as KnowledgeReferences;
    await hold; await route.fulfill({ response: fetched, json: metadata });
  });
  try {
    await page.getByRole('button', { name: '打开大窗阅读', exact: true }).click();
    const reader = page.getByRole('dialog', { name: concept.title, exact: true });
    await expect(reader).toBeVisible();
    await expect.poll(async () => (await activity(request)).events.filter((item) => item.event.kind === 'reader.opened').length).toBe(1);
    expect((await activity(request)).events.filter((item) => item.event.kind === 'content.visible')).toEqual([]);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    release();
    await expect(reader.getByRole('navigation', { name: '资料目录', exact: true })).toBeVisible();
    await expect(reader.locator('[data-knowledge-block]').first()).toBeAttached();
    expect((await activity(request)).events.filter((item) => item.event.kind === 'content.visible')).toEqual([]);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(async () => (await activity(request)).events.filter((item) => item.event.kind === 'content.visible').length).toBeGreaterThan(0);
    exported = await activity(request);
    const visible = exported.events.filter((item) => item.event.kind === 'content.visible');
    const catalog = new Map(metadata!.blocks!.filter((item) => item.contentPart === 'body').map((item) => [item.blockId, item]));
    expect(catalog.size).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const record of visible) {
      expect(record.event.refs.length).toBeGreaterThan(0); expect(record.event.refs.length).toBeLessThanOrEqual(50);
      for (const [index, ref] of record.event.refs.entries()) {
        const block = catalog.get(ref.blockId!);
        expect(block).toBeTruthy();
        expect(ref.conceptId).toBe(concept.id); expect(ref.sourceRevision).toBe(concept.source.revision);
        expect(ref.contentPart).toBe('body'); expect(ref.bodyRange).toEqual(block!.bodyRange);
        expect(record.referenceInspections[index]?.status).toBe('current');
        expect(seen.has(ref.blockId!)).toBeFalsy(); seen.add(ref.blockId!);
      }
    }
    await reader.getByRole('button', { name: '关闭阅读窗口', exact: true }).click();
  } finally { release(); }
  history = await clearHistory(page);
  await history.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(history.getByText('此范围暂无查阅记录。', { exact: true })).toBeVisible();
  expect((await activity(request)).events).toEqual([]);
  expect((await activity(request)).deliveries).toEqual([]);
  await history.getByRole('button', { name: '关闭查阅记录', exact: true }).click();
  expect((await activity(request)).events).toEqual([]); // Closing does not resurrect the cleared operation.
  expect(await learning(request)).toEqual(beforeLearning);
});
