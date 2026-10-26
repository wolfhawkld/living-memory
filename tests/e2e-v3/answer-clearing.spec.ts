import { test, expect, seed, openConcept, openClear, entry, clearPath, headers, storageCopies, realMode } from './fixtures';

test('explicit cancellation and bodyless confirmation work in both themes and preserve saved facts', async ({ page, request, session }) => {
  const { concept, observation } = await seed(request, session);
  await openConcept(page, concept);
  const surfaces: string[] = [];
  let posts = 0;
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith(clearPath(observation.eventId))) posts++; });
  for (const theme of ['dark', 'light']) {
    await page.getByRole('combobox', { name: '主题', exact: true }).selectOption(theme);
    const dialog = await openClear(page, observation.eventId);
    await expect(dialog).toContainText('不可恢复');
    await expect(dialog).not.toContainText(observation.answer);
    const color = await dialog.evaluate(element => getComputedStyle(element).backgroundColor);
    expect(color).not.toBe('rgba(0, 0, 0, 0)'); surfaces.push(color);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
  }
  expect(surfaces[0]).not.toBe(surfaces[1]); expect(posts).toBe(0);
  const before = await (await request.get('/api/export')).json();
  const dialog = await openClear(page, observation.eventId);
  const response = page.waitForResponse(res => res.request().method() === 'POST' && res.url().endsWith(clearPath(observation.eventId)));
  await dialog.getByRole('button', { name: '确认永久清除原答', exact: true }).click();
  const cleared = await response;
  expect(cleared.status()).toBe(201); expect(cleared.request().postData()).toBeNull();
  expect(cleared.request().headers()).toMatchObject({ 'x-lm-learning-protocol': '3', 'x-lm-source-id': session.sourceId, 'x-lm-instance-id': session.instanceId });
  await expect(page.locator('.answer-clearing-dialog')).toContainText('当前浏览器可管理的副本已清理');
  await page.getByRole('button', { name: '关闭原答清除', exact: true }).click();
  await expect(entry(page, observation.eventId)).toContainText('原答已清除');
  await expect(page.getByText(observation.answer, { exact: true })).toHaveCount(0);
  const after = await (await request.get('/api/export')).json();
  for (const key of ['anchors', 'retentions', 'config', 'configHistory', 'reviewPlan']) expect(after[key]).toEqual(before[key]);
  expect(after.observations.find((item: { eventId: string }) => item.eventId === observation.eventId)).toMatchObject({ answer: null, rating: observation.rating });
});

test('lost POST response remains unknown and same-event GET confirms it without a second POST', async ({ page, request, session }) => {
  const { concept, observation } = await seed(request, session);
  await page.route('**/api/changes*', route => route.abort());
  await openConcept(page, concept);
  const dialog = await openClear(page, observation.eventId);
  // Keep incidental history refreshes from resolving the result in this test.
  await page.route('**/api/concepts/*/history*', route => route.abort());
  let posts = 0;
  await page.route(`**${clearPath(observation.eventId)}`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++; expect((await route.fetch()).status()).toBe(201); await route.abort('failed');
  });
  await dialog.getByRole('button', { name: '确认永久清除原答', exact: true }).click();
  await expect(page.locator('.answer-clearing-dialog')).toContainText('提交结果未知');
  await page.getByRole('button', { name: '核对服务端状态', exact: true }).click();
  await expect(page.locator('.answer-clearing-dialog')).toContainText('当前浏览器可管理的副本已清理');
  expect(posts).toBe(1);
  const status = await (await request.get(clearPath(observation.eventId), { headers: headers(session) })).json();
  expect(status.status).toBe('cleared'); expect(Object.keys(status).sort()).toEqual(['clearedAt', 'observationEventId', 'status']);
});

