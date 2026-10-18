import type { Locator } from '@playwright/test';
import { test, expect } from './fixtures';

async function expectCenterHit(button: Locator) {
  await button.scrollIntoViewIfNeeded();
  await expect.poll(() => button.evaluate(element => {
    const box = element.getBoundingClientRect();
    const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return Boolean(target && (target === element || element.contains(target)));
  })).toBe(true);
}

async function expectHeaderContainsControls(header: Locator) {
  await expect.poll(() => header.evaluate(element => {
    const box = element.getBoundingClientRect();
    const actions = element.querySelector('.topbar-actions')!;
    const controls = [...actions.querySelectorAll(':scope > button')];
    const within = (child: Element) => {
      const bounds = child.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && bounds.left >= box.left - 1 && bounds.right <= box.right + 1
        && bounds.top >= box.top - 1 && bounds.bottom <= box.bottom + 1;
    };
    const mode = element.parentElement!.querySelector(':scope > .mode-bar:not(.source-reload-banner)')!;
    return { actionsContained: within(actions), buttonsContained: controls.length > 0 && controls.every(within),
      headerWithinViewport: box.left >= -1 && box.right <= window.innerWidth + 1,
      modeBelowHeader: mode.getBoundingClientRect().top >= box.bottom - 1 };
  })).toEqual({ actionsContained: true, buttonsContained: true, headerWithinViewport: true, modeBelowHeader: true });
}

test('admin header controls remain reachable above the mode bar at desktop and narrow widths', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${request.url()}`);
  });
  await page.goto('/');
  await page.getByRole('button', { name: '文字列表', exact: true }).click();
  const header = page.locator('header.topbar');
  const modeBar = page.locator('.app-shell > .mode-bar:not(.source-reload-banner)');
  const config = header.locator('.config-button');

  for (const width of [1440, 1180, 960]) {
    await test.step(`header at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator('.app-shell').evaluate(element => element.scrollTo({ top: 0, left: 0 }));
      await expectHeaderContainsControls(header);
      const real = modeBar.getByRole('button', { name: '查看真实记录', exact: true });
      await expect(real).toBeEnabled();
      await expectCenterHit(real);
      await real.click();
      await expect(modeBar).toContainText('真实学习记录');
      await expect(config).toBeEnabled();
      await expectHeaderContainsControls(header);

      await expectCenterHit(config);
      await config.click();
      await expect(header.locator('.config-popover')).toBeVisible();
      // The popover must be below all wrapped controls, leaving its own H
      // trigger available for an ordinary second click without saving.
      await expectCenterHit(config);
      await config.click();
      await expect(header.locator('.config-popover')).toHaveCount(0);

      const historyButton = header.getByRole('button', { name: '查阅记录', exact: true });
      await expect(historyButton).toBeEnabled();
      await expectCenterHit(historyButton);
      await historyButton.click();
      const history = page.getByRole('dialog', { name: '查阅记录', exact: true });
      await expect(history).toBeVisible();
      await history.getByRole('button', { name: '关闭查阅记录', exact: true }).click();
      await expect(history).toHaveCount(0);

      const example = modeBar.getByRole('button', { name: '查看示例状态', exact: true });
      await expectCenterHit(example);
      await example.click();
      await expect(modeBar).toContainText('示例状态 · 非真实记忆');
      await expectHeaderContainsControls(header);
    });
  }
  expect(writes).toEqual([]);
});
