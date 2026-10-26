import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Concept, ObservationRequest, Snapshot } from '../../src/shared/types';
import { domainIdOf } from '../../src/core/domain-view';
import { instanceStorageKey } from '../../src/web/instance-storage';
import { briefReviewCheckpointKey, serializeBriefReviewCheckpoint, type BriefReviewCheckpoint } from '../../src/web/brief-review-checkpoint';

export interface Session { writeToken: string; sourceId: string; instanceId: string; learningProtocolVersion: number }
export const test = base.extend<{ session: Session }>({
  request: async ({ playwright, baseURL }, use) => {
    const request = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { 'X-LM-Learning-Protocol': '3' } });
    try { await use(request); } finally { await request.dispose(); }
  },
  session: [async ({ request, context }, use) => {
    const status = await (await request.get('/api/auth/status')).json();
    const auth = await request.post(status.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
      data: { username: 'synthetic-v3-owner', password: 'synthetic-v3-password-2026' },
    });
    expect(auth.ok()).toBe(true);
    const session: Session = await (await request.get('/api/session')).json();
    expect(session.learningProtocolVersion).toBe(3); expect(session.instanceId).toBeTruthy();
    await context.addCookies((await request.storageState()).cookies);
    await use(session);
  }, { auto: true }],
});
export { expect };
export const headers = (session: Session) => ({ 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId,
  'x-lm-instance-id': session.instanceId, 'x-lm-learning-protocol': '3' });
export const clearPath = (id: string) => `/api/observations/${encodeURIComponent(id)}/answer-clearing`;
export const entry = (page: Page, id: string) => page.locator(`[data-observation-event-id="${id}"]`);
export async function seed(request: APIRequestContext, session: Session) {
  const snapshot: Snapshot = await (await request.get('/api/snapshot?scope=all')).json();
  const concept = snapshot.concepts.find(item => item.title === 'Alpha')!;
  const now = new Date(Date.now() - 1000).toISOString();
  const observation: ObservationRequest = { eventId: randomUUID(), conceptId: concept.id, sourceRevision: concept.source.revision,
    observedAt: now, configRevision: snapshot.config.revision, anchorEventId: null,
    answer: `SYNTHETIC_ANSWER_${randomUUID()}`, rating: 'clear', exposure: 'unexposed', observedExposure: false,
    learning: { task: 'concept', confidence: 75, confidenceAt: now, cue: 'independent', outcome: 'success', basis: 'self-check' } };
  expect((await request.post('/api/observations', { headers: headers(session), data: observation })).status()).toBe(201);
  return { snapshot, concept, observation };
}
export async function realMode(page: Page) {
  const real = page.getByRole('button', { name: '查看真实记录', exact: true });
  const demo = page.getByRole('button', { name: '查看示例状态', exact: true });
  await expect(real.or(demo)).toBeVisible();
  if (await real.isVisible()) await real.click();
  await expect(demo).toBeVisible();
}
export async function openConcept(page: Page, concept: Concept) {
  await page.goto('/'); await realMode(page);
  await page.getByRole('button', { name: '文字列表', exact: true }).click();
  await page.getByRole('combobox', { name: '搜索概念', exact: true }).fill(concept.title);
  await page.getByRole('listbox', { name: '概念搜索结果', exact: true }).getByRole('option').filter({ has: page.getByText(concept.title, { exact: true }) }).click();
  await expect(page.locator('.detail-head h2')).toHaveText(concept.title);
}
export async function openClear(page: Page, id: string) {
  await entry(page, id).getByRole('button', { name: '清除这条原答', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '清除这条原答', exact: true });
  await expect(dialog).toBeVisible(); return dialog;
}
export function storageCopies(session: Session, concept: Concept, observation: ObservationRequest) {
  const checkpoint: BriefReviewCheckpoint = { version: 1, savedAt: new Date().toISOString(),
    session: { id: `brief-${randomUUID()}`, sourceId: session.sourceId, domainId: domainIdOf(concept),
      index: 0, results: {}, reviews: {}, items: [{ conceptId: concept.id, title: concept.title, sourceRevision: concept.source.revision,
        status: 'stale', elapsedDays: 14, estimated: false }] },
    attempt: { conceptId: concept.id, eventId: observation.eventId, answer: observation.answer,
      startedAt: observation.observedAt, observedAt: observation.observedAt, configRevision: observation.configRevision,
      anchorEventId: observation.anchorEventId, sourceRevision: observation.sourceRevision, sourceViewedBefore: false,
      stage: 'feedback', rating: observation.rating, exposure: observation.exposure, learning: observation.learning!, submittedPayload: observation } };
  return {
    checkpointKey: instanceStorageKey(briefReviewCheckpointKey(session.sourceId), session.instanceId),
    checkpoint: serializeBriefReviewCheckpoint(session.sourceId, checkpoint),
    pendingKey: instanceStorageKey(`living-memory.pending-writes.v1.${encodeURIComponent(session.sourceId)}`, session.instanceId),
    pending: [{ id: `pending-${observation.eventId}`, method: 'POST', path: '/observations', payload: observation,
      eventId: observation.eventId, conceptId: concept.id, label: 'Synthetic duplicate', createdAt: new Date().toISOString() }],
  };
}
