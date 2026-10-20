import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { chooseDomain, domainIdOf } from '../../src/core/domain-view';
import type { Concept, ExportData, ObservationRequest, Snapshot } from '../../src/shared/types';
import type { ObservationRevisionRequest } from '../../src/shared/observation-revisions';
import type { ObservationRevisionHistory } from '../../src/shared/observation-revision-history';
import type { ReviewPlanResponse } from '../../src/shared/review-plan';

const dialogTitle = '修订已保存的学习观察';
const pendingKeyPrefix = 'living-memory.observation-revision-pending.v1';
function revisionPath(id: string) { return `/api/observations/${encodeURIComponent(id)}/revisions`; }
function isPost(url: string, method: string, id: string) { return method === 'POST' && new URL(url).pathname === revisionPath(id); }
async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path); expect(response.ok()).toBe(true); return response.json();
}
async function realMode(page: Page) {
  const real = page.getByRole('button', { name: '查看真实记录', exact: true });
  const example = page.getByRole('button', { name: '查看示例状态', exact: true });
  await expect(real.or(example)).toBeVisible();
  if (await real.isVisible()) await real.click();
  await expect(example).toBeVisible();
}
async function openConcept(page: Page, concept: Concept) {
  await page.goto('/'); await realMode(page);
  await page.getByRole('button', { name: '文字列表', exact: true }).click();
  await page.getByRole('combobox', { name: '搜索概念', exact: true }).fill(concept.title);
  const option = page.getByRole('listbox', { name: '概念搜索结果', exact: true }).getByRole('option').filter({
    has: page.getByText(concept.title, { exact: true }),
  });
  await expect(option).toHaveCount(1); await option.click();
  await expect(page.locator('.detail-head h2')).toHaveText(concept.title);
}
function entry(page: Page, id: string) {
  return page.getByRole('region', { name: '概念学习历史', exact: true }).locator(`[data-observation-event-id="${id}"]`);
}
async function openRevision(page: Page, id: string) {
  await entry(page, id).getByRole('button', { name: '修订这条观察', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: dialogTitle, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('操作', { exact: true })).toBeEnabled();
  return dialog;
}
async function seed(request: APIRequestContext) {
  const snapshot = await getJson<Snapshot>(request, '/api/snapshot?scope=all');
  const domain = chooseDomain(snapshot);
  const concept = snapshot.concepts.find(item => domainIdOf(item) === domain
    && snapshot.concepts.filter(other => other.title === item.title).length === 1)!;
  expect(concept).toBeTruthy();
  const session = await getJson<{ writeToken: string; sourceId: string; instanceId: string }>(request, '/api/session');
  const now = new Date(Date.now() - 1000).toISOString();
  const observation: ObservationRequest = {
    eventId: randomUUID(), conceptId: concept.id, sourceRevision: concept.source.revision,
    observedAt: now, configRevision: snapshot.config.revision, anchorEventId: snapshot.states[concept.id]?.anchor?.eventId ?? null,
    answer: `PRIVATE_ORIGINAL_ANSWER_${randomUUID()}`, evidenceMode: 'written', rating: 'clear', exposure: 'unexposed', observedExposure: false,
    learning: { task: 'scenario', scenario: `PRIVATE_SCENARIO_${randomUUID()}`, confidence: 80, confidenceAt: now,
      cue: 'independent', outcome: 'success', basis: 'self-check' },
  };
  const created = await request.post('/api/observations', { headers: { 'x-lm-token': session.writeToken,
    'x-lm-source-id': session.sourceId, 'x-lm-instance-id': session.instanceId }, data: observation });
  expect(created.status()).toBe(201);
  return { concept, observation, session };
}
async function submit(page: Page, dialog: Locator, id: string) {
  const responsePromise = page.waitForResponse(response => isPost(response.url(), response.request().method(), id));
  await dialog.getByRole('button', { name: '确认提交决定', exact: true }).click();
  const response = await responsePromise;
  const headers = response.request().headers();
  expect(headers['x-lm-learning-protocol']).toBe('2');
  expect(headers['x-lm-token']).toBeTruthy(); expect(headers['x-lm-source-id']).toBeTruthy(); expect(headers['x-lm-instance-id']).toBeTruthy();
  return { response, payload: response.request().postDataJSON() as ObservationRevisionRequest };
}
async function close(page: Page) {
  await page.getByRole('dialog', { name: dialogTitle, exact: true }).getByRole('button', { name: '关闭修订', exact: true }).click();
  await expect(page.getByRole('dialog', { name: dialogTitle, exact: true })).toHaveCount(0);
}
async function pendingRows(page: Page) {
  return page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix))
    .flatMap(key => (JSON.parse(localStorage.getItem(key)!) as { rows: Array<{ state: string; request: ObservationRevisionRequest }> }).rows), pendingKeyPrefix);
}

