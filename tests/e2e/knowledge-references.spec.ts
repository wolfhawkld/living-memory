import type { APIRequestContext, Locator, Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { chooseDomain, domainIdOf } from '../../src/core/domain-view';
import { getKnowledgeReferences } from '../../src/server/knowledge-references';
import type { KnowledgeSource } from '../../src/server/kg';
import type { KnowledgeReferences } from '../../src/shared/knowledge-references';
import type { Concept, ExportData, Snapshot } from '../../src/shared/types';

const MAIN_TITLE = '章节引用验收起点';
const TARGET_TITLE = '章节引用验收目标';
const ORIGINAL_ANSWER = '原回答：先列出约束，再比较候选模型的前提。';
const prose = Array.from({ length: 18 }, (_, index) => `用于区分章节滚动位置的正文段落 ${index + 1}。`).join('\n\n');

function field(page: Page, dialog: Locator, title: string) {
  return dialog.locator('label').filter({ has: page.getByText(title, { exact: true }) }).locator('textarea');
}

async function exported(request: APIRequestContext) {
  const response = await request.get('/api/export');
  expect(response.ok()).toBeTruthy();
  const { exportedAt: _timestamp, ...data } = await response.json() as ExportData;
  return data;
}

interface Prepared {
  primary: Concept;
  target: Concept;
  metadata: Map<string, KnowledgeReferences>;
  writes: string[];
}

async function prepare(page: Page, request: APIRequestContext,
  intercept?: (route: Route, data: KnowledgeReferences) => Promise<void>): Promise<Prepared> {
  const response = await request.get('/api/snapshot?scope=all');
  expect(response.ok()).toBeTruthy();
  const snapshot = await response.json() as Snapshot;
  const domain = chooseDomain(snapshot)!;
  const original = snapshot.concepts.find((concept) => domainIdOf(concept) === domain)!;
  const other = snapshot.concepts.find((concept) => concept.id !== original.id)!;
  expect(original).toBeTruthy(); expect(other).toBeTruthy();
  // Only browser responses change. These IDs and revisions still belong to the
  // isolated fixture server; its knowledge files and learning records stay intact.
  const primary: Concept = { ...original, title: MAIN_TITLE, aliases: [], summary: '章节引用合成验收摘要。', body: [
    '# 总览', prose,
    `[[${other.source.path}#应用场景|跨笔记应用]]`,
    '[精确第二个重复](#重复-3)',
    '[[#重复|歧义引用]] [[不存在的验收笔记|失效笔记]]',
    `[[${other.source.path}#不存在|失效章节]] [[${other.source.path}#^block|块引用]]`,
    '[不安全路径](../../../../outside.md)',
    '## 重复', prose, '## 重复', prose, '## 重复-2', prose, '## **中文** `定义`', prose,
  ].join('\n\n') };
  const target: Concept = { ...other, title: TARGET_TITLE, aliases: [], summary: '目标资料摘要。',
    body: `# 目标总览\n\n${prose}\n\n## 应用场景\n\n${prose}` };
  const concepts = snapshot.concepts.map((concept) => concept.id === primary.id ? primary : concept.id === target.id ? target : concept);
  const graph = { concepts, links: snapshot.links, source: snapshot.source };
  const source: KnowledgeSource = { graph, index: graph, namespace: 'browser-reference-fixture', root: '/synthetic-browser-only' };
  const metadata = new Map([primary, target].map((concept) => [concept.id, getKnowledgeReferences(source, concept.id, concept.source.revision)]));
  await page.route('**/api/snapshot*', async route => {
    const fetched = await route.fetch();
    const current = await fetched.json() as Snapshot;
    await route.fulfill({ response: fetched, json: { ...current, concepts: current.concepts.map((concept) =>
      concept.id === primary.id ? primary : concept.id === target.id ? target : concept) } });
  });
  await page.route('**/api/knowledge/references?*', async route => {
    const url = new URL(route.request().url());
    const data = metadata.get(url.searchParams.get('conceptId') ?? '');
    if (!data) throw new Error('Unexpected reference request outside the synthetic reader fixture');
    expect(url.searchParams.get('sourceRevision')).toBe(data.sourceRevision);
    if (intercept) await intercept(route, data);
    else await route.fulfill({ json: data });
  });
  // These browser-only bodies deliberately retain the server revision. They
  // test navigation, not factual exposure; never submit their synthetic blocks.
  await page.route('**/api/activity/settings', async route => {
    const fetched = await route.fetch();
    const value = await fetched.json() as { sourceId: string; settings: { enabled: boolean; epoch: number; revision: number } };
    await route.fulfill({ response: fetched, json: { ...value, settings: { ...value.settings, enabled: false } } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '文字列表', exact: true }).click();
  await page.getByRole('button', { name: '查看真实记录', exact: true }).click();
  await expect(page.getByRole('button', { name: '先想一下再查', exact: true })).toBeEnabled();
  await page.getByRole('list', { name: '概念文字列表', exact: true }).getByRole('button')
    .filter({ has: page.getByText(MAIN_TITLE, { exact: true }) }).click();
  await expect(page.locator('.detail-head h2')).toHaveText(MAIN_TITLE);
  const writes: string[] = [];
  page.on('request', req => {
    const path = new URL(req.url()).pathname;
    if (path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())
      && !(req.method() === 'POST' && path === '/api/activity')) writes.push(req.url());
  });
  return { primary, target, metadata, writes };
}

function reader(page: Page, title = MAIN_TITLE) {
  return page.getByRole('dialog', { name: title, exact: true });
}

async function openReader(page: Page) {
  await page.getByRole('button', { name: '打开大窗阅读', exact: true }).click();
  await expect(reader(page)).toBeVisible();
  return reader(page);
}

test('Chinese and duplicate sections locate precisely, cross-note reading returns without changing the frozen task', async ({ page, request }) => {
  const { primary, target, writes } = await prepare(page, request);
  const before = await exported(request);
  await page.getByRole('button', { name: '先想一下再查', exact: true }).click();
  const task = page.getByRole('dialog', { name: '查询前先想一下', exact: true });
  await field(page, task, '要解决的问题 / 场景').fill('用什么概念抽象当前需求？');
  await task.getByRole('button', { name: '开始先回忆', exact: true }).click();
  await field(page, task, '先写下想到的概念和理由').fill(ORIGINAL_ANSWER);
  await task.getByRole('button', { name: '提交回答，进入核对', exact: true }).click();
  await task.getByRole('combobox', { name: '你认为哪个概念适用于这个场景？', exact: true }).fill(primary.title);
  const option = task.getByRole('listbox', { name: '匹配的概念', exact: true }).getByRole('option');
  await expect(option).toHaveCount(1);
  await option.click();
  await task.getByRole('button', { name: '阅读完整资料 ↗', exact: true }).click();
  const origin = reader(page);
  const toc = origin.getByRole('navigation', { name: '资料目录', exact: true });
  await expect(toc.getByRole('button', { name: '重复', exact: true })).toHaveCount(2);
  // nth(1) deliberately means the second of two identical human titles; the
  // resulting slug skips the naturally occurring heading "重复-2".
  await toc.getByRole('button', { name: '重复', exact: true }).nth(1).click();
  await expect(toc.getByRole('button', { name: '重复', exact: true }).nth(1)).toHaveAttribute('aria-current', 'location');
  await expect(origin.locator('[data-knowledge-section="重复-3"]')).toBeInViewport();
  await toc.getByRole('button', { name: '中文 定义', exact: true }).click();
  await expect(toc.getByRole('button', { name: '中文 定义', exact: true })).toHaveAttribute('aria-current', 'location');
  await origin.getByRole('button', { name: '精确第二个重复', exact: true }).click();
  await expect(toc.getByRole('button', { name: '重复', exact: true }).nth(1)).toHaveAttribute('aria-current', 'location');
  await origin.getByRole('button', { name: '跨笔记应用', exact: true }).click();
  const destination = reader(page, target.title);
  await expect(destination).toBeVisible();
  await expect(page.locator('dialog.concept-reader')).toHaveCount(1);
  await expect(destination.getByRole('navigation', { name: '资料目录', exact: true })
    .getByRole('button', { name: '应用场景', exact: true })).toHaveAttribute('aria-current', 'location');
  await destination.getByRole('button', { name: '关闭阅读窗口', exact: true }).click();
  await expect(origin).toBeVisible();
  await origin.getByRole('button', { name: '关闭阅读窗口', exact: true }).click();
  await expect(task).toBeVisible();
  await expect(task.locator('.scenario-answer-echo').filter({ has: page.getByText('你的回答', { exact: true }) }).locator('p')).toHaveText(ORIGINAL_ANSWER);
  await expect(task.locator('.scenario-selected-concept strong')).toHaveText(primary.title);
  const confirmation = page.waitForEvent('dialog').then(dialog => dialog.accept());
  await task.getByRole('button', { name: '关闭查询前回忆', exact: true }).click();
  await confirmation;
  await expect(page.locator('.detail-head h2')).toHaveText(primary.title);
  expect(writes).toEqual([]);
  expect(await exported(request)).toEqual(before);
});

test('missing, ambiguous, block and unsafe references explain the failure and keep the current material', async ({ page, request }) => {
  const { metadata, primary, writes } = await prepare(page, request);
  const before = await exported(request);
  expect(metadata.get(primary.id)!.references.filter(item => item.status !== 'resolved-section').map(item => item.status)).toEqual([
    'ambiguous', 'missing-concept', 'missing-section', 'unsupported-block', 'unsafe',
  ]);
  const dialog = await openReader(page);
  await expect(dialog.getByRole('navigation', { name: '资料目录', exact: true })).toBeVisible();
  const ambiguous = dialog.getByRole('button', { name: '歧义引用', exact: true });
  const originalButton = await ambiguous.elementHandle();
  expect(originalButton).not.toBeNull();
  try {
    // Scrolling changes the active section. It must not remount the link while
    // the pointer is approaching it or between pointer down and pointer up.
    await ambiguous.scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('navigation', { name: '资料目录', exact: true })
      .getByRole('button', { name: '总览', exact: true })).toHaveAttribute('aria-current', 'location');
    expect(await originalButton!.evaluate(node => node.isConnected)).toBe(true);
    expect(await ambiguous.evaluate((node, original) => node === original, originalButton)).toBe(true);
  } finally { await originalButton?.dispose(); }
  for (const [label, message] of [
    ['歧义引用', '引用存在多个匹配项'], ['失效笔记', '引用的知识暂未找到'],
    ['失效章节', '引用章节已变化或不存在'], ['块引用', '暂不支持 ^ 块引用定位'],
    ['不安全路径', '此引用不属于允许的知识路径'],
  ]) {
    await dialog.getByRole('button', { name: label, exact: true }).click();
    await expect(dialog.locator('.reader-navigation-notice')).toContainText(message);
    await expect(dialog.getByRole('region', { name: '完整资料正文', exact: true })).toContainText('用于区分章节滚动位置');
    await expect(page.locator('dialog.concept-reader')).toHaveCount(1);
    await expect(dialog.getByRole('heading', { name: primary.title, exact: true })).toBeVisible();
  }
  await dialog.getByRole('button', { name: '关闭阅读窗口', exact: true }).click();
  expect(writes).toEqual([]);
  expect(await exported(request)).toEqual(before);
});

test('late metadata from a closed reader and mismatched revisions never install a stale directory', async ({ page, request }) => {
  let first = true;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let heldStarted!: () => void;
  const started = new Promise<void>(resolve => { heldStarted = resolve; });
  let heldFinished!: () => void;
  const finished = new Promise<void>(resolve => { heldFinished = resolve; });
  const { writes } = await prepare(page, request, async (route, data) => {
    if (first) {
      first = false;
      heldStarted();
      await held;
      // Closing the original reader aborts its fetch; fulfilling that already
      // canceled route is allowed to fail, but can never affect the new reader.
      try { await route.fulfill({ json: data }); } catch { /* canceled fetch */ }
      heldFinished();
    } else await route.fulfill({ json: { ...data, sourceRevision: `${data.sourceRevision}-stale` } });
  });
  const before = await exported(request);
  try {
    let dialog = await openReader(page);
    await started;
    await expect(dialog.getByRole('navigation', { name: '资料目录', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: '关闭阅读窗口', exact: true }).click();
    dialog = await openReader(page);
    await expect(dialog.locator('.reader-navigation-notice')).toHaveText('章节与引用暂不可用，正文仍可阅读。');
    release();
    await finished;
    await expect(dialog.getByRole('navigation', { name: '资料目录', exact: true })).toHaveCount(0);
    await expect(dialog.locator('.reader-navigation-notice')).toHaveText('章节与引用暂不可用，正文仍可阅读。');
    await expect(dialog.getByRole('region', { name: '完整资料正文', exact: true })).toContainText('中文');
    await dialog.getByRole('button', { name: '关闭阅读窗口', exact: true }).click();
    expect(writes).toEqual([]);
    expect(await exported(request)).toEqual(before);
  } finally { release(); }
});