test('two tabs redact open originals and preserve revision notes while removing only matching local copies', async ({ page, context, request, session }) => {
  const { concept, observation } = await seed(request, session);
  await openConcept(page, concept);
  const other = await context.newPage(); await openConcept(other, concept);
  await entry(other, observation.eventId).getByRole('button', { name: '修订这条观察', exact: true }).click();
  const revision = other.getByRole('dialog', { name: '修订已保存的学习观察', exact: true });
  await expect(revision.getByLabel('说明（可选，最多 1000 字符）')).toBeEnabled();
  await revision.getByLabel('说明（可选，最多 1000 字符）').fill('独立修订说明必须保留');
  await revision.getByRole('button', { name: '展开原始回答', exact: true }).click();
  await expect(revision).toContainText(observation.answer);
  const copies = storageCopies(session, concept, observation);
  const unrelated = { id: 'keep-unrelated', method: 'POST', path: '/applications', eventId: 'keep-unrelated', conceptId: concept.id,
    payload: { content: 'INDEPENDENT_KEEP' }, label: 'Independent unsent', createdAt: new Date().toISOString() };
  await context.route('**/api/observations', route => route.request().method() === 'POST' ? route.abort() : route.continue());
  await context.route('**/api/applications', route => route.request().method() === 'POST' ? route.abort() : route.continue());
  await page.evaluate(({ copies, unrelated }) => {
    localStorage.setItem(copies.pendingKey, JSON.stringify([...copies.pending, unrelated]));
    localStorage.setItem(copies.checkpointKey, copies.checkpoint);
  }, { copies, unrelated });
  const dialog = await openClear(page, observation.eventId);
  await dialog.getByRole('button', { name: '确认永久清除原答', exact: true }).click();
  await expect(page.locator('.answer-clearing-dialog')).toContainText('当前浏览器可管理的副本已清理');
  await expect(revision).toContainText('原答已清除');
  await expect(revision.getByLabel('说明（可选，最多 1000 字符）')).toHaveValue('独立修订说明必须保留');
  await expect(other.getByText(observation.answer, { exact: true })).toHaveCount(0);
  const stored = await page.evaluate(copies => ({ pending: JSON.parse(localStorage.getItem(copies.pendingKey)!), checkpoint: JSON.parse(localStorage.getItem(copies.checkpointKey)!) }), copies);
  expect(stored.pending).toEqual([unrelated]); expect(stored.checkpoint.attempt).toBeNull();
  expect(stored.checkpoint.session.results[concept.id]).toBe('saved');
  expect(JSON.stringify(stored)).not.toContain(observation.answer);
  await other.close();
});

test('delayed intact revision responses cannot restore an answer after another tab clears it', async ({ page, context, request, session }) => {
  const { concept, observation } = await seed(request, session); await openConcept(page, concept);
  const other = await context.newPage(); await openConcept(other, concept);
  let release!: () => void, intercepted!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { intercepted = resolve; });
  let captured = false;
  await other.route(`**/api/observations/${observation.eventId}/revisions*`, async route => {
    if (captured) return route.continue();
    captured = true; const response = await route.fetch(); intercepted(); await held;
    try { await route.fulfill({ response }); } catch { /* Product aborted the stale request. */ }
  });
  await entry(other, observation.eventId).getByRole('button', { name: '修订这条观察', exact: true }).click();
  await ready;
  const dialog = await openClear(page, observation.eventId);
  await dialog.getByRole('button', { name: '确认永久清除原答', exact: true }).click();
  await expect(page.locator('.answer-clearing-dialog')).toContainText('当前浏览器可管理的副本已清理');
  release();
  const revision = other.getByRole('dialog', { name: '修订已保存的学习观察', exact: true });
  await expect(revision).toContainText('原答已清除');
  await expect(other.getByText(observation.answer, { exact: true })).toHaveCount(0);
  await other.reload(); await realMode(other);
  await expect(other.getByText(observation.answer, { exact: true })).toHaveCount(0);
  await other.close();
});

test('local storage cleanup failure remains explicit and retry repairs only the browser copy', async ({ page, request, session }) => {
  const { concept, observation } = await seed(request, session); await openConcept(page, concept);
  const copies = storageCopies(session, concept, observation);
  await page.evaluate(copies => {
    localStorage.setItem(copies.checkpointKey, copies.checkpoint);
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === copies.checkpointKey) throw new DOMException('synthetic denied', 'QuotaExceededError');
      return original.call(this, key, value);
    };
    (window as unknown as { restoreStorage(): void }).restoreStorage = () => { Storage.prototype.setItem = original; };
  }, copies);
  const dialog = await openClear(page, observation.eventId);
  await dialog.getByRole('button', { name: '确认永久清除原答', exact: true }).click();
  await expect(page.locator('.answer-clearing-dialog')).toContainText('副本未完成清理');
  expect((await (await request.get(clearPath(observation.eventId), { headers: headers(session) })).json()).status).toBe('cleared');
  await page.evaluate(() => (window as unknown as { restoreStorage(): void }).restoreStorage());
  await page.getByRole('button', { name: '重试本地清理', exact: true }).click();
  await expect(page.locator('.answer-clearing-dialog')).toContainText('当前浏览器可管理的副本已清理');
  expect(await page.evaluate(key => localStorage.getItem(key), copies.checkpointKey)).not.toContain(observation.answer);
});

