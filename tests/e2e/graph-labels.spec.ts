import { expect, test, type Page } from '@playwright/test';
import { chooseDomain, domainIdOf } from '../../src/core/domain-view';
import type { Snapshot } from '../../src/shared/types';

const LONG_TITLE = '面向图谱标签回归的超长概念标题：记忆锚点、关系上下文与可读性验证版本 2026';
const SHORT_LABEL = 'LT';

type LabelRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type VisibleLabel = {
  conceptId: string;
  kind: string;
  text: string;
  fontSize: string;
  display: string;
  overflow: string;
  lineClamp: string;
  anchorX: number | null;
  anchorY: number | null;
  rect: LabelRect;
};

type CanvasGeometry = {
  rect: LabelRect;
  labels: VisibleLabel[];
};

async function readCanvasGeometry(page: Page): Promise<CanvasGeometry> {
  return page.locator('.graph-canvas').evaluate((canvas) => {
    const canvasRect = canvas.getBoundingClientRect();
    const rect = (box: DOMRect): LabelRect => ({
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
    });
    const labels = Array.from(canvas.querySelectorAll<HTMLElement>('[data-concept-id][data-kind]'))
      .filter((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return element.dataset.visible !== 'false'
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && box.width > 0
          && box.height > 0;
      })
      .map((element): VisibleLabel => {
        const style = getComputedStyle(element);
        return {
          conceptId: element.dataset.conceptId ?? '',
          kind: element.dataset.kind ?? '',
          text: element.textContent ?? '',
          fontSize: style.fontSize,
          display: style.display,
          overflow: style.overflow,
          lineClamp: style.getPropertyValue('-webkit-line-clamp'),
          anchorX: Number.isFinite(Number(element.dataset.anchorX)) ? Number(element.dataset.anchorX) : null,
          anchorY: Number.isFinite(Number(element.dataset.anchorY)) ? Number(element.dataset.anchorY) : null,
          rect: rect(element.getBoundingClientRect()),
        };
      });
    return { rect: rect(canvasRect), labels };
  });
}

async function expectSelectedAnchorCentered(page: Page, conceptId: string): Promise<void> {
  await expect.poll(async () => {
    const geometry = await readCanvasGeometry(page);
    const selected = geometry.labels.find((label) => label.conceptId === conceptId && label.kind === 'selected');
    if (!selected || selected.anchorX === null || selected.anchorY === null) return false;
    const centerX = geometry.rect.width / 2;
    const centerY = geometry.rect.height / 2;
    return Math.abs(selected.anchorX - centerX) <= 2 && Math.abs(selected.anchorY - centerY) <= 2;
  }, { timeout: 5_000 }).toBe(true);
}

function expectLabelGeometry(geometry: CanvasGeometry): void {
  expect(geometry.labels.length).toBeGreaterThan(0);
  expect(geometry.labels.length).toBeLessThanOrEqual(12);
  for (const label of geometry.labels) {
    expect(label.rect.left).toBeGreaterThanOrEqual(geometry.rect.left - 1);
    expect(label.rect.top).toBeGreaterThanOrEqual(geometry.rect.top - 1);
    expect(label.rect.right).toBeLessThanOrEqual(geometry.rect.right + 1);
    expect(label.rect.bottom).toBeLessThanOrEqual(geometry.rect.bottom + 1);
  }
  for (let left = 0; left < geometry.labels.length; left += 1) {
    for (let right = left + 1; right < geometry.labels.length; right += 1) {
      const first = geometry.labels[left].rect;
      const second = geometry.labels[right].rect;
      const overlaps = first.left < second.right
        && first.right > second.left
        && first.top < second.bottom
        && first.bottom > second.top;
      expect(overlaps, `labels ${left} and ${right} overlap`).toBe(false);
    }
  }
}

