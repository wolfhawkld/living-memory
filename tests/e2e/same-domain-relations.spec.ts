import { expect, test } from './fixtures';
import { chooseDomain, domainIdOf } from '../../src/core/domain-view';
import type { ExportData, GraphLink, Snapshot } from '../../src/shared/types';

test('complete directed relations disclose on demand and navigate within the selected concept directory', async ({ page, request }) => {
  const snapshot = await (await request.get('/api/snapshot?scope=all')).json() as Snapshot;
  const domain = chooseDomain(snapshot)!;
  const members = snapshot.concepts.filter(concept => domainIdOf(concept) === domain);
  expect(members.length).toBeGreaterThanOrEqual(2);
  const [origin, neighbor] = members;
  const external = snapshot.concepts.find(concept => domainIdOf(concept) !== domain)!;
  expect(external).toBeTruthy();
  const externalDomain = domainIdOf(external);
  const externalNeighbor = snapshot.concepts.find(concept => concept.id !== external.id && domainIdOf(concept) === externalDomain)!;
  expect(externalNeighbor).toBeTruthy();
  const link = (id: string, source: string, target: string, type: string, description: string): GraphLink => ({ id, source, target, type, description });
  const controlled = [
    link('text-relation-out', origin.id, neighbor.id, 'synthetic-outgoing', '完整出向说明，另一端不在图谱前二十项。'),
    link('text-relation-parallel', origin.id, neighbor.id, 'synthetic-parallel', '同一双端的另一种关系仍然保留。'),
    link('text-relation-in', neighbor.id, origin.id, 'synthetic-incoming', '这是反向写入的入向关系。'),
    link('text-relation-self', origin.id, origin.id, 'synthetic-self', '自关联只展示一次。'),
    link('text-relation-cross', origin.id, external.id, 'synthetic-cross', '原跨域入口继续可用。'),
    link('text-relation-external', external.id, externalNeighbor.id, 'synthetic-external', '展开的跨域节点按自己的目录显示同域关系。'),
  ];
  const persisted = async () => {
    const response = await request.get('/api/export');
    expect(response.ok()).toBeTruthy();
    const { exportedAt: _timestamp, ...data } = await response.json() as ExportData;
    return data;
  };
  const before = await persisted();
  const writes: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push(`${request.method()} ${path}`);
  });
  await page.route('**/api/snapshot*', async route => {
    const response = await route.fetch();
    const current = await response.json() as Snapshot;
    const original = current.concepts.find(concept => concept.id === origin.id)!;
    const additions = Array.from({ length: 25 }, (_, index) => ({
      ...original, id: `relation-prefix-${index}`, title: `关系列表补充概念 ${index}`,
      source: { ...original.source, path: `${domain}/relation-prefix-${index}.md` },
    }));
    const states = { ...current.states };
    for (const item of additions) states[item.id] = { ...states[origin.id], conceptId: item.id };
    const replaced = new Set([origin.id, external.id]);
    await route.fulfill({ response, json: {
      ...current, concepts: [original, ...additions, ...current.concepts.filter(item => item.id !== origin.id)], states,
      links: [...current.links.filter(edge => !replaced.has(edge.source) && !replaced.has(edge.target)), ...controlled],
      source: { ...current.source, limit: 20, conceptCount: current.concepts.length + additions.length },
    } });
  });
  // Extra concepts and relationships affect only this browser response. Real
  // mode is used only with the graph unmounted, preventing synthetic layouts.
  await page.goto('/');
  await expect(page.getByRole('button', { name: '查看真实记录', exact: true })).toBeVisible();
  const cap = page.getByRole('combobox', { name: '当前领域节点上限', exact: true });
  await cap.selectOption('20');
  await expect(page.locator('.graph-canvas')).toHaveAttribute('data-node-count', '20');
  await page.getByRole('button', { name: '文字列表', exact: true }).click();
  await page.getByRole('button', { name: '查看真实记录', exact: true }).click();
  const list = page.getByRole('list', { name: '概念文字列表', exact: true });
  const select = async (title: string) => {
    await expect(page.getByRole('button', { name: '返回图谱', exact: true })).toBeEnabled();
    await list.getByRole('button').filter({ has: page.getByText(title, { exact: true }) }).click();
    await expect(page.locator('.detail-head h2')).toHaveText(title);
  };
  await select(origin.title);
  const panel = page.locator('.same-domain-relations');
  const summary = panel.locator('summary');
  await expect(summary).toHaveText('查看同域关系（4条）');
  await expect(panel.locator('.same-domain-relations-list')).toBeHidden();
  await expect(page.locator('.viewed-label')).toHaveCount(0);

  // The H popover makes domain interactions busy without saving any setting.
  const settings = page.locator('.config-button');
  await settings.click();
  await expect(summary).toHaveAttribute('aria-disabled', 'true');
  await summary.click({ force: true });
  await summary.press('Enter');
  await summary.press('Space');
  expect(await panel.evaluate((element: HTMLDetailsElement) => element.open)).toBe(false);
  await expect(page.locator('.viewed-label')).toHaveCount(0);
  await settings.click();
  await expect(summary).toHaveAttribute('aria-disabled', 'false');
  await summary.press('Enter');
  await expect(panel.locator('.same-domain-relations-list > li')).toHaveCount(4);
  await expect(panel.locator('.same-domain-relations-list')).toBeVisible();
  await expect(page.locator('.viewed-label')).toBeVisible();
  const outgoing = panel.locator('li').filter({ hasText: 'synthetic-outgoing' });
  const incoming = panel.locator('li').filter({ hasText: 'synthetic-incoming' });
  await expect(outgoing.locator('.same-domain-relations-direction')).toHaveText('出向');
  await expect(incoming.locator('.same-domain-relations-direction')).toHaveText('入向');
  await expect(outgoing.locator('.same-domain-relations-endpoints strong')).toHaveText([origin.title, neighbor.title]);
  await expect(incoming.locator('.same-domain-relations-endpoints strong')).toHaveText([neighbor.title, origin.title]);
  await expect(outgoing).toContainText('完整出向说明，另一端不在图谱前二十项。');
  await expect(panel.locator('li').filter({ hasText: 'synthetic-self' }).getByRole('button')).toHaveCount(0);
  await expect(panel.locator('li').filter({ hasText: 'synthetic-parallel' })).toBeVisible();
  await outgoing.getByRole('button', { name: `查看关联概念：${neighbor.title}`, exact: true }).click();
  await expect(page.locator('.detail-head h2')).toHaveText(neighbor.title);
  expect(await panel.evaluate((element: HTMLDetailsElement) => element.open)).toBe(false);

  await select(origin.title);
  const cross = page.locator('.cross-domain-item').filter({ has: page.getByRole('heading', { name: external.title, exact: true }) });
  await cross.getByRole('button', { name: '在图中展开', exact: true }).click();
  await select(external.title);
  await expect(page.getByRole('combobox', { name: '知识域', exact: true })).toHaveValue(domain);
  await summary.press('Enter');
  await expect(panel.locator('.same-domain-relations-scope')).toContainText(externalDomain);
  await expect(panel).toContainText('synthetic-external');
  await panel.getByRole('button', { name: `查看关联概念：${externalNeighbor.title}`, exact: true }).click();
  await expect(page.getByRole('combobox', { name: '知识域', exact: true })).toHaveValue(externalDomain);
  await expect(page.locator('.detail-head h2')).toHaveText(externalNeighbor.title);
  expect(await panel.evaluate((element: HTMLDetailsElement) => element.open)).toBe(false);

  await select(external.title);
  const returnCross = page.locator('.cross-domain-item').filter({ has: page.getByRole('heading', { name: origin.title, exact: true }) });
  await returnCross.getByRole('button', { name: '前往该领域', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '知识域', exact: true })).toHaveValue(domain);
  await expect(page.locator('.detail-head h2')).toHaveText(origin.title);
  await expect(page.locator('.graph-canvas')).toHaveCount(0);
  await page.getByRole('button', { name: '查看示例状态', exact: true }).click();
  await page.getByRole('button', { name: '返回图谱', exact: true }).click();
  await expect(page.locator('.graph-canvas')).toHaveAttribute('data-node-count', '20');
  await expect(page.locator('.graph-canvas')).toHaveAttribute('data-layout-ready', 'true');
  await expect(panel).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(await persisted()).toEqual(before);
});