test('saved observation revise, withdraw and reinstate refresh adopted summaries without rewriting memory evidence', async ({ page, request }) => {
  const { concept, observation, session } = await seed(request);
  await openConcept(page, concept);
  const before = await getJson<ExportData>(request, '/api/export');
  const planBefore = await getJson<ReviewPlanResponse>(request, '/api/review-plan?timeZone=UTC');
  const historyPath = `/api/concepts/${encodeURIComponent(concept.id)}/history`;
  const historyBefore = await getJson<{ learning: { calibration: { scenario: { count: number } } } }>(request, historyPath);
  const initialCount = historyBefore.learning.calibration.scenario.count;
  // Inspect the actual dialog surface in both themes; inherited text alone
  // cannot hide a missing dark background token behind a transparent modal.
  const surfaces: string[] = [];
  for (const theme of ['dark', 'light'] as const) {
    await page.getByRole('combobox', { name: '主题', exact: true }).selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const inspection = await openRevision(page, observation.eventId);
    const colors = await inspection.evaluate(element => {
      const surface = getComputedStyle(element);
      const text = getComputedStyle(element.querySelector('h2')!);
      const alpha = (value: string) => {
        const probe = document.createElement('canvas').getContext('2d')!;
        probe.fillStyle = value; probe.fillRect(0, 0, 1, 1);
        return probe.getImageData(0, 0, 1, 1).data[3];
      };
      return { background: surface.backgroundColor, backgroundAlpha: alpha(surface.backgroundColor), textAlpha: alpha(text.color) };
    });
    expect(colors.backgroundAlpha).toBeGreaterThan(0); expect(colors.textAlpha).toBeGreaterThan(0);
    surfaces.push(colors.background);
    // The task entry is explicitly disabled, even before modal inertness is
    // considered, so another learning task cannot coexist with this editor.
    await expect(page.locator('button.recall-button').filter({ hasText: '先想一句，再查看资料' })).toBeDisabled();
    await close(page);
  }
  expect(surfaces[1]).not.toBe(surfaces[0]);
  await page.getByRole('combobox', { name: '主题', exact: true }).selectOption('dark');
  await page.locator('button.recall-button').filter({ hasText: '先想一句，再查看资料' }).click();
  const recall = page.getByRole('dialog', { name: concept.title, exact: true });
  await expect(recall).toBeVisible();
  await expect(page.getByRole('region', { name: '概念学习历史', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '修订这条观察', exact: true })).toHaveCount(0);
  await expect(page.getByText(observation.answer, { exact: true })).toHaveCount(0);
  await expect(page.getByText(observation.learning!.scenario!, { exact: true })).toHaveCount(0);
  await recall.getByRole('button', { name: '取消回忆', exact: true }).click();
  await expect(recall).toHaveCount(0);
  await expect(entry(page, observation.eventId)).toBeVisible();
  for (const [index, action] of (['revise', 'withdraw', 'reinstate'] as const).entries()) {
    const dialog = await openRevision(page, observation.eventId);
    await expect(page.getByText(observation.answer, { exact: true })).toHaveCount(0);
    await expect(page.getByText(observation.learning!.scenario!, { exact: true })).toHaveCount(0);
    await dialog.getByLabel('操作', { exact: true }).selectOption(action);
    if (action === 'revise') {
      await dialog.getByLabel('自评', { exact: true }).selectOption('blank');
      await dialog.getByLabel('核对结果', { exact: true }).selectOption('failure');
    }
    await dialog.getByLabel('决定原因', { exact: true }).selectOption('rechecked-original');
    const { response, payload } = await submit(page, dialog, observation.eventId);
    expect(response.status()).toBe(201); expect(payload.action).toBe(action);
    expect(response.request().headers()['x-lm-source-id']).toBe(session.sourceId);
    await expect(dialog).toContainText('已保存，当前采用状态已刷新。');
    await expect(dialog.locator('section').filter({ has: page.getByRole('heading', { name: '当前采用', exact: true }) }))
      .toContainText(action === 'withdraw' ? '暂不计入统计' : '想不起');
    await close(page);
    await expect(entry(page, observation.eventId)).toContainText(action === 'withdraw' ? '暂不计入统计' : '想不起');
    await expect.poll(async () => (await getJson<ObservationRevisionHistory>(request, `${revisionPath(observation.eventId)}?limit=20`)).total).toBe(index + 1);
    const history = await getJson<{ learning: { calibration: { scenario: { count: number } } } }>(request, historyPath);
    expect(history.learning.calibration.scenario.count).toBe(action === 'withdraw' ? initialCount - 1 : initialCount);
  }
  const after = await getJson<ExportData>(request, '/api/export');
  for (const key of ['observations', 'anchors', 'retentions', 'config', 'configHistory', 'practice', 'reviewPlan'] as const) expect(after[key]).toEqual(before[key]);
  const planAfter = await getJson<ReviewPlanResponse>(request, '/api/review-plan?timeZone=UTC');
  expect(planAfter.plan).toEqual(planBefore.plan);
  expect(planAfter.completedConceptIds).toEqual(planBefore.completedConceptIds);
  expect(planAfter.plan.dailyBudget - planAfter.completedConceptIds.length)
    .toBe(planBefore.plan.dailyBudget - planBefore.completedConceptIds.length);
  expect(after.observationRevisions?.filter(item => item.observationEventId === observation.eventId)).toHaveLength(3);
});

