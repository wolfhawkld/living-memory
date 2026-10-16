import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import type { GraphPerformanceReport } from '../../src/web/graph-performance';

// Deliberately use the base fixture: this public synthetic route must not run
// the authenticated fixture's automatic account/session requests.
test('synthetic benchmark accepts configuration and pointer input, exports an aborted sample and restarts without extra canvases', async ({ page }) => {
  const privateRequests: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/api' || path.startsWith('/api/')) privateRequests.push(`${request.method()} ${request.url()}`);
  });
  await page.route('**/api/**', route => route.abort());
  await page.goto('/performance');
  await expect(page.getByRole('heading', { name: '图谱渲染采样', exact: true })).toBeVisible();
  await expect(page.getByText('300 个节点 · 1000 条边 · 每轮重建图谱实例', { exact: true })).toBeVisible();
  expect(privateRequests).toEqual([]);

  const configuration = page.getByRole('region', { name: '性能采样配置', exact: true });
  const darkPanel = await configuration.evaluate(element => getComputedStyle(element).backgroundColor);
  expect(darkPanel).not.toMatch(/rgba\(0,\s*0,\s*0,\s*0\)/);
  await configuration.getByRole('combobox', { name: '视图', exact: true }).selectOption('2d');
  await configuration.getByRole('combobox', { name: '主题', exact: true }).selectOption('light');
  await configuration.getByRole('combobox', { name: '渲染档位', exact: true }).selectOption('low');
  await configuration.getByRole('combobox', { name: '光效', exact: true }).selectOption('off');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const lightPanel = await configuration.evaluate(element => getComputedStyle(element).backgroundColor);
  expect(lightPanel).not.toMatch(/rgba\(0,\s*0,\s*0,\s*0\)/);
  expect(lightPanel).not.toBe(darkPanel);
  const quick = page.getByRole('button', { name: '快速采样：10 秒 × 3 轮', exact: true });
  const stop = page.getByRole('button', { name: '停止采样', exact: true });
  const viewport = page.locator('.performance-viewport');
  await expect(viewport.locator('canvas')).toHaveCount(1);
  await quick.click();
  await expect(page.locator('.performance-progress')).toContainText('第 1/3 轮：预热 2 秒');
  await expect(viewport).toHaveAttribute('data-running', 'true');
  await expect(configuration.getByRole('combobox', { name: '视图', exact: true })).toBeDisabled();
  await expect(stop).toBeEnabled();

  // Exercise the actual live canvas while sampling. No timing/GPU-speed
  // threshold is inferred from whether these pointer events are accepted.
  const canvas = viewport.locator('canvas');
  await expect(canvas).toHaveCount(1);
  await expect(canvas).toBeVisible();
  const activeCanvas = await canvas.elementHandle();
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-test-performance-pointer-count', '0');
    const observed = (event: Event) => {
      if (!(event.target instanceof HTMLCanvasElement) || !event.target.closest('.performance-viewport')) return;
      const root = document.documentElement;
      root.setAttribute('data-test-performance-pointer-count', String(Number(root.getAttribute('data-test-performance-pointer-count')) + 1));
    };
    // The document survives a natural round remount on slower CI machines.
    for (const event of ['pointerdown', 'pointermove', 'wheel']) document.addEventListener(event, observed, { capture: true });
  });
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  await canvas.click({ position: { x: bounds!.width / 2, y: bounds!.height / 2 } });
  const visibleBounds = await canvas.boundingBox();
  expect(visibleBounds).not.toBeNull();
  await page.mouse.move(visibleBounds!.x + visibleBounds!.width / 2, visibleBounds!.y + visibleBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(visibleBounds!.x + visibleBounds!.width / 2 + 35, visibleBounds!.y + visibleBounds!.height / 2 + 20, { steps: 4 });
  await page.mouse.up();
  await page.mouse.wheel(0, -80);
  await expect.poll(async () => Number(await page.locator('html').getAttribute('data-test-performance-pointer-count'))).toBeGreaterThan(0);

  await stop.click();
  await expect(viewport).toHaveAttribute('data-running', 'false');
  await expect(quick).toBeEnabled();
  await expect(stop).toBeDisabled();
  const results = page.getByRole('region', { name: '采样结果', exact: true });
  await expect(results).toContainText('未完成：aborted');
  const resultsHeading = results.getByRole('heading', { name: '采样结果', exact: true });
  await resultsHeading.scrollIntoViewIfNeeded();
  await expect(resultsHeading).toBeInViewport();
  expect(await page.locator('.performance-benchmark').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(viewport.locator('canvas')).toHaveCount(1);
  expect(await activeCanvas!.evaluate(element => element.isConnected)).toBe(false);
  await activeCanvas!.dispose();

  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出采样 JSON', exact: true }).click();
  const download = await downloadReady;
  expect(download.suggestedFilename()).toBe('living-memory-performance.json');
  const path = await download.path();
  expect(path).not.toBeNull();
  const exported = JSON.parse(await readFile(path!, 'utf8')) as {
    format: string; version: number; fixture: { id: string; nodes: number; edges: number };
    results: { report: GraphPerformanceReport }[];
  };
  expect(exported.format).toBe('living-memory-performance-benchmark');
  expect(exported.version).toBe(1);
  expect(exported.fixture).toEqual({ id: 'synthetic-300n-1000e-v1', nodes: 300, edges: 1000 });
  expect(exported.results.length).toBeGreaterThanOrEqual(1);
  expect(exported.results.length).toBeLessThanOrEqual(3);
  for (const prior of exported.results.slice(0, -1)) expect(prior.report.status).toBe('complete');
  const lastReport = exported.results.at(-1)!.report;
  expect(lastReport.status).toBe('incomplete');
  expect(lastReport.reason).toBe('aborted');
  expect(lastReport.timing.requestedWarmupMs).toBe(2000);
  expect(lastReport.timing.requestedDurationMs).toBe(10000);
  expect(lastReport.before.context).toMatchObject({ viewMode: '2d', theme: 'light', quality: 'low', glowEnabled: false, canvasCount: 1 });
  expect(privateRequests).toEqual([]);

  await quick.click();
  await expect(viewport).toHaveAttribute('data-running', 'true');
  await expect(page.locator('.performance-progress')).toContainText('第 1/3 轮：预热 2 秒');
  await expect(viewport.locator('canvas')).toHaveCount(1);
  await stop.click();
  await expect(quick).toBeEnabled();
  await expect(viewport).toHaveAttribute('data-running', 'false');
  await expect(viewport.locator('canvas')).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(privateRequests).toEqual([]);
});
