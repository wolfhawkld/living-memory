import type { Locator } from '@playwright/test';
import { test, expect } from './fixtures';

// Navigation and tooltip elements come first; the WebGL canvas precedes other canvases.
const WEBGL_CANVAS = '.graph-canvas .scene-container > canvas:first-of-type';

test.use({ deviceScaleFactor: 2 });

async function canvasSize(canvas: Locator) {
  return canvas.evaluate((element: HTMLCanvasElement) => {
    const style = getComputedStyle(element);
    const host = element.closest('.graph-canvas') as HTMLElement;
    return {
      width: element.clientWidth,
      height: element.clientHeight,
      cssWidth: Number.parseFloat(style.width),
      cssHeight: Number.parseFloat(style.height),
      backingWidth: element.width,
      backingHeight: element.height,
      hostWidth: host.clientWidth,
      hostHeight: host.clientHeight,
    };
  });
}

async function expectPixelRatio(canvas: Locator, ratio: number) {
  await expect.poll(async () => {
    const size = await canvasSize(canvas);
    return size.width > 0 && size.height > 0
      && Math.abs(size.cssWidth - size.width) <= 1
      && Math.abs(size.cssHeight - size.height) <= 1
      && size.width === size.hostWidth && size.height === size.hostHeight
      && Math.abs(size.backingWidth - Math.floor(size.cssWidth * ratio)) <= 1
      && Math.abs(size.backingHeight - Math.floor(size.cssHeight * ratio)) <= 1;
  }).toBe(true);
}

test('render quality changes backing resolution while retaining logical size and persists after reload', async ({ page }) => {
  await page.goto('/');
  const host = page.locator('.graph-canvas');
  const canvas = page.locator(WEBGL_CANVAS);
  const quality = page.getByLabel('渲染清晰度', { exact: true });
  await expect(canvas).toBeVisible();
  await expect(host).toHaveAttribute('data-layout-ready', 'true');
  await expect(quality).toHaveValue('standard');
  await expectPixelRatio(canvas, 2);
  const initial = await canvasSize(canvas);
  const originalCanvas = await canvas.elementHandle();
  expect(originalCanvas).not.toBeNull();

  await quality.selectOption('low');
  await expect(quality).toHaveValue('low');
  await expectPixelRatio(canvas, 1);
  await expect.poll(async () => {
    const size = await canvasSize(canvas);
    return { width: size.width, height: size.height };
  }).toEqual({ width: initial.width, height: initial.height });
  expect(await originalCanvas!.evaluate((element, selector) => (
    element.isConnected && element === document.querySelector(selector)
  ), WEBGL_CANVAS)).toBe(true);

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  // Changing height alone avoids unrelated toolbar wrapping or width breakpoints.
  await page.setViewportSize({ width: viewport!.width, height: viewport!.height + 120 });
  await expect.poll(async () => (await canvasSize(canvas)).height).not.toBe(initial.height);
  await expectPixelRatio(canvas, 1);
  expect(await originalCanvas!.evaluate((element, selector) => (
    element.isConnected && element === document.querySelector(selector)
  ), WEBGL_CANVAS)).toBe(true);

  await page.reload();
  await expect(canvas).toBeVisible();
  await expect(host).toHaveAttribute('data-layout-ready', 'true');
  await expect(quality).toHaveValue('low');
  await expectPixelRatio(canvas, 1);

  await quality.selectOption('standard');
  await expect(quality).toHaveValue('standard');
  await expectPixelRatio(canvas, 2);
});