test('lost accepted response survives closing and retries the exact durable request as a duplicate', async ({ page, request }) => {
  const { concept, observation } = await seed(request); await openConcept(page, concept);
  const dialog = await openRevision(page, observation.eventId);
  await dialog.getByLabel('自评', { exact: true }).selectOption('partial');
  await dialog.getByLabel('决定原因', { exact: true }).selectOption('input-error');
  let original: ObservationRevisionRequest | undefined;
  await page.route(`**${revisionPath(observation.eventId)}`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    original = route.request().postDataJSON() as ObservationRevisionRequest;
    const rows = await pendingRows(page);
    expect(rows.find(row => row.request.eventId === original!.eventId)?.request).toEqual(original);
    const accepted = await route.fetch(); expect(accepted.status()).toBe(201);
    await route.abort('failed');
  });
  await dialog.getByRole('button', { name: '确认提交决定', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '重试原待同步请求', exact: true })).toBeEnabled();
  await close(page); await page.unroute(`**${revisionPath(observation.eventId)}`);
  await page.reload(); await realMode(page);
  const pending = page.getByRole('region', { name: '自评修订待同步', exact: true });
  await expect(pending).toContainText(observation.eventId);
  await pending.getByRole('button', { name: '查看并处理', exact: true }).click();
  const reopened = page.getByRole('dialog', { name: dialogTitle, exact: true });
  const duplicateResponse = page.waitForResponse(response => isPost(response.url(), response.request().method(), observation.eventId));
  await reopened.getByRole('button', { name: '重试原待同步请求', exact: true }).click();
  const duplicate = await duplicateResponse;
  expect(duplicate.status()).toBe(200); expect(await duplicate.json()).toMatchObject({ status: 'duplicate', eventId: original!.eventId });
  expect(duplicate.request().postDataJSON()).toEqual(original);
  await expect(reopened).toContainText('已保存，当前采用状态已刷新。');
  await expect.poll(async () => (await pendingRows(page)).filter(row => row.request.eventId === original!.eventId).length).toBe(0);
  expect((await getJson<ObservationRevisionHistory>(request, `${revisionPath(observation.eventId)}?limit=20`)).total).toBe(1);
});

