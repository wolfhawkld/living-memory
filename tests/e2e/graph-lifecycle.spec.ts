import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { chooseDomain, domainIdOf } from '../../src/core/domain-view';
import type { Snapshot } from '../../src/shared/types';

const TITLE = '图谱生命周期测试概念';
const BODY = '这是用于图谱暂停与恢复验证的纯文字资料。阅读窗口不会保存学习记录。';
const WEBGL_CANVAS = '.graph-canvas .scene-container > canvas:first-of-type';

interface FrameSample {
  pending: number;
  executions: number;
  labelMutations: number;
}

interface LifecycleProbe {
  read(): FrameSample;
  sampleFrames(count: number): Promise<FrameSample[]>;
  observeLabels(): void;
}

type ProbeWindow = Window & typeof globalThis & { __graphLifecycleProbe: LifecycleProbe };

async function readProbe(page: Page): Promise<FrameSample> {
  return page.evaluate(() => (window as ProbeWindow).__graphLifecycleProbe.read());
}

async function sampleFrames(page: Page): Promise<FrameSample[]> {
  return page.evaluate(() => (window as ProbeWindow).__graphLifecycleProbe.sampleFrames(6));
}

async function expectStopped(page: Page): Promise<FrameSample> {
  await expect.poll(async () => (await readProbe(page)).pending).toBe(0);
  const before = await readProbe(page);
  const samples = await sampleFrames(page);
  for (const sample of samples) expect(sample).toEqual(before);
  return before;
}

test('reader pauses graph loops, repeated resume preserves the canvas, and unmount cancels callbacks', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeRequest = window.requestAnimationFrame.bind(window);
    const nativeCancel = window.cancelAnimationFrame.bind(window);
    const pending = new Set<number>();
    let executions = 0;
    let labelMutations = 0;
    let observer: MutationObserver | null = null;
    window.requestAnimationFrame = (callback) => {
      const id = nativeRequest((timestamp) => {
        pending.delete(id);
        executions += 1;
        callback.call(window, timestamp);
      });
      pending.add(id);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      pending.delete(id);
      nativeCancel(id);
    };
    const read = (): FrameSample => ({ pending: pending.size, executions, labelMutations });
    (window as ProbeWindow).__graphLifecycleProbe = {
      read,
      sampleFrames(count) {
        return new Promise((resolve) => {
          const samples: FrameSample[] = [];
          const sample = () => {
            samples.push(read());
            if (samples.length >= count) resolve(samples);
            else nativeRequest(sample);
          };
          // Sampling uses the original RAF so it never changes application counts.
          nativeRequest(sample);
        });
      },
      observeLabels() {
        observer?.disconnect();
        const labels = document.querySelector('[data-graph-label-layer="true"]');
        if (!labels) throw new Error('Graph labels are missing');
        observer = new MutationObserver((records) => { labelMutations += records.length; });
        observer.observe(labels, { attributes: true, childList: true, characterData: true, subtree: true });
      },
    };
  });
  // Replace only the browser response; the isolated fixture's knowledge files stay intact.
  await page.route('**/api/snapshot*', async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json() as Snapshot;
    const domainId = chooseDomain(snapshot);
    const target = snapshot.concepts.find((concept) => domainIdOf(concept) === domainId);
    if (!target) throw new Error('Synthetic lifecycle test requires an initial-domain concept');
    await route.fulfill({ response, json: {
      ...snapshot,
      concepts: snapshot.concepts.map((concept) => concept.id === target.id
        ? { ...concept, title: TITLE, aliases: [], summary: BODY, body: BODY }
        : concept),
    } });
  });

  await page.goto('/');
  const host = page.locator('.graph-canvas');
  const canvas = page.locator(WEBGL_CANVAS);
  await expect(canvas).toBeVisible();
  await expect(host).toHaveAttribute('data-layout-ready', 'true');
  const realMode = page.getByRole('button', { name: '查看真实记录', exact: true });
  const demoMode = page.getByRole('button', { name: '查看示例状态', exact: true });
  await expect(realMode.or(demoMode)).toBeVisible();
  if (await realMode.isVisible()) await realMode.click();
  await expect(demoMode).toBeVisible();
  await expect(host).toHaveAttribute('data-layout-ready', 'true');
  const search = page.getByRole('combobox', { name: '搜索概念', exact: true });
  await search.fill(TITLE);
  await page.getByRole('listbox').getByRole('option').filter({ hasText: TITLE }).first().click();
  await expect(page.locator('.detail-head h2')).toHaveText(TITLE);
  await page.evaluate(() => (window as ProbeWindow).__graphLifecycleProbe.observeLabels());

  await expect.poll(async () => {
    const samples = await sampleFrames(page);
    return samples[0].pending > 0 && samples.every((sample) => sample.pending === samples[0].pending)
      && samples.at(-1)!.executions > samples[0].executions
      && samples.at(-1)!.labelMutations > samples[0].labelMutations;
  }).toBe(true);
  const baseline = (await readProbe(page)).pending;
  expect(baseline).toBeGreaterThan(0);
  const originalCanvas = await canvas.elementHandle();
  expect(originalCanvas).not.toBeNull();

  for (let cycle = 0; cycle < 2; cycle += 1) {
    await page.getByRole('button', { name: '打开大窗阅读' }).click();
    const reader = page.getByRole('dialog', { name: TITLE, exact: true });
    await expect(reader).toBeVisible();
    await expect(reader.getByRole('region', { name: '完整资料正文' })).toHaveText(BODY);
    const stopped = await expectStopped(page);
    await page.getByRole('button', { name: '关闭阅读窗口' }).click();
    await expect(reader).toBeHidden();
    await expect.poll(async () => {
      const samples = await sampleFrames(page);
      return samples.every((sample) => sample.pending === baseline)
        && samples.at(-1)!.executions > stopped.executions
        && samples.at(-1)!.labelMutations > stopped.labelMutations;
    }).toBe(true);
    expect(await originalCanvas!.evaluate((element, selector) => (
      element.isConnected && element === document.querySelector(selector)
    ), WEBGL_CANVAS)).toBe(true);
  }

  await page.getByRole('button', { name: '文字列表', exact: true }).click();
  await expect(canvas).toHaveCount(0);
  expect(await originalCanvas!.evaluate((element) => element.isConnected)).toBe(false);
  await expectStopped(page);

  await page.getByRole('button', { name: '返回图谱', exact: true }).click();
  await expect(canvas).toBeVisible();
  await expect(host).toHaveAttribute('data-layout-ready', 'true');
  await page.evaluate(() => (window as ProbeWindow).__graphLifecycleProbe.observeLabels());
  await expect.poll(async () => {
    const samples = await sampleFrames(page);
    return samples.every((sample) => sample.pending === baseline)
      && samples.at(-1)!.executions > samples[0].executions
      && samples.at(-1)!.labelMutations > samples[0].labelMutations;
  }).toBe(true);
  expect(await originalCanvas!.evaluate((element, selector) => (
    element === document.querySelector(selector)
  ), WEBGL_CANVAS)).toBe(false);
});