test('refresh recovers a persisted unknown intent using GET and never queues a deletion', async ({ page, request, session }) => {
  const { concept, observation } = await seed(request, session);
  await page.route('**/api/changes*', route => route.abort());
  await openConcept(page, concept);
  const dialog = await openClear(page, observation.eventId);
  await page.route('**/api/concepts/*/history*', route => route.abort());
  let posts = 0;
  await page.route(`**${clearPath(observation.eventId)}`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++; await route.fetch(); await route.abort();
  });
  await dialog.getByRole('button', { name: '确认永久清除原答', exact: true }).click();
  await expect(page.locator('.answer-clearing-dialog')).toContainText('提交结果未知');
  await page.unroute('**/api/concepts/*/history*');
  await page.reload(); await realMode(page);
  await expect.poll(async () => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('living-memory.answer-privacy.v1.'))
    .flatMap(key => JSON.parse(localStorage.getItem(key)!)).filter(item => item.status === 'pending').length)).toBe(0);
  expect(posts).toBe(1);
  const pending = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('living-memory.pending-writes.v1.')).map(key => localStorage.getItem(key)).join(''));
  expect(pending).not.toContain('answer-clearing');
});

test('a held history page cannot merge an intact original back into an already cleared timeline', async ({ page, context, request, session }) => {
  const { concept, observation } = await seed(request, session);
  for (let index = 0; index < 22; index++) {
    const response = await request.post('/api/observations', { headers: headers(session), data: {
      ...observation, eventId: `${observation.eventId}-page-${index}`, observedAt: new Date().toISOString(), answer: `Other page item ${index}`,
    } });
    expect(response.status()).toBe(201);
  }
  await openConcept(page, concept);
  while (await entry(page, observation.eventId).count() === 0) {
    await page.getByRole('region', { name: '概念学习历史', exact: true }).getByRole('button', { name: '加载更多历史', exact: true }).click();
    await expect(page.getByRole('region', { name: '概念学习历史', exact: true })).not.toHaveAttribute('aria-busy', 'true');
  }
  const other = await context.newPage(); await openConcept(other, concept);
  let release!: () => void, intercepted!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { intercepted = resolve; });
  let captured = false;
  await other.route('**/api/concepts/*/history*', async route => {
    if (captured || !new URL(route.request().url()).searchParams.has('cursor')) return route.continue();
    captured = true; const response = await route.fetch(); intercepted(); await held;
    try { await route.fulfill({ response }); } catch { /* The privacy invalidation aborts old pagination. */ }
  });
  await other.getByRole('region', { name: '概念学习历史', exact: true }).getByRole('button', { name: '加载更多历史', exact: true }).click();
  await ready;
  const dialog = await openClear(page, observation.eventId);
  await dialog.getByRole('button', { name: '确认永久清除原答', exact: true }).click();
  await expect(page.locator('.answer-clearing-dialog')).toContainText('当前浏览器可管理的副本已清理');
  release();
  await expect(other.getByRole('region', { name: '概念学习历史', exact: true })).not.toHaveAttribute('aria-busy', 'true');
  while (await entry(other, observation.eventId).count() === 0) {
    await other.getByRole('region', { name: '概念学习历史', exact: true }).getByRole('button', { name: '加载更多历史', exact: true }).click();
    await expect(other.getByRole('region', { name: '概念学习历史', exact: true })).not.toHaveAttribute('aria-busy', 'true');
  }
  await expect(entry(other, observation.eventId)).toContainText('原答已清除');
  await expect(other.getByText(observation.answer, { exact: true })).toHaveCount(0);
  await other.close();
});
