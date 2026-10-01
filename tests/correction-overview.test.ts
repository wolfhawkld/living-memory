import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildCorrectionOverview, selectCorrectionOverviewItems } from '../src/core/correction-overview.js';
import type { CorrectionEvent } from '../src/shared/corrections.js';
import type { ApplicationRecord, Concept } from '../src/shared/types.js';

const AS_OF = '2026-01-10T00:00:00.000Z';

function concept(id: string, revision = 'v2', path = `Math/${id}.md`, title = id): Concept {
  return {
    id,
    title,
    aliases: [],
    domain: 'fixture',
    summary: 'private summary',
    body: 'private body',
    source: { path, revision },
  };
}

function application(id: string, conceptId: string, overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    eventId: id,
    conceptId,
    sourceRevision: 'v1',
    occurredAt: '2026-01-02T00:00:00Z',
    recordedAt: '2026-01-02T00:00:01Z',
    kind: 'application',
    context: 'private context',
    content: 'private content',
    outcome: 'success',
    assistance: 'independent',
    result: 'private result',
    limitations: 'private limitation',
    insight: 'private insight',
    correction: 'private correction suggestion',
    references: 'private references',
    ...overrides,
  };
}

function correction(id: string, applicationEventId: string, overrides: Partial<CorrectionEvent> = {}): CorrectionEvent {
  return {
    eventId: id,
    applicationEventId,
    conceptId: 'alpha',
    sourceRevision: 'v2',
    occurredAt: '2026-01-03T00:00:00Z',
    recordedAt: '2026-01-03T00:00:01Z',
    previousEventId: null,
    status: 'open',
    note: 'private decision note',
    ...overrides,
  };
}

test('builds metadata-only correction items from visible records and explicit chain tails', () => {
  const concepts = [concept('alpha', 'v2', 'Cognition/Math/alpha.md', 'Alpha')];
  const applications = [
    application('resolved', 'alpha'),
    application('recheck', 'alpha', { eventId: 'recheck', occurredAt: '2026-01-04T00:00:00Z' }),
    application('branched', 'alpha', { eventId: 'branched', occurredAt: '2026-01-05T00:00:00Z' }),
    application('missing', 'removed'),
    application('empty', 'alpha', { correction: '  ' }),
    application('future', 'alpha', { eventId: 'future', occurredAt: '2026-01-11T00:00:00Z' }),
    application('invalid', 'alpha', { eventId: 'invalid', recordedAt: 'invalid' }),
  ];
  const decisions = [
    // The child sorts before its parent by ID, but the explicit parent link
    // still makes it the latest decision.
    correction('z-parent', 'resolved', { sourceRevision: 'v1' }),
    correction('a-child', 'resolved', { previousEventId: 'z-parent', status: 'resolved', sourceRevision: 'v2' }),
    correction('recheck-decision', 'recheck', { status: 'resolved', sourceRevision: 'v1' }),
    correction('branch-parent', 'branched', { eventId: 'branch-parent' }),
    correction('branch-left', 'branched', { eventId: 'branch-left', previousEventId: 'branch-parent', status: 'resolved', sourceRevision: 'v2' }),
    correction('branch-right', 'branched', { eventId: 'branch-right', previousEventId: 'branch-parent', status: 'dismissed', sourceRevision: 'v2' }),
    correction('future-decision', 'resolved', { eventId: 'future-decision', occurredAt: '2026-01-11T00:00:00Z', recordedAt: '2026-01-11T00:00:00Z', status: 'dismissed' }),
    correction('invalid-decision', 'resolved', { eventId: 'invalid-decision', occurredAt: 'invalid' }),
  ];

  const before = JSON.stringify({ concepts, applications, decisions });
  const overview = buildCorrectionOverview({ concepts, applications, corrections: decisions, asOf: AS_OF });
  assert.equal(overview.unavailableCount, 1);
  assert.deepEqual(overview.items.map((item) => item.applicationEventId), ['resolved', 'recheck', 'branched']);

  const resolved = overview.items.find((item) => item.applicationEventId === 'resolved')!;
  assert.deepEqual(resolved, {
    applicationEventId: 'resolved', conceptId: 'alpha', title: 'Alpha', domainId: 'Cognition/Math',
    sourceRevision: 'v2', applicationRevision: 'v1', kind: 'application',
    occurredAt: '2026-01-02T00:00:00Z', recordedAt: '2026-01-02T00:00:01Z', status: 'resolved',
    latestEventId: 'a-child', latestOccurredAt: '2026-01-03T00:00:00Z', reviewedRevision: 'v2',
    sourceChanged: true, needsRecheck: false,
  });
  const recheck = overview.items.find((item) => item.applicationEventId === 'recheck')!;
  assert.equal(recheck.status, 'resolved');
  assert.equal(recheck.needsRecheck, true);
  const branched = overview.items.find((item) => item.applicationEventId === 'branched')!;
  assert.equal(branched.status, 'open', 'an invalid branch must not guess a resolved or dismissed tail');
  assert.equal(branched.latestEventId, null);
  assert.doesNotMatch(JSON.stringify(overview), /private (summary|body|context|content|decision note)/);
  assert.equal(JSON.stringify({ concepts, applications, decisions }), before);
});

test('defaults to actionable corrections and applies scoped status/search ordering', () => {
  const item = (applicationEventId: string, overrides: Partial<ReturnType<typeof buildCorrectionOverview>['items'][number]> = {}) => ({
    applicationEventId,
    conceptId: `concept-${applicationEventId}`,
    title: `Title ${applicationEventId}`,
    domainId: 'Math',
    sourceRevision: 'v2',
    applicationRevision: 'v1',
    kind: 'application' as const,
    occurredAt: '2026-01-01T00:00:00Z',
    recordedAt: '2026-01-01T00:00:00Z',
    status: 'open' as const,
    latestEventId: null,
    latestOccurredAt: null,
    reviewedRevision: null,
    sourceChanged: true,
    needsRecheck: false,
    ...overrides,
  });
  const items = [
    item('old-open', { latestOccurredAt: '2026-01-03T00:00:00Z' }),
    item('new-recheck', { status: 'resolved', needsRecheck: true, latestOccurredAt: '2026-01-05T00:00:00Z' }),
    item('confirmed', { status: 'resolved', latestOccurredAt: '2026-01-06T00:00:00Z', needsRecheck: false }),
    item('dismissed', { status: 'dismissed', latestOccurredAt: '2026-01-07T00:00:00Z' }),
  ];

  assert.deepEqual(selectCorrectionOverviewItems(items).map((entry) => entry.applicationEventId), ['new-recheck', 'old-open']);
  assert.deepEqual(selectCorrectionOverviewItems(items, { filter: 'resolved' }).map((entry) => entry.applicationEventId), ['confirmed']);
  assert.deepEqual(selectCorrectionOverviewItems(items, { filter: 'all', query: 'new-recheck' }).map((entry) => entry.applicationEventId), ['new-recheck']);
  assert.deepEqual(selectCorrectionOverviewItems(items, { filter: 'all', domainId: 'Other' }), []);
});