async function installSyntheticSnapshot(page: Page): Promise<{ getConceptId: () => string }> {
  let conceptId = '';
  await page.route('**/api/snapshot*', async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json() as Snapshot;
    const initialDomainId = chooseDomain(snapshot);
    const initialDomainIndices = snapshot.concepts
      .map((concept, index) => domainIdOf(concept) === initialDomainId ? index : -1)
      .filter((index) => index >= 0);
    const initialDomainIndex = initialDomainIndices[1] ?? initialDomainIndices[0] ?? -1;
    const targetIndex = initialDomainIndex >= 0 ? initialDomainIndex : 0;
    const target = snapshot.concepts[targetIndex];
    if (!target) {
      await route.fulfill({ response, json: snapshot });
      return;
    }
    conceptId = target.id;
    const synthetic: Snapshot = {
      ...snapshot,
      concepts: snapshot.concepts.map((concept, index) => index === targetIndex
        ? { ...concept, title: LONG_TITLE, aliases: [SHORT_LABEL] }
        : concept),
    };
    await route.fulfill({ response, json: synthetic });
  });
  return { getConceptId: () => conceptId };
}

test('synthetic long titles use compact overview labels and bounded selected labels', async ({ page }) => {
  const synthetic = await installSyntheticSnapshot(page);
  await page.goto('/');
  await expect.poll(synthetic.getConceptId).not.toBe('');
  const syntheticConceptId = synthetic.getConceptId();

  const canvas = page.locator('.graph-canvas');
  await expect(canvas).toHaveAttribute('data-layout-ready', 'true');
  await expect(canvas.locator('[data-graph-label-layer="true"]')).toHaveCount(1);
  await expect.poll(async () => (await readCanvasGeometry(page)).labels.length).toBeGreaterThan(0);

  const overview = await readCanvasGeometry(page);
  expectLabelGeometry(overview);
  const regularLabels = overview.labels.filter((label) => label.kind !== 'selected');
  expect(regularLabels.length).toBeGreaterThan(0);
  for (const label of regularLabels) {
    expect(label.fontSize).toBe('11px');
    expect(label.text.length).toBeLessThanOrEqual(24);
    expect(label.text).not.toBe(LONG_TITLE);
  }

  const search = page.getByRole('textbox', { name: '搜索概念' });
  await search.fill(LONG_TITLE);
  const result = page.locator('.concept-list button').filter({ hasText: LONG_TITLE }).first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.locator('.detail-head h2')).toHaveText(LONG_TITLE);

  const selected = canvas.locator(`[data-concept-id="${syntheticConceptId}"][data-kind="selected"]`);
  await expect(selected).toBeVisible();
  const selectedLabel = await selected.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      text: element.textContent ?? '',
      width: box.width,
      height: box.height,
      fontSize: style.fontSize,
      display: style.display,
      overflow: style.overflow,
      lineClamp: style.getPropertyValue('-webkit-line-clamp'),
    };
  });
  expect(selectedLabel.text).toBe(LONG_TITLE);
  expect(selectedLabel.fontSize).toBe('12px');
  expect(selectedLabel.width).toBeLessThanOrEqual(230);
  expect(selectedLabel.height).toBeLessThanOrEqual(64);
  expect(selectedLabel.overflow).toBe('hidden');
  expect(selectedLabel.lineClamp).toBe('3');
  await expectSelectedAnchorCentered(page, syntheticConceptId);

  const afterSelection = await readCanvasGeometry(page);
  expectLabelGeometry(afterSelection);

  await result.click();
  await expect(page.locator('.detail-head h2')).toHaveText(LONG_TITLE);
  await expectSelectedAnchorCentered(page, syntheticConceptId);
  await page.screenshot({ path: 'test-results/p0-refined-labels.png', fullPage: true });

  const sizeBeforeZoom = { width: Math.round(selectedLabel.width), height: Math.round(selectedLabel.height) };
  await canvas.hover();
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => {
    const next = await readCanvasGeometry(page);
    const label = next.labels.find((item) => item.conceptId === syntheticConceptId && item.kind === 'selected');
    return label ? { width: Math.round(label.rect.width), height: Math.round(label.rect.height) } : null;
  }, { timeout: 3_000 }).toEqual(sizeBeforeZoom);
  expectLabelGeometry(await readCanvasGeometry(page));
});
