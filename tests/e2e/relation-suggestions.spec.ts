import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';
import { chooseDomain, domainIdOf } from '../../src/core/domain-view';
import type { ApplicationRecordRequest, ExportData, RelationSuggestion, Snapshot } from '../../src/shared/types';

async function exported(request: APIRequestContext): Promise<ExportData> {
  const response = await request.get('/api/export');
  expect(response.ok()).toBe(true);
  return response.json();
}

async function snapshot(request: APIRequestContext): Promise<Snapshot> {
  const response = await request.get('/api/snapshot');
  expect(response.ok()).toBe(true);
  return response.json();
}

test('a summary saves a frozen relation suggestion without altering knowledge or recall records', async ({ page, request }) => {
  const before = await exported(request);
  const graphBefore = await snapshot(request);
  const domainId = chooseDomain(graphBefore);
  const concept = graphBefore.concepts.find((item) => domainIdOf(item) === domainId);
  expect(concept).toBeDefined();
  const other = graphBefore.concepts.find((item) => domainIdOf(item) !== domainId && item.id !== concept!.id);
  expect(other).toBeDefined();
  const type = `e2e-relation-${randomUUID()}`;
  const description = '合成建议：两个领域的概念可能帮助解释同一个约束，仍需核对原始资料。';
  const content = `合成学习总结：因两个概念都涉及约束组合，提出一个待核对连接。${type}`;
  const endpoint = (value: typeof concept) => ({
    conceptId: value!.id, title: value!.title, path: value!.source.path, sourceRevision: value!.source.revision,
  });
  const expected: RelationSuggestion = {
    operation: 'add', source: endpoint(concept), target: endpoint(other), after: { type, description },
  };

  await page.goto('/');
  const realMode = page.getByRole('button', { name: '查看真实记录', exact: true });
  const demoMode = page.getByRole('button', { name: '查看示例状态', exact: true });
  await expect(realMode.or(demoMode)).toBeVisible();
  if (await realMode.isVisible()) await realMode.click();
  await expect(demoMode).toBeVisible();
  await page.getByRole('combobox', { name: '搜索概念', exact: true }).fill(concept!.title);
  await page.getByRole('listbox').getByRole('option').filter({ hasText: concept!.title }).first().click();
  await expect(page.locator('.detail-head h2')).toHaveText(concept!.title);
  await page.getByRole('button', { name: '记录应用 / 总结', exact: true }).click();
  const dialog = page.locator('dialog.application-record-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '学习总结', exact: true }).click();
  await dialog.getByLabel('自己的解释 / 总结', { exact: false }).fill(content);
  await dialog.locator('.relation-suggestion-fields > summary').click();
  await dialog.getByRole('checkbox', { name: '为这条记录添加一条关系建议' }).check();
  await dialog.getByLabel('搜索第二个概念', { exact: true }).fill(other!.id);
  const otherSelect = dialog.getByLabel('第二个概念（全部领域）', { exact: true });
  await expect(otherSelect.locator('option', { hasText: other!.source.path })).toContainText(other!.id);
  await otherSelect.selectOption(other!.id);
  await dialog.getByLabel('关系方向', { exact: true }).selectOption('outgoing');
  await dialog.getByLabel('建议操作', { exact: true }).selectOption('add');
  await dialog.getByLabel('建议关系类型', { exact: true }).fill(type);
  await dialog.getByLabel('建议关系描述（可选）', { exact: true }).fill(description);
  const submitted = page.waitForRequest((value) => value.method() === 'POST' && new URL(value.url()).pathname === '/api/applications');
  await dialog.getByRole('button', { name: '保存这条记录', exact: true }).click();
  const payload = (await submitted).postDataJSON() as ApplicationRecordRequest;
  expect(payload.kind).toBe('summary');
  expect(payload.content).toBe(content);
  expect(payload.correction).toBe('');
  expect(payload.relationSuggestion).toEqual(expected);
  await expect(dialog).toBeHidden();

  const history = page.getByRole('region', { name: '概念学习历史' });
  const entry = history.locator('.concept-history-entry').filter({ hasText: '总结 / insight' }).first();
  await entry.getByRole('button', { name: '展开应用 / 总结内容', exact: true }).click();
  await expect(entry).toContainText(content);
  const relation = entry.getByRole('region', { name: '关系建议快照' });
  await expect(relation.getByRole('heading', { name: '新增关系', exact: true })).toBeVisible();
  for (const value of [concept!, other!]) {
    await expect(relation).toContainText(value.title);
    await expect(relation).toContainText(value.id);
    await expect(relation).toContainText(value.source.path);
    await expect(relation).toContainText(value.source.revision);
  }
  await expect(relation).toContainText('待核对建议，尚未验证采纳');
  await expect(relation).toContainText('记录时快照，整理前核对当前知识源');
  const material = entry.getByRole('region', { name: '可复制的知识材料' });
  const relationField = material.getByRole('checkbox', { name: '关系建议（待核对）', exact: true });
  const markdown = material.locator('.application-material-output');
  await expect(relationField).toBeChecked();
  await expect(markdown).toContainText(type);
  await expect(markdown).toContainText(description);
  await expect(markdown).not.toContainText(content);
  await relationField.uncheck();
  await expect(markdown).not.toContainText(type);
  await expect(markdown).not.toContainText(description);
  await expect(markdown).not.toContainText(other!.id);
  await relationField.check();
  await expect(markdown).toContainText(type);

  await expect.poll(async () => (await exported(request)).applications?.some((record) => record.eventId === payload.eventId)).toBe(true);
  const after = await exported(request);
  const saved = after.applications!.find((record) => record.eventId === payload.eventId)!;
  const { recordedAt, ...storedPayload } = saved;
  expect(recordedAt).toBeTruthy();
  expect(storedPayload).toEqual(payload);
  expect(saved.relationSuggestion).toEqual(expected);
  expect(after.applications!.filter((record) => record.eventId !== payload.eventId)).toEqual(before.applications ?? []);
  for (const field of ['anchors', 'observations', 'config', 'configHistory', 'retentions', 'corrections'] as const) expect(after[field]).toEqual(before[field]);
  const graphAfter = await snapshot(request);
  expect(graphAfter.links).toEqual(graphBefore.links);
  expect(graphAfter.concepts).toEqual(graphBefore.concepts);
});
