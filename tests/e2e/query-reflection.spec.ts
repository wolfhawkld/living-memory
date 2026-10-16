import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { chooseDomain, domainIdOf } from '../../src/core/domain-view';
import type { ExportData, ObservationRequest, Snapshot } from '../../src/shared/types';

async function exported(request: APIRequestContext) {
  const response = await request.get('/api/export');
  expect(response.ok()).toBeTruthy();
  const { exportedAt: _timestamp, ...data } = await response.json() as ExportData;
  return data;
}

async function prepare(page: Page, request: APIRequestContext) {
  const response = await request.get('/api/snapshot?scope=all');
  expect(response.ok()).toBeTruthy();
  const snapshot = await response.json() as Snapshot;
  const domain = chooseDomain(snapshot)!;
  const primary = snapshot.concepts.find(item => domainIdOf(item) === domain)!;
  const external = snapshot.concepts.find(item => domainIdOf(item) !== domain)!;
  expect(primary).toBeTruthy(); expect(external).toBeTruthy();
  // Enrich only the browser response. Real IDs/revisions remain valid for the
  // one voluntary observation; no knowledge file or fixture server is changed.
  await page.route('**/api/snapshot*', async route => {
    const fetched = await route.fetch();
    const current = await fetched.json() as Snapshot;
    await route.fulfill({ response: fetched, json: { ...current, links: [...current.links, { id: 'query-reflection-visible-neighbor', source: primary.id, target: external.id, type: 'query-reflection-test-relation', description: '仅浏览器可见的跨域关系提示。' }], concepts: current.concepts.map(item =>
      item.id === external.id ? { ...item, aliases: [...item.aliases, 'query-reflection-alias'], summary: 'query-reflection-summary-marker：用于隔离的跨域检索核对。' } : item),
    } });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '文字列表', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '文字列表', exact: true }).click();
  const entry = page.getByRole('button', { name: '先想一下再查', exact: true });
  await expect(entry).toBeDisabled(); // Demo remains read-only.
  await page.getByRole('button', { name: '查看真实记录', exact: true }).click();
  await expect(entry).toBeEnabled();
  const settings = page.locator('.config-button');
  await settings.click();
  await expect(entry).toBeDisabled();
  await settings.click();
  await expect(entry).toBeEnabled();
  return { snapshot, primary, external, entry };
}

