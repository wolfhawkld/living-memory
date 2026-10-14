import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { chooseDomain, domainIdOf } from '../../src/core/domain-view';
import { STATUS_LABELS } from '../../src/web/memory-status';
import type { ExportData, Snapshot } from '../../src/shared/types';

async function tabToConcept(page: Page, target: Locator, maxItems: number) {
  const mode = page.getByRole('button', { name: '返回图谱', exact: true });
  await expect(mode).toBeEnabled();
  await mode.focus();
  for (let i = 0; i < maxItems + 8; i += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate(element => document.activeElement === element)) return;
  }
  throw new Error('Concept button was not reachable with Tab from the mode control');
}

test('full domain text list retains states and keyboard selection independently of the graph cap', async ({ page, request }) => {
  const initial = await (await request.get('/api/snapshot?scope=all')).json() as Snapshot;
  const domainId = chooseDomain(initial)!;
  const members = initial.concepts.filter(concept => domainIdOf(concept) === domainId);
  expect(members.length).toBeGreaterThanOrEqual(2);
  const [first, second] = members;
  const other = initial.concepts.find(concept => domainIdOf(concept) !== domainId)!;
  expect(other).toBeTruthy();
  const otherDomainId = domainIdOf(other);
  const domainCount = members.length + 25;
  const otherCount = initial.concepts.filter(concept => domainIdOf(concept) === otherDomainId).length;
  const persisted = async () => {
    const response = await request.get('/api/export');
    expect(response.ok()).toBeTruthy();
    const { exportedAt: _timestamp, ...content } = await response.json() as ExportData;
    return content;
  };
  const before = await persisted();
  const writes: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  await page.route('**/api/snapshot*', async route => {
    const response = await route.fetch();
    const snapshot = await response.json() as Snapshot;
    const original = snapshot.concepts.find(concept => concept.id === first.id)!;
    const additions = Array.from({ length: 25 }, (_, index) => ({
      ...original, id: `text-list-synthetic-${index}`, title: `列表补充概念 ${String(index).padStart(2, '0')}`,
      source: { ...original.source, path: `${domainId}/text-list-${index}.md` },
    }));
    const states = { ...snapshot.states };
    for (const concept of additions) states[concept.id] = { ...states[first.id], conceptId: concept.id };
    await route.fulfill({ response, json: {
      ...snapshot, concepts: [...additions, ...snapshot.concepts], states,
      source: { ...snapshot.source, limit: 20, conceptCount: snapshot.concepts.length + additions.length },
    } });
  });

  // The additional concepts live only in browser responses. Graphs stay in demo
  // mode, so synthetic layout coordinates can never be sent to the fixture Store.
  await page.goto('/');
  await expect(page.getByRole('button', { name: '查看真实记录', exact: true })).toBeVisible();
  const graph = page.locator('.graph-canvas');
  const cap = page.getByRole('combobox', { name: '当前领域节点上限', exact: true });
  await cap.selectOption('20');
  await expect(graph).toHaveAttribute('data-node-count', '20');
  await page.getByRole('button', { name: '文字列表', exact: true }).click();
  const list = page.getByRole('list', { name: '概念文字列表', exact: true });
  await expect(list.getByRole('button')).toHaveCount(domainCount);
  await expect(page.locator('.graph-text-scope')).toContainText(`当前领域全部 ${domainCount} 个概念`);
  await expect(page.locator('.graph-text-scope')).toContainText('示例状态');
  await expect(cap).toBeDisabled();
  await expect(page.getByRole('button', { name: '发光效果', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '返回图谱', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.graph-legend')).toHaveCount(0);
  await expect(page.locator('.graph-hint')).toHaveCount(0);
  await expect(graph).toHaveCount(0);

  await page.getByRole('button', { name: '查看真实记录', exact: true }).click();
  await expect(page.locator('.graph-text-scope')).toContainText('真实记录 · 实时状态');
  const firstButton = list.getByRole('button').filter({ has: page.getByText(first.title, { exact: true }) });
  const secondButton = list.getByRole('button').filter({ has: page.getByText(second.title, { exact: true }) });
  await expect(firstButton).toContainText(STATUS_LABELS[initial.states[first.id].status]);
  await expect(firstButton).toContainText(first.source.path);
  await expect(firstButton).toHaveAttribute('aria-pressed', 'false');
  await tabToConcept(page, firstButton, domainCount);
  await page.keyboard.press('Enter');
  await expect(firstButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.detail-head h2')).toHaveText(first.title);
  await tabToConcept(page, secondButton, domainCount);
  await page.keyboard.press('Space');
  await expect(secondButton).toHaveAttribute('aria-pressed', 'true');
  await expect(firstButton).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.detail-head h2')).toHaveText(second.title);

  const picker = page.getByRole('combobox', { name: '知识域', exact: true });
  await picker.selectOption(otherDomainId);
  await expect(list.getByRole('button')).toHaveCount(otherCount);
  await expect(list.getByRole('button', { pressed: true })).toHaveCount(0);
  await expect(page.locator('.detail-head h2')).toHaveCount(0);
  await expect(graph).toHaveCount(0);
  await picker.selectOption(domainId);
  await expect(list.getByRole('button')).toHaveCount(domainCount);
  await page.getByRole('button', { name: '查看示例状态', exact: true }).click();
  await tabToConcept(page, secondButton, domainCount);
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '返回图谱', exact: true }).click();
  await expect(graph).toHaveAttribute('data-node-count', '20');
  await expect(graph).toHaveAttribute('data-layout-ready', 'true');
  await expect(page.locator('.detail-head h2')).toHaveText(second.title);
  await expect(cap).toHaveValue('20');
  await expect(cap).toBeEnabled();
  expect(writes).toEqual([]);
  expect(await persisted()).toEqual(before);
});