test('concurrent predecessor conflict needs fresh inspection, archival and a separately confirmed new decision', async ({ page, context, request }) => {
  const { concept, observation } = await seed(request); const other = await context.newPage();
  try {
    await openConcept(page, concept); await openConcept(other, concept);
    const first = await openRevision(page, observation.eventId); const second = await openRevision(other, observation.eventId);
    for (const [dialog, rating] of [[first, 'partial'], [second, 'blank']] as const) {
      await dialog.getByLabel('自评', { exact: true }).selectOption(rating);
      await dialog.getByLabel('决定原因', { exact: true }).selectOption('input-error');
    }
    const accepted = await submit(page, first, observation.eventId); expect(accepted.response.status()).toBe(201);
    await expect(first).toContainText('已保存，当前采用状态已刷新。');
    await expect.poll(async () => (await pendingRows(page)).filter(row => row.state !== 'archived').length).toBe(0);
    const rejected = await submit(other, second, observation.eventId); expect(rejected.response.status()).toBe(409);
    expect(await rejected.response.json()).toMatchObject({ error: { code: 'OBSERVATION_REVISION_PREVIOUS_EVENT_CONFLICT' } });
    expect(rejected.payload.previousEventId).toBe(accepted.payload.previousEventId);
    await expect(second).toContainText('原请求已被拒绝');
    const posts: ObservationRevisionRequest[] = [];
    other.on('request', req => { if (isPost(req.url(), req.method(), observation.eventId)) posts.push(req.postDataJSON() as ObservationRevisionRequest); });
    const freshRead = other.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === revisionPath(observation.eventId));
    await second.getByRole('button', { name: '重新核对当前状态', exact: true }).click();
    expect((await freshRead).ok()).toBe(true);
    await expect(second).toContainText('请重新选择原因');
    await expect(second.getByLabel('决定原因', { exact: true })).toHaveValue('');
    await expect(second.getByRole('button', { name: '确认提交决定', exact: true })).toBeDisabled();
    expect(posts).toEqual([]);
    const archived = (await pendingRows(other)).find(row => row.request.eventId === rejected.payload.eventId);
    expect(archived).toEqual(expect.objectContaining({ state: 'archived', request: rejected.payload }));
    await second.getByLabel('自评', { exact: true }).selectOption('blank');
    await second.getByLabel('决定原因', { exact: true }).selectOption('rechecked-original');
    const replacement = await submit(other, second, observation.eventId); expect(replacement.response.status()).toBe(201);
    expect(replacement.payload.eventId).not.toBe(rejected.payload.eventId);
    expect(replacement.payload.previousEventId).toBe(accepted.payload.eventId);
    expect(posts).toEqual([replacement.payload]);
    await expect(second).toContainText('已保存，当前采用状态已刷新。');
    const history = await getJson<ObservationRevisionHistory>(request, `${revisionPath(observation.eventId)}?limit=20`);
    expect(history.events.map(event => event.eventId).sort()).toEqual([accepted.payload.eventId, replacement.payload.eventId].sort());
    expect(history.state.currentAssessment.rating).toBe('blank');
  } finally { await other.close(); }
});