async function begin(page: Page, problem: string, answer: string, expectedInitialProblem?: string) {
  await page.getByRole('button', { name: '先想一下再查', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '查询前先想一下', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.locator('.workspace')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('.workspace')).toHaveAttribute('inert', '');
  await expect(dialog.getByRole('button', { name: '回访已保存场景', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('listbox', { name: '匹配的概念', exact: true })).toHaveCount(0);
  await expect(dialog.locator('.scenario-selected-concept')).toHaveCount(0);
  if (expectedInitialProblem !== undefined) {
    await expect(dialog.getByLabel('要解决的问题 / 场景', { exact: true })).toHaveValue(expectedInitialProblem);
    await expect(dialog.locator('.scenario-revisit-note')).toHaveCount(0);
  }
  await dialog.getByLabel('要解决的问题 / 场景', { exact: true }).fill(problem);
  await dialog.getByLabel('开始前的信心', { exact: true }).selectOption('75');
  await dialog.getByRole('button', { name: '开始先回忆', exact: true }).click();
  await expect(dialog.getByRole('listbox', { name: '匹配的概念', exact: true })).toHaveCount(0);
  await expect(dialog.locator('.scenario-summary')).toHaveCount(0);
  await dialog.getByLabel('先写下想到的概念和理由', { exact: true }).fill(answer);
  await dialog.getByRole('button', { name: '提交回答，进入核对', exact: true }).click();
  await expect(dialog.locator('.scenario-answer-echo').filter({ has: page.getByText('你的回答', { exact: true }) }).locator('p')).toHaveText(answer || '（空白回答）');
  await expect(dialog.getByLabel('先写下想到的概念和理由', { exact: true })).toHaveCount(0);
  return dialog;
}

async function discard(page: Page) {
  const confirmation = page.waitForEvent('dialog').then(dialog => dialog.accept());
  await page.getByRole('button', { name: '关闭查询前回忆', exact: true }).click();
  await confirmation;
  await expect(page.getByRole('dialog', { name: '查询前先想一下', exact: true })).toHaveCount(0);
  await expect(page.locator('.workspace')).not.toHaveAttribute('inert', '');
}

test('query reflection hides the workspace until the original answer freezes and closes without learning writes', async ({ page, request }) => {
  const { primary, external } = await prepare(page, request);
  const before = await exported(request);
  const writes: string[] = [];
  page.on('request', req => {
    if (new URL(req.url()).pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) writes.push(req.url());
  });
  // A result displayed before entry counts as a name hint even without clicking
  // it or reading its source. The lookup remains across all knowledge domains.
  const search = page.getByRole('combobox', { name: '搜索概念', exact: true });
  await search.fill('query-reflection-alias');
  await expect(page.getByRole('listbox', { name: '概念搜索结果', exact: true })).toContainText(external.title);
  await search.press('Escape');
  await expect(page.getByRole('listbox', { name: '概念搜索结果', exact: true })).toHaveCount(0);
  const dialog = await begin(page, '怎样为系统选择一种可解释的抽象？', '先列出候选方法，再检验输入和约束。', 'query-reflection-alias');
  const lookup = dialog.getByRole('combobox', { name: '你认为哪个概念适用于这个场景？', exact: true });
  await lookup.fill('query-reflection-summary-marker');
  await dialog.getByRole('option').filter({ has: page.getByText(external.title, { exact: true }) }).click();
  await expect(dialog.locator('.scenario-selected-concept')).toContainText(external.title);
  await expect(dialog.locator('.scenario-summary')).toContainText('query-reflection-summary-marker');
  const cue = dialog.getByLabel('获得概念的线索', { exact: true });
  await expect(cue.locator('option[value="independent"]')).toBeDisabled();
  await expect(dialog.getByLabel('提交前是否看过资料', { exact: true })).toHaveValue('unknown');
  await cue.selectOption('lookup');
  await dialog.getByLabel('这次调用结果', { exact: true }).selectOption('partial');
  await dialog.getByLabel('判断依据', { exact: true }).selectOption('self-check');
  await dialog.getByLabel('为什么适用或不适用（可在核对后补充）', { exact: true }).fill('核对后补充的适用条件。');
  await lookup.fill(primary.title);
  await dialog.getByRole('option').filter({ has: page.getByText(primary.title, { exact: true }) }).click();
  await expect(cue).toHaveValue('hinted'); // Current domain names were visible before entering.
  await expect(dialog.getByLabel('这次调用结果', { exact: true })).toHaveValue('unverified');
  await expect(dialog.getByLabel('判断依据', { exact: true })).toHaveValue('unknown');
  await expect(dialog.getByLabel('为什么适用或不适用（可在核对后补充）', { exact: true })).toHaveValue('');
  await discard(page);
  expect(writes).toEqual([]);
  expect(await exported(request)).toEqual(before);
});

test('blank original answer cannot become independent after looking up a concept', async ({ page, request }) => {
  const { external } = await prepare(page, request);
  const before = await exported(request);
  const dialog = await begin(page, '有一个暂时想不出模型的问题。', '');
  await dialog.getByRole('combobox', { name: '你认为哪个概念适用于这个场景？', exact: true }).fill('query-reflection-alias');
  await dialog.getByRole('option').filter({ has: page.getByText(external.title, { exact: true }) }).click();
  await expect(dialog.getByLabel('获得概念的线索', { exact: true }).locator('option[value="independent"]')).toBeDisabled();
  await discard(page);
  expect(await exported(request)).toEqual(before);
});

test('voluntary query observation retains the frozen answer without changing memory anchors or H', async ({ page, request }) => {
  const { external } = await prepare(page, request);
  const before = await exported(request);
  const originalAnswer = '先建立条件和候选方案的对应表，再核对具体适用条件。';
  const problem = '需要从需求约束中找到适合的知识模型。';
  const dialog = await begin(page, problem, originalAnswer);
  await dialog.getByRole('combobox', { name: '你认为哪个概念适用于这个场景？', exact: true }).fill('query-reflection-alias');
  await dialog.getByRole('option').filter({ has: page.getByText(external.title, { exact: true }) }).click();
  await dialog.getByLabel('获得概念的线索', { exact: true }).selectOption('lookup');
  await dialog.getByLabel('这次调用结果', { exact: true }).selectOption('partial');
  await dialog.getByLabel('判断依据', { exact: true }).selectOption('self-check');
  await dialog.getByLabel('为什么适用或不适用（可在核对后补充）', { exact: true }).fill('核对资料后识别适用条件，此说明不替换原回答。');
  const pending = page.waitForRequest(req => req.method() === 'POST' && new URL(req.url()).pathname === '/api/observations');
  await dialog.getByRole('button', { name: '保存这次场景观察', exact: true }).click();
  const payload = (await pending).postDataJSON() as ObservationRequest;
  expect(payload.answer).toBe(originalAnswer);
  expect(payload.conceptId).toBe(external.id);
  expect(payload.learning).toMatchObject({ task: 'scenario', scenario: problem, confidence: 75, cue: 'lookup', outcome: 'partial', basis: 'self-check' });
  expect(payload.learning).not.toHaveProperty('scenarioRevisit');
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await exported(request)).observations.filter(item => item.eventId === payload.eventId).length).toBe(1);
  const after = await exported(request);
  const added = after.observations.filter(item => !before.observations.some(previous => previous.eventId === item.eventId));
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ answer: originalAnswer, conceptId: external.id, halfLifeDays: before.config.halfLifeDays });
  const { observations: _beforeObservations, ...unchangedBefore } = before;
  const { observations: _afterObservations, ...unchangedAfter } = after;
  expect(unchangedAfter).toEqual(unchangedBefore); // Includes anchors, retention, H, layout and budget.
});


