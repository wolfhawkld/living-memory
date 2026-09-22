import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createDemoRecord, projectDemoSnapshot, type DemoRecord } from '../../src/core/demo-snapshot';
import { domainIdOf, domainLabel } from '../../src/core/domain-view';
import type { ExportData, Snapshot } from '../../src/shared/types';

type DemoExport = {
  kind: 'living-memory-demo';
  record: DemoRecord;
  preview: {
    offsetDays: number;
    asOf: string;
    states: Record<string, { status: string; decay: number | null; elapsedDays: number | null }>;
  };
};

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

async function selectConcept(page: Page, title: string, domainId?: string) {
  const search = page.getByRole('combobox', { name: '搜索概念', exact: true });
  await search.fill(title);
  const result = page.getByRole('listbox').getByRole('option').filter({ hasText: title }).first();
  await expect(result).toBeVisible();
  await result.click();
  if (domainId) {
    await expect(page.getByRole('combobox', { name: '知识域', exact: true })).toHaveValue(domainId);
  }
  await expect(page.locator('.detail-head h2')).toHaveText(title);
}

async function enterRealMode(page: Page) {
  const realButton = page.getByRole('button', { name: '查看真实记录', exact: true });
  const demoButton = page.getByRole('button', { name: '查看示例状态', exact: true });
  await expect(realButton.or(demoButton)).toBeVisible();
  if (await realButton.isVisible()) await realButton.click();
  await expect(page.getByRole('button', { name: '查看示例状态', exact: true })).toBeVisible();
  await expect(page.locator('.demo-panel')).toBeHidden();
}

async function enterDemoMode(page: Page) {
  const demoButton = page.getByRole('button', { name: '查看示例状态', exact: true });
  const realButton = page.getByRole('button', { name: '查看真实记录', exact: true });
  await expect(demoButton.or(realButton)).toBeVisible();
  if (await demoButton.isVisible()) await demoButton.click();
  await expect(page.getByRole('button', { name: '查看真实记录', exact: true })).toBeVisible();
  await expect(page.locator('.demo-panel')).toBeVisible();
}

async function demoDownload(page: Page): Promise<DemoExport> {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出模拟记录', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  return JSON.parse(await readFile(path!, 'utf8')) as DemoExport;
}

async function expectTimeIndicator(page: Page, value: string) {
  await expect(page.locator('.right-panel .time-indicator strong')).toHaveText(value);
}

