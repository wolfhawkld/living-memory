import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Concept, ObservationRequest, Snapshot } from '../src/shared/types.ts';
import { ApplicationRecordDialog } from '../src/web/ApplicationRecordDialog.tsx';
import { buildScenarioApplicationDraft, resolveScenarioApplicationConcept } from '../src/web/scenario-application-handoff.ts';

const concept: Concept = {
  id: 'synthetic:rule', title: '合成规则', aliases: [], domain: 'Synthetic',
  summary: '合成摘要', body: 'PRIVATE_SOURCE_BODY',
  source: { path: 'Synthetic/Rule.md', revision: 'v1' },
};
const observation: ObservationRequest = {
  eventId: 'scenario-1', conceptId: concept.id, sourceRevision: 'v1',
  observedAt: '2026-01-03T00:00:00.000Z', configRevision: 1, anchorEventId: null,
  answer: 'ORIGINAL_WRONG_ANSWER', rating: 'blank', exposure: 'exposed', observedExposure: true,
  learning: { task: 'scenario', scenario: '合成任务：检查输入条件', applicability: '核对后的适用条件',
    confidence: 75, confidenceAt: '2026-01-02T23:59:00.000Z', cue: 'lookup', outcome: 'failure', basis: 'self-check' },
};
const snapshot = { concepts: [concept] } as Snapshot;

test('a scenario check seeds an editable summary without promoting the original answer or outcomes', () => {
  const before = structuredClone(observation);
  const draft = buildScenarioApplicationDraft(observation);
  assert.equal(draft.kind, 'summary');
  assert.equal(draft.context, observation.learning!.scenario);
  assert.equal(draft.content, observation.learning!.applicability);
  assert.equal(draft.outcome, 'unverified');
  assert.equal(draft.assistance, 'unknown');
  assert.equal(draft.result, '');
  assert.equal(draft.insight, '');
  assert.equal(draft.correction, '');
  draft.content = '本人补充的新总结';
  assert.deepEqual(observation, before);

  const html = renderToStaticMarkup(createElement(ApplicationRecordDialog, {
    concept, initialDraft: buildScenarioApplicationDraft(observation), busy: false,
    onSave: async () => { throw new Error('rendering must not save'); }, onClose: () => undefined,
  }));
  assert.match(html, /记录一次学习总结/);
  assert.match(html, /核对后的适用条件/);
  assert.match(html, /实际应用/);
  assert.doesNotMatch(html, /ORIGINAL_WRONG_ANSWER|PRIVATE_SOURCE_BODY|readonly=""|disabled=""/);
});

test('an unchecked or blank recall does not become a completed summary', () => {
  const draft = buildScenarioApplicationDraft({ ...observation, answer: '', learning: { ...observation.learning!, applicability: undefined } });
  assert.equal(draft.content, '');
  assert.equal(draft.outcome, 'unverified');
  assert.throws(() => buildScenarioApplicationDraft({ ...observation, learning: { ...observation.learning!, task: 'concept' } }), /场景观察/);
});

test('handoff checks the same private space and content revision without mutating the graph', () => {
  const resolved = resolveScenarioApplicationConcept(observation, 'space-a', 'space-a', snapshot);
  assert.deepEqual(resolved, concept);
  assert.notEqual(resolved, concept);
  resolved.title = 'draft edit';
  assert.equal(concept.title, '合成规则');
  assert.throws(() => resolveScenarioApplicationConcept(observation, 'space-a', 'space-b', snapshot), /知识空间已变化/);
  assert.throws(() => resolveScenarioApplicationConcept(observation, 'space-a', 'space-a', { concepts: [] } as unknown as Snapshot), /资料已变化/);
  assert.throws(() => resolveScenarioApplicationConcept({ ...observation, sourceRevision: 'v0' }, 'space-a', 'space-a', snapshot), /资料已变化/);
});