test('an unexpanded cross-domain relation name is a hint without exposing its source', async ({ page, request }) => {
  const { primary, external } = await prepare(page, request);
  const before = await exported(request);
  await page.getByRole('list', { name: '概念文字列表', exact: true }).getByRole('button')
    .filter({ has: page.getByText(primary.title, { exact: true }) }).click();
  await expect(page.locator('.detail-head h2')).toHaveText(primary.title);
  const neighbor = page.locator('.cross-domain-item').filter({ has: page.getByRole('heading', { name: external.title, exact: true }) });
  await expect(neighbor).toBeVisible();
  await expect(neighbor).toContainText('query-reflection-test-relation');
  await expect(neighbor.getByRole('button', { name: '在图中展开', exact: true })).toBeVisible();
  const dialog = await begin(page, '需要针对输入和规则选择可解释模型。', '先辨识业务约束，再确定建模工具。');
  await dialog.getByRole('combobox', { name: '你认为哪个概念适用于这个场景？', exact: true }).fill('query-reflection-alias');
  await dialog.getByRole('option').filter({ has: page.getByText(external.title, { exact: true }) }).click();
  await expect(dialog.getByLabel('获得概念的线索', { exact: true })).toHaveValue('hinted');
  await expect(dialog.getByLabel('获得概念的线索', { exact: true }).locator('option[value="independent"]')).toBeDisabled();
  await expect(dialog.getByLabel('提交前是否看过资料', { exact: true })).toHaveValue('unknown');
  await discard(page);
  expect(await exported(request)).toEqual(before);
});
