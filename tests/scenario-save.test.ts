import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ObservationRequest } from '../src/shared/types.js';
import { saveScenarioRequest } from '../src/web/scenario-save.js';

const request: ObservationRequest = Object.freeze({
  eventId: 'scenario-save-1',
  conceptId: 'synthetic:concept',
  sourceRevision: 'revision-1',
  observedAt: '2026-10-02T10:00:00.000Z',
  configRevision: 1,
  anchorEventId: null,
  answer: '当次独立回答',
  rating: 'partial',
  exposure: 'unknown',
  observedExposure: false,
  learning: {
    task: 'scenario',
    scenario: '合成工作场景',
    confidence: null,
    confidenceAt: null,
    cue: 'independent',
    outcome: 'partial',
    basis: 'self-check',
  },
} as ObservationRequest);

test('a rejected observation never opens the application follow-up', async () => {
  const calls: string[] = [];
  const result = await saveScenarioRequest(request, {
    onSave: async () => { calls.push('save'); return false; },
    onContinueApplication: async () => { calls.push('continue'); },
  }, { observationSaved: false, continueToApplication: true });

  assert.deepEqual(calls, ['save']);
  assert.equal(result.saved, false);
  assert.equal(result.continued, false);
  assert.match(result.saveError ?? '', /尚未确认写入/);
  assert.equal(result.continuationError, null);
  assert.strictEqual(result.request, request);
});

test('an observation save error never opens the application follow-up', async () => {
  const calls: string[] = [];
  const result = await saveScenarioRequest(request, {
    onSave: async () => { calls.push('save'); throw new Error('网络中断'); },
    onContinueApplication: async () => { calls.push('continue'); },
  }, { observationSaved: false, continueToApplication: true });

  assert.deepEqual(calls, ['save']);
  assert.equal(result.saved, false);
  assert.equal(result.continued, false);
  assert.equal(result.saveError, '网络中断');
});

test('a failed application follow-up can retry with the retained request without saving the observation again', async () => {
  let saveCount = 0;
  let continueCount = 0;
  const result = await saveScenarioRequest(request, {
    onSave: async (candidate) => {
      saveCount += 1;
      assert.strictEqual(candidate, request);
      return true;
    },
    onContinueApplication: async (candidate) => {
      continueCount += 1;
      assert.strictEqual(candidate, request);
      if (continueCount === 1) throw new Error('知识空间暂时不可用');
    },
  }, { observationSaved: false, continueToApplication: true });

  assert.equal(result.saved, true);
  assert.equal(result.continued, false);
  assert.equal(result.continuationError, '知识空间暂时不可用');
  assert.strictEqual(result.request, request);

  const retry = await saveScenarioRequest(request, {
    onSave: async () => { saveCount += 1; return true; },
    onContinueApplication: async (candidate) => {
      continueCount += 1;
      assert.strictEqual(candidate, request);
    },
  }, { observationSaved: true, continueToApplication: true });

  assert.equal(retry.saved, true);
  assert.equal(retry.continued, true);
  assert.equal(retry.continuationError, null);
  assert.equal(saveCount, 1, 'the retained observation is never submitted a second time');
  assert.equal(continueCount, 2);
  assert.equal(retry.request.eventId, 'scenario-save-1');
});

test('a normal save action is a no-op once the exact observation is retained', async () => {
  let saveCount = 0;
  const result = await saveScenarioRequest(request, {
    onSave: async () => { saveCount += 1; return true; },
  }, { observationSaved: true });

  assert.equal(result.saved, true);
  assert.equal(result.continued, false);
  assert.equal(saveCount, 0);
  assert.strictEqual(result.request, request);
});
