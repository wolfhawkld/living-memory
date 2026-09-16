import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import type { ExportData, Snapshot } from '../../src/shared/types';

async function snapshot(request: APIRequestContext): Promise<Snapshot> {
  const response = await request.get('/api/snapshot');
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function exported(request: APIRequestContext): Promise<ExportData> {
  const response = await request.get('/api/export');
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function selectConcept(page: Page, title: string) {
  await page.getByRole('textbox', { name: '搜索概念' }).fill(title);
  await page.locator('.concept-list button').filter({ has: page.locator('strong', { hasText: title }) }).first().click();
  await expect(page.locator('.detail-head h2')).toHaveText(title);
}

test('real WebGL, lookup, review, simulated time and reload form one persistent workflow', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const initial = await snapshot(request);
  expect(initial.concepts).toHaveLength(16);
  expect(Object.values(initial.states).every((state) => state.status === 'unknown')).toBe(true);
  const concept = initial.concepts.find((item) => item.title === '内积')!;
  await page.goto('/');
  await expect(page.locator('.graph-stage canvas')).toBeVisible();
  await selectConcept(page, concept.title);
  await expect(page.locator('.right-panel .status-badge')).toContainText('尚未');
  await page.getByRole('button', { name: '打开来源与摘要' }).click();
  await expect(page.locator('.right-panel .source-path')).toContainText('内积.md');
  expect((await exported(request)).anchors).toHaveLength(0);

  await page.getByRole('button', { name: '确认已重温', exact: true }).click();
  await expect(page.locator('.right-panel .status-badge')).toHaveText('近期重温');
  const anchor = (await exported(request)).anchors.find((event) => event.conceptId === concept.id)!;
  expect(anchor.kind).toBe('review');

  const slider = page.getByRole('slider', { name: '模拟时间，单位天' });
  await slider.focus();
  await slider.press('End');
  await expect(page.getByText('模拟中 · 不写入')).toBeVisible();
  await expect(page.locator('.right-panel .status-badge')).toHaveText('较久未重温');
  await expect(page.getByRole('button', { name: '确认已重温', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '补记过去重温' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /先想一句/ })).toBeDisabled();
  expect((await exported(request)).anchors).toHaveLength(1);

  await page.getByRole('button', { name: '恢复实时' }).click();
  await expect(page.locator('.right-panel .status-badge')).toHaveText('近期重温');
  await page.reload();
  await selectConcept(page, concept.title);
  await expect(page.locator('.right-panel .status-badge')).toHaveText('近期重温');
  expect((await snapshot(request)).states[concept.id].anchor?.eventId).toBe(anchor.eventId);
  await page.getByRole('textbox', { name: '搜索概念' }).fill('');
  await page.getByRole('button', { name: '文字列表', exact: true }).click();
  await expect(page.locator('.graph-stage canvas')).toBeHidden();
  await page.getByRole('button', { name: '返回图谱', exact: true }).click();
  await expect(page.locator('.graph-stage canvas')).toBeVisible();
  await expect(page.locator('.graph-canvas')).toHaveAttribute('data-layout-ready', 'true');
  await page.screenshot({ path: 'test-results/p0-time-graph.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('recall hides sources, stores a frozen observation, and never resets time', async ({ page, request }) => {
  const before = await snapshot(request);
  const concept = before.concepts.find((item) => item.title === '贝叶斯定理')!;
  const recordsBefore = await exported(request);
  await page.goto('/');
  await selectConcept(page, concept.title);
  await page.getByRole('button', { name: /先想一句/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('.graph-stage')).toBeHidden();
  await expect(page.getByText(concept.summary, { exact: true })).toBeHidden();
  await page.getByRole('textbox', { name: '回忆答案' }).fill('后验概率与似然和先验的乘积成比例，并需要归一化。');
  await page.getByRole('button', { name: '提交回答，查看资料' }).click();
  await page.getByRole('button', { name: '能解释', exact: true }).click();
  await page.getByRole('combobox').selectOption('unexposed');
  await page.getByRole('button', { name: '保存这次观察' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  const records = await exported(request);
  expect(records.anchors).toEqual(recordsBefore.anchors);
  const observation = records.observations.find((item) => item.conceptId === concept.id)!;
  expect(observation.rating).toBe('clear');
  expect(observation.exposure).toBe('unexposed');
  expect(observation.anchorEventId).toBeNull();
  expect(observation.decay).toBeNull();
  expect((await snapshot(request)).states[concept.id].status).toBe('unknown');

  await page.getByRole('button', { name: /先想一句/ }).click();
  await page.getByRole('textbox', { name: '回忆答案' }).fill('第二次是在看过资料之后的重建。');
  await page.getByRole('button', { name: '提交回答，查看资料' }).click();
  await page.getByRole('button', { name: '有些模糊', exact: true }).click();
  await page.getByRole('combobox').selectOption('unexposed');
  await page.getByRole('button', { name: '保存这次观察' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  const observations = (await exported(request)).observations.filter((item) => item.conceptId === concept.id);
  expect(observations.some((item) => item.observedExposure && item.exposure === 'exposed')).toBe(true);
});

test('estimated dates remain labelled and export preserves versioned data', async ({ page, request }) => {
  const concept = (await snapshot(request)).concepts.find((item) => item.title === '向量')!;
  await page.goto('/');
  await selectConcept(page, concept.title);
  await page.getByRole('button', { name: '补记过去重温' }).click();
  const past = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel('日期', { exact: true }).fill(past);
  await page.getByRole('button', { name: '保存估计记录' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('.right-panel .status-badge')).toHaveText('较久未重温');
  await expect(page.locator('.right-panel')).toContainText('估计');
  const data = await exported(request);
  expect(data.anchors.find((event) => event.conceptId === concept.id)?.kind).toBe('estimated');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出学习数据' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/living-memory.*\.json$/);
  expect(data.config.modelVersion).toBe('time-only-v0');
  expect(data.configHistory).toHaveLength(1);
});

test('failed writes remain pending and an explicit retry preserves the original event', async ({ page, request }) => {
  const concept = (await snapshot(request)).concepts.find((item) => item.title === '正交')!;
  await page.goto('/');
  await selectConcept(page, concept.title);
  await page.route('**/api/reviews', (route) => route.abort('connectionfailed'));
  await page.getByRole('button', { name: '确认已重温', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试同步', exact: true })).toBeVisible();
  await expect(page.locator('.right-panel .status-badge')).toHaveText('待确认');
  expect((await exported(request)).anchors.some((event) => event.conceptId === concept.id)).toBe(false);
  const pending = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((item) => item.startsWith('living-memory.pending-writes.v1.'))!;
    return JSON.parse(localStorage.getItem(key)!)[0].payload;
  });
  expect(pending.eventId).toBeTruthy();
  expect(pending.occurredAt).toBeTruthy();
  await page.unroute('**/api/reviews');
  await page.getByRole('button', { name: '重试同步', exact: true }).click();
  await expect(page.locator('.right-panel .status-badge')).toHaveText('近期重温');
  const saved = (await exported(request)).anchors.filter((event) => event.conceptId === concept.id);
  expect(saved).toHaveLength(1);
  expect(saved[0].eventId).toBe(pending.eventId);
  expect(saved[0].occurredAt).toBe(pending.occurredAt);
});
