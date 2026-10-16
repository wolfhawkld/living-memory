import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import type { ActivityAppendRequest, ActivityExport } from '../../src/shared/activity';
import type { ExportData, Snapshot } from '../../src/shared/types';

test('an old reference requires an explicit current location and preserves old evidence when opening a new reader', async ({ page, request }) => {
  const session = await (await request.get('/api/session')).json() as { sourceId: string; writeToken: string };
  const snapshot = await (await request.get('/api/snapshot?scope=all')).json() as Snapshot;
  const concept = snapshot.concepts.find((item) => item.body.trim())!;
  expect(concept).toBeTruthy();
  let settings = (await (await request.get('/api/activity/settings')).json()).settings;
  const headers = { 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId };
  if (!settings.enabled) settings = (await (await request.post('/api/activity/settings', { headers,
    data: { enabled: true, expectedRevision: settings.revision } })).json()).settings;
  const id = `activity_reference_${randomUUID()}`;
  const historicalRevision = `frozen-historical-version-${id}`;
  const frozen: ActivityAppendRequest = { epoch: settings.epoch,
    event: { schemaVersion: 1, eventId: id, operationId: id, stepKey: 'selected', occurredAt: new Date().toISOString(),
      actor: { kind: 'user' }, channel: 'web', kind: 'query.selected', payload: {},
      refs: [{ conceptId: concept.id, title: concept.title, sourceRevision: historicalRevision, path: concept.source.path, scope: 'result' }] },
    delivery: { deliveryId: `${id}_delivery`, channel: 'web' } };
  const before = await (await request.get('/api/export')).json() as ExportData;
  const appended = await request.post('/api/activity', { headers, data: frozen }); expect(appended.ok()).toBeTruthy();
  const old = (await (await request.get('/api/activity/export')).json() as ActivityExport).events.find((item) => item.event.eventId === id)!;
  await page.goto('/');
  await page.getByRole('button', { name: '文字列表', exact: true }).click();
  await page.getByRole('button', { name: '查看真实记录', exact: true }).click();
  await page.getByRole('button', { name: '查阅记录', exact: true }).click();
  const history = page.getByRole('dialog', { name: '查阅记录', exact: true });
  await history.getByRole('combobox', { name: '概念', exact: true }).selectOption('');
  const entry = history.locator('.activity-history-reference').filter({ hasText: historicalRevision });
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText('资料版本已变化');
  await entry.getByRole('button', { name: '核对当前资料', exact: true }).click();
  const review = page.getByRole('dialog', { name: '重新选择当前阅读位置', exact: true });
  await expect(review).toBeVisible();
  await expect(review.getByRole('region', { name: '保留的原引用', exact: true })).toContainText(historicalRevision);
  const open = review.getByRole('button', { name: '打开当前资料', exact: true });
  await expect(open).toBeDisabled();
  const whole = review.getByRole('radio', { name: '当前全文', exact: true });
  await expect(whole).not.toBeChecked(); await expect(whole).toBeEnabled(); await whole.check();
  await open.click();
  const reader = page.getByRole('dialog', { name: concept.title, exact: true }); await expect(reader).toBeVisible();
  await expect.poll(async () => {
    const events = (await (await request.get('/api/activity/export')).json() as ActivityExport).events;
    return events.some((item) => item.event.kind === 'reader.opened' && item.event.refs.some((ref) => ref.conceptId === concept.id && ref.sourceRevision === concept.source.revision));
  }).toBe(true);
  await reader.getByRole('button', { name: '关闭阅读窗口', exact: true }).click();
  const afterActivity = await (await request.get('/api/activity/export')).json() as ActivityExport;
  expect(afterActivity.events.find((item) => item.event.eventId === id)).toEqual(old);
  const after = await (await request.get('/api/export')).json() as ExportData;
  const { exportedAt: _beforeTime, ...beforeLearning } = before;
  const { exportedAt: _afterTime, ...afterLearning } = after;
  expect(afterLearning).toEqual(beforeLearning);
});
