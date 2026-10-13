import { test, expect } from './fixtures';
import type { ReviewPlanResponse } from '../../src/shared/review-plan';
import type { ExportData, Snapshot } from '../../src/shared/types';

test('zero budget persists a pause, rejects an empty draft and leaves manual learning available', async ({ page, request }) => {
  const planResponse = await request.get('/api/review-plan');
  expect(planResponse.ok()).toBeTruthy();
  const initial = await planResponse.json() as ReviewPlanResponse;
  const session = await (await request.get('/api/session')).json() as { sourceId: string; writeToken: string };
  const readPlan = async () => {
    const response = await request.get('/api/review-plan');
    expect(response.ok()).toBeTruthy();
    return await response.json() as ReviewPlanResponse;
  };
  try {
    let editingPlan = initial;
    if (initial.plan.dailyBudget === 0) {
      const positive = await request.put('/api/review-plan', {
        headers: { 'x-lm-source-id': session.sourceId, 'x-lm-token': session.writeToken },
        data: { revision: initial.plan.revision, dailyBudget: 3 },
      });
      expect(positive.ok()).toBeTruthy();
      editingPlan = await positive.json() as ReviewPlanResponse;
    }
    await page.goto('/');
    const real = page.getByRole('button', { name: '查看真实记录', exact: true });
    const demo = page.getByRole('button', { name: '查看示例状态', exact: true });
    await expect(real.or(demo)).toBeVisible();
    if (await real.isVisible()) await real.click();
    const panel = page.locator('.brief-review-panel');
    await panel.getByRole('button', { name: '复习安排', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '复习安排', exact: true });
    const input = dialog.getByRole('spinbutton', { name: /^数量/ });
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue(String(editingPlan.plan.dailyBudget));
    const before = await (await request.get('/api/export')).json() as ExportData;
    await input.fill('');
    await expect(dialog.getByRole('button', { name: '保存每日预算', exact: true })).toBeDisabled();
    expect((await readPlan()).plan).toEqual(editingPlan.plan);
    await input.fill('0');
    await dialog.getByRole('button', { name: '保存每日预算', exact: true }).click();
    await expect.poll(async () => (await readPlan()).plan.dailyBudget).toBe(0);
    await expect(dialog.getByRole('button', { name: '保存每日预算', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: '关闭复习安排', exact: true }).click();
    await expect(panel).toContainText('每日复习推荐已暂停');
    await expect(panel.getByRole('button', { name: '开始复习', exact: true })).toBeDisabled();
    await page.reload();
    await expect(panel).toContainText('每日复习推荐已暂停');
    const after = await (await request.get('/api/export')).json() as ExportData;
    expect(after.anchors).toEqual(before.anchors);
    expect(after.observations).toEqual(before.observations);
    expect(after.config).toEqual(before.config);
    // The shared synthetic account may already have learning history from other tests.
    const snapshot = await (await request.get('/api/snapshot')).json() as Snapshot;
    const concept = snapshot.concepts.find(item => item.title === '内积')!;
    const search = page.getByRole('combobox', { name: '搜索概念', exact: true });
    await search.fill(concept.title);
    await page.getByRole('listbox').getByRole('option').filter({ hasText: concept.title }).first().click();
    await expect(page.locator('.detail-head h2')).toHaveText(concept.title);
    await expect(page.getByRole('button', { name: '确认已重温', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: /先想一句，再查看资料/ }).click();
    await page.getByRole('button', { name: '开始作答', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '回忆答案', exact: true })).toBeVisible();
  } finally {
    const current = await readPlan();
    const restored = await request.put('/api/review-plan', {
      headers: { 'x-lm-source-id': session.sourceId, 'x-lm-token': session.writeToken },
      data: { revision: current.plan.revision, dailyBudget: initial.plan.dailyBudget },
    });
    expect(restored.ok()).toBeTruthy();
  }
});