async function graphBackgroundPixel(page: Page) {
  const screenshot = await page.locator('.graph-canvas').screenshot();
  return page.evaluate(async ({ base64, x, y }: { base64: string; x: number; y: number }) => {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const next = new Image();
      next.onload = () => resolve(next);
      next.onerror = () => reject(new Error('无法解码图谱截图。'));
      next.src = `data:image/png;base64,${base64}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context || image.naturalWidth <= x || image.naturalHeight <= y) {
      throw new Error('图谱截图尺寸不足，无法采样背景。');
    }
    context.drawImage(image, 0, 0);
    const data = context.getImageData(x, y, 1, 1).data;
    return { r: data[0], g: data[1], b: data[2], a: data[3] };
  }, { base64: screenshot.toString('base64'), x: 10, y: 10 });
}

function expectGraphBackground(pixel: { r: number; g: number; b: number; a: number }) {
  expect(pixel.a).toBe(255);
  expect(Math.abs(pixel.r - 7)).toBeLessThanOrEqual(5);
  expect(Math.abs(pixel.g - 12)).toBeLessThanOrEqual(5);
  expect(Math.abs(pixel.b - 24)).toBeLessThanOrEqual(5);
}

test('demo glow toggle keeps the graph background and canvas visible', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '查看真实记录', exact: true })).toBeVisible();
  await expect(page.locator('.demo-panel')).toBeVisible();
  await expect(page.locator('.graph-canvas')).toHaveAttribute('data-layout-ready', 'true');

  const glowButton = page.getByRole('button', { name: '发光效果', exact: true });
  await expect(glowButton).toHaveAttribute('aria-pressed', 'true');
  expectGraphBackground(await graphBackgroundPixel(page));
  await glowButton.click();
  await expect(glowButton).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.graph-canvas')).toBeVisible();
  expectGraphBackground(await graphBackgroundPixel(page));
  await glowButton.click();
  await expect(glowButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.graph-canvas')).toBeVisible();
  expectGraphBackground(await graphBackgroundPixel(page));
});

test('demo mode shows the seeded time stages and persists its source-scoped preview', async ({ page, request }) => {
  const realBefore = await exported(request);
  const sourceResponse = await request.get('/api/session');
  expect(sourceResponse.ok()).toBeTruthy();
  const sourceId = (await sourceResponse.json() as { sourceId: string }).sourceId;

  await page.goto('/');
  await expect(page.getByRole('button', { name: '查看真实记录', exact: true })).toBeVisible();
  const demoPanel = page.locator('.demo-panel');
  await expect(demoPanel).toBeVisible();
  const domainPicker = page.getByRole('combobox', { name: '知识域', exact: true });
  await expect(domainPicker).toBeVisible();
  const currentDomainId = await domainPicker.inputValue();
  const sourceSnapshot = await snapshot(request);
  const currentDomainConcepts = sourceSnapshot.concepts.filter((concept) => domainIdOf(concept) === currentDomainId);
  const demoProjection = projectDemoSnapshot(sourceSnapshot, createDemoRecord(sourceSnapshot, sourceId, sourceSnapshot.asOf));
  const statusCounts = currentDomainConcepts.reduce((counts, concept) => {
    const status = demoProjection.states[concept.id]?.status;
    if (status) counts[status] += 1;
    return counts;
  }, { recent: 0, revisit: 0, stale: 0, unknown: 0, pending: 0, retained: 0 });
  const statusLabels = { recent: '近期重温', revisit: '建议再看', stale: '较久未重温', unknown: '尚未评估', pending: '待确认' } as const;
  for (const status of Object.keys(statusLabels) as Array<keyof typeof statusLabels>) {
    const row = demoPanel.locator(`.demo-count[data-status="${status}"]`);
    const count = statusCounts[status];
    if (status !== 'pending' || count > 0) {
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(statusLabels[status]);
      await expect(row).toContainText(String(count));
    } else {
      await expect(row).toHaveCount(0);
    }
  }
  await expect(page.locator('.graph-canvas')).toHaveAttribute('data-layout-ready', 'true');
  await page.screenshot({ path: 'test-results/p0-demo-colors.png', fullPage: true });
  await expect(demoPanel.locator('details summary')).toHaveText('查看初始模拟数值');
  await demoPanel.locator('details summary').click();
  const table = demoPanel.locator('details table');
  await expect(table).toBeVisible();
  await expect(table.locator('thead')).toContainText('概念');
  await expect(table.locator('thead')).toContainText('初始间隔');
  await expect(table.locator('thead')).toContainText('当前间隔');
  await expect(table.locator('thead')).toContainText('时间指标 D');
  await expect(table.locator('thead')).toContainText('颜色状态');
  await expect(table.locator('tbody tr')).toHaveCount(currentDomainConcepts.length);
  await page.screenshot({ path: 'test-results/p0-demo-values.png', fullPage: true });

  const concepts = sourceSnapshot.concepts.slice().sort((left, right) => left.id.localeCompare(right.id));
  const seeded = [0, 3, 7, 10, 14, 21, 28, null] as const;
  const initialByTitle = new Map(concepts.map((concept, index) => [concept.title, seeded[index % seeded.length]]));
  expect(initialByTitle.size).toBe(16);

  const atZero = concepts.find((concept) => initialByTitle.get(concept.title) === 0)!;
  const atHalf = concepts.find((concept) => initialByTitle.get(concept.title) === 7)!;
  const atDouble = concepts.find((concept) => initialByTitle.get(concept.title) === 14)!;
  const unknown = concepts.find((concept) => initialByTitle.get(concept.title) === null)!;

  await selectConcept(page, atZero.title, domainIdOf(atZero));
  await expect(page.locator('.right-panel .status-badge')).toHaveClass(/status-recent/);
  await expectTimeIndicator(page, '1.000');
  await selectConcept(page, atHalf.title, domainIdOf(atHalf));
  await expect(page.locator('.right-panel .status-badge')).toHaveClass(/status-revisit/);
  await expectTimeIndicator(page, '0.500');
  await selectConcept(page, atDouble.title, domainIdOf(atDouble));
  await expect(page.locator('.right-panel .status-badge')).toHaveClass(/status-stale/);
  await expectTimeIndicator(page, '0.250');
  await selectConcept(page, unknown.title, domainIdOf(unknown));
  await expect(page.locator('.right-panel .status-badge')).toHaveClass(/status-unknown/);
  await expect(page.locator('.right-panel .time-indicator')).toContainText('未知');

  const slider = page.getByRole('slider', { name: '模拟时间，单位天' });
  await slider.fill('7');
  await expect(slider).toHaveValue('7');
  await selectConcept(page, atZero.title, domainIdOf(atZero));
  await expect(page.locator('.right-panel .status-badge')).toHaveClass(/status-revisit/);
  await expectTimeIndicator(page, '0.500');
  await selectConcept(page, atHalf.title, domainIdOf(atHalf));
  await expect(page.locator('.right-panel .status-badge')).toHaveClass(/status-stale/);
  await expectTimeIndicator(page, '0.250');
  await selectConcept(page, unknown.title, domainIdOf(unknown));
  await expect(page.locator('.right-panel .status-badge')).toHaveClass(/status-unknown/);
  await expect(page.locator('.right-panel .time-indicator')).toContainText('未知');

  const stored = await page.evaluate(() => Object.entries(localStorage));
  expect(stored.some(([key, value]) => key.includes(sourceId) || value.includes(sourceId))).toBe(true);
  await page.reload();
  await expect(page.getByRole('button', { name: '查看真实记录', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: '模拟时间，单位天' })).toHaveValue('7');
  await selectConcept(page, atZero.title, domainIdOf(atZero));
  await expectTimeIndicator(page, '0.500');

  await enterRealMode(page);
  await expect(page.getByRole('slider', { name: '模拟时间，单位天' })).toHaveValue('0');
  const realAfter = await exported(request);
  expect(realAfter.anchors).toEqual(realBefore.anchors);
  expect(realAfter.observations).toEqual(realBefore.observations);
  expect(realAfter.config).toEqual(realBefore.config);
  expect(realAfter.layout).toEqual(realBefore.layout);
  await page.reload();
  await expect(page.getByRole('button', { name: '查看示例状态', exact: true })).toBeVisible();
  await enterDemoMode(page);
  await expect(page.getByRole('slider', { name: '模拟时间，单位天' })).toHaveValue('7');
});

test('demo export stays isolated and graph relations remain visible through time projection', async ({ page, request }) => {
  const realBefore = await exported(request);
  await page.goto('/');
  await expect(page.locator('.demo-panel')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(1_500);

  const canvas = page.locator('.graph-canvas');
  await expect(canvas).toHaveAttribute('data-edge-count', /\d+/);
  await expect(canvas).toHaveAttribute('data-selected-edge-count', '0');
  await expect(page.locator('.detail-head')).toHaveCount(0);
  const linkCount = Number(await canvas.getAttribute('data-edge-count'));
  expect(linkCount).toBeGreaterThan(0);

  const sourceSnapshot = await snapshot(request);
  const selectedConcept = sourceSnapshot.concepts.find((concept) => concept.title === '内积')!;
  const search = page.getByRole('combobox', { name: '搜索概念', exact: true });
  await search.fill(selectedConcept.title);
  const result = page.getByRole('listbox').getByRole('option').filter({ hasText: selectedConcept.title }).first();
  await expect(result).toContainText(selectedConcept.title);
  await expect(result).toContainText(domainLabel(domainIdOf(selectedConcept)));
  await expect(canvas).toHaveAttribute('data-selected-edge-count', '0');
  await expect(page.locator('.detail-head')).toHaveCount(0);
  await result.click();
  await expect(page.locator('.detail-head h2')).toHaveText(selectedConcept.title);
  await expect(canvas).toHaveAttribute('data-selected-edge-count', /[1-9]\d*/);
  const highlightedCount = Number(await canvas.getAttribute('data-selected-edge-count'));
  expect(highlightedCount).toBeGreaterThan(0);

  const selectedDomainId = domainIdOf(selectedConcept);
  const otherDomainId = sourceSnapshot.concepts
    .map((concept) => domainIdOf(concept))
    .find((domainId) => domainId !== selectedDomainId);
  expect(otherDomainId).toBeTruthy();
  const domainPicker = page.getByRole('combobox', { name: '知识域', exact: true });
  await domainPicker.selectOption(otherDomainId!);
  await expect(domainPicker).toHaveValue(otherDomainId!);
  await expect(canvas).toHaveAttribute('data-selected-edge-count', '0');
  await expect(page.locator('.detail-head')).toHaveCount(0);

  await selectConcept(page, selectedConcept.title, selectedDomainId);
  await expect(canvas).toHaveAttribute('data-selected-edge-count', String(highlightedCount));

  const slider = page.getByRole('slider', { name: '模拟时间，单位天' });
  await slider.fill('7');
  await expect(canvas).toHaveAttribute('data-edge-count', String(linkCount));
  await expect(canvas).toHaveAttribute('data-selected-edge-count', String(highlightedCount));
  await page.waitForTimeout(1_500);

  const demoData = await demoDownload(page);
  expect(demoData.kind).toBe('living-memory-demo');
  expect(demoData.record).toEqual(expect.objectContaining({
    mode: 'demo',
    modelVersion: 'time-only-v0',
    halfLifeDays: 7,
    sourceId: expect.any(String),
  }));
  expect(demoData.record.assignments).toBeDefined();
  expect((demoData.record.assignments as unknown[]).length).toBe(16);
  expect(demoData.preview.offsetDays).toBe(7);
  expect(demoData.preview.asOf).toEqual(expect.any(String));
  expect(Object.keys(demoData.preview.states)).toHaveLength(16);
  expect(demoData.preview.states[Object.keys(demoData.preview.states)[0]]).toEqual(expect.objectContaining({ status: expect.any(String) }));

  await page.waitForTimeout(1_500);
  const realAfter = await exported(request);
  expect(realAfter.anchors).toEqual(realBefore.anchors);
  expect(realAfter.observations).toEqual(realBefore.observations);
  expect(realAfter.config).toEqual(realBefore.config);
  expect(realAfter.layout).toEqual(realBefore.layout);

  await enterRealMode(page);
  await selectConcept(page, '内积');
  await expect(page.locator('.right-panel .status-badge')).toHaveClass(/status-unknown/);
  await expect(page.locator('.right-panel .time-indicator')).toContainText('未知');
  await enterDemoMode(page);
  await expect(page.getByRole('slider', { name: '模拟时间，单位天' })).toHaveValue('7');
});

test('an older partial demo record is extended once and remains isolated from real records', async ({ page, request }) => {
  const realBefore = await exported(request);
  const sourceResponse = await request.get('/api/session');
  expect(sourceResponse.ok()).toBeTruthy();
  const sourceId = (await sourceResponse.json() as { sourceId: string }).sourceId;
  const sourceSnapshot = await snapshot(request);
  expect(sourceSnapshot.concepts).toHaveLength(16);

  const baseAsOf = '2026-09-01T00:00:00.000Z';
  const generatedAt = '2026-09-02T03:04:05.000Z';
  const completeRecord = createDemoRecord(sourceSnapshot, sourceId, baseAsOf);
  const oldAssignments = completeRecord.assignments.slice(0, 8);
  const oldUnknown = oldAssignments.find((assignment) => assignment.elapsedDays === null);
  expect(oldUnknown).toBeDefined();
  const partialRecord: DemoRecord = {
    ...completeRecord,
    generatedAt,
    baseAsOf,
    assignments: oldAssignments,
  };
  const recordKey = `living-memory.demo-record.v1.${sourceId}`;

  await page.addInitScript(({ record, sourceId, recordKey }) => {
    if (window.localStorage.getItem(recordKey)) return;
    window.localStorage.setItem(recordKey, JSON.stringify(record));
    window.localStorage.setItem(`living-memory.demo-enabled.v1.${sourceId}`, 'true');
    window.localStorage.setItem(`living-memory.demo-offset.v1.${sourceId}`, '7');
  }, { record: partialRecord, sourceId, recordKey });

  await page.goto('/');
  await expect(page.locator('.demo-panel')).toBeVisible();
  await expect(page.getByRole('slider', { name: '模拟时间，单位天' })).toHaveValue('7');
  const loaded = await demoDownload(page);
  expect(loaded.preview.offsetDays).toBe(7);
  expect(loaded.record.sourceId).toBe(sourceId);
  expect(loaded.record.generatedAt).toBe(generatedAt);
  expect(loaded.record.baseAsOf).toBe(baseAsOf);
  expect(loaded.record.assignments.slice(0, oldAssignments.length)).toEqual(oldAssignments);
  expect(loaded.record.assignments).toHaveLength(16);
  expect(loaded.record.assignments.map((assignment) => assignment.conceptId).sort()).toEqual(
    sourceSnapshot.concepts.map((concept) => concept.id).sort(),
  );
  expect(loaded.record.assignments.some((assignment) => assignment.conceptId === oldUnknown!.conceptId && assignment.elapsedDays === null)).toBe(true);
  expect(loaded.preview.states[oldUnknown!.conceptId]).toEqual(expect.objectContaining({
    status: 'unknown',
    decay: null,
    elapsedDays: null,
  }));

  await page.reload();
  await expect(page.locator('.demo-panel')).toBeVisible();
  await expect(page.getByRole('slider', { name: '模拟时间，单位天' })).toHaveValue('7');
  const reloaded = await demoDownload(page);
  expect(reloaded.record).toEqual(loaded.record);
  expect(reloaded.preview.offsetDays).toBe(7);
  expect(reloaded.preview.asOf).toBe(loaded.preview.asOf);

  // Let any normal layout debounce settle while the graph is still read-only demo mode.
  await page.waitForTimeout(1_500);
  const realAfter = await exported(request);
  expect(realAfter.anchors).toEqual(realBefore.anchors);
  expect(realAfter.observations).toEqual(realBefore.observations);
  expect(realAfter.config).toEqual(realBefore.config);
  expect(realAfter.layout).toEqual(realBefore.layout);
});

test('real WebGL, lookup, review, simulated time and reload form one persistent workflow', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const initial = await snapshot(request);
  expect(initial.concepts).toHaveLength(16);
  expect(Object.values(initial.states).every((state) => state.status === 'unknown')).toBe(true);
  const concept = initial.concepts.find((item) => item.title === '内积')!;
  await page.goto('/');
  await enterRealMode(page);
  await expect(page.locator('.graph-stage canvas')).toBeVisible();
  await selectConcept(page, concept.title);
  await expect(page.locator('.right-panel .status-badge')).toContainText('尚未');
  await page.getByRole('button', { name: '打开大窗阅读' }).click();
  await expect(page.getByRole('dialog', { name: concept.title })).toBeVisible();
  await page.getByRole('button', { name: '关闭阅读窗口' }).click();
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
  await enterRealMode(page);
  await selectConcept(page, concept.title);
  await expect(page.locator('.right-panel .status-badge')).toHaveText('近期重温');
  expect((await snapshot(request)).states[concept.id].anchor?.eventId).toBe(anchor.eventId);
  await page.getByRole('combobox', { name: '搜索概念', exact: true }).fill('');
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
  await enterRealMode(page);
  await selectConcept(page, concept.title);
  await page.getByRole('button', { name: /先想一句/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('.graph-stage')).toBeHidden();
  await expect(page.getByText(concept.summary, { exact: true })).toBeHidden();
  await page.getByRole('textbox', { name: '回忆答案' }).fill('后验概率与似然和先验的乘积成比例，并需要归一化。');
  await page.getByRole('button', { name: '提交回答，查看资料' }).click();
  await page.getByRole('button', { name: '能解释', exact: true }).click();
  await page.locator('.exposure-options select').selectOption('unexposed');
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
  await page.locator('.exposure-options select').selectOption('unexposed');
  await page.getByRole('button', { name: '保存这次观察' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  const observations = (await exported(request)).observations.filter((item) => item.conceptId === concept.id);
  expect(observations.some((item) => item.observedExposure && item.exposure === 'exposed')).toBe(true);
});

test('estimated dates remain labelled and export preserves versioned data', async ({ page, request }) => {
  const concept = (await snapshot(request)).concepts.find((item) => item.title === '向量')!;
  await page.goto('/');
  await enterRealMode(page);
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
  await enterRealMode(page);
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
