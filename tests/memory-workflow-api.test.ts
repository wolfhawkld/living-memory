import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeApp, createApp } from '../src/server/app.js';
import type {
  ApplicationRecordRequest,
  Concept,
  ConceptHistory,
  ExportData,
  LearningEvidence,
  ObservationRequest,
  ReviewRequest,
  Snapshot,
} from '../src/shared/types.js';
import type { CorrectionRequest } from '../src/shared/corrections.js';
import type { LearningOverview } from '../src/shared/learning-overview.js';
import { buildApplicationRecordRequest } from '../src/web/application-record.ts';
import { buildScenarioApplicationDraft } from '../src/web/scenario-application-handoff.ts';
import {
  buildScenarioObservationRequest,
  createScenarioPracticeState,
  startScenarioPractice,
  submitScenarioAnswer,
} from '../src/web/ScenarioPractice.tsx';

interface ResponseData {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json: <T>() => T;
}

interface RunningApp {
  root: string;
  dataDir: string;
  port: number;
  request: (path: string, options?: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  }) => Promise<ResponseData>;
  stop: () => Promise<void>;
}

interface Fixture {
  root: string;
  dataDir: string;
  cleanup: () => void;
}

interface Session {
  writeToken: string;
  sourceId: string;
}

const FIRST_NOW = '2026-01-12T00:00:00.000Z';
const RESTART_NOW = '2026-01-20T00:00:00.000Z';
const SCENARIO = '需要为多智能体编排器设计意图识别、强规则校验和上下文记忆。';
const ORIGINAL_ANSWER = 'PRIVATE_ORIGINAL_SCENARIO_ANSWER';
const APPLICABILITY = '规则校验可以表达安全与范围条件，决策路径再交给后续编排。';
const SUMMARY_INSIGHT = 'PRIVATE_SCENARIO_INSIGHT';
const SUMMARY_CORRECTION = 'PRIVATE_SCENARIO_CORRECTION';

function conceptFile(title: string, summary: string, body: string): string {
  return [
    '---',
    'type: concept',
    `title: ${title}`,
    'aliases: []',
    `summary: ${summary}`,
    '---',
    '',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

function sourceFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'living-memory-workflow-source-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-workflow-data-'));
  mkdirSync(join(root, 'Math'), { recursive: true });
  writeFileSync(join(root, 'Math', 'Alpha.md'), conceptFile('Alpha', '初始概念摘要', 'ALPHA_PRIVATE_BODY_V1'));
  writeFileSync(join(root, 'Math', 'Beta.md'), conceptFile('Beta', '长期保持测试概念', 'BETA_PRIVATE_BODY'));
  return {
    root,
    dataDir,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function startApp(root: string, dataDir: string, now: string): Promise<RunningApp> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  const app = createApp({
    root,
    dataDir,
    port,
    now: () => new Date(now),
    staticDir: join(dataDir, 'no-dist'),
  });
  server.on('request', app);
  let stopped = false;
  const request = (path: string, options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}) => new Promise<ResponseData>((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: {
        host: `127.0.0.1:${port}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.headers ?? {}),
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: text,
        json: <T>() => JSON.parse(text) as T,
      }));
    });
    req.once('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
  return {
    root,
    dataDir,
    port,
    request,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      closeApp(app);
    },
  };
}

function tokenHeaders(session: Session): Record<string, string> {
  return { 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId };
}

async function session(client: RunningApp): Promise<Session> {
  const response = await client.request('/api/session');
  assert.equal(response.status, 200, response.body);
  return response.json<Session>();
}

async function snapshot(client: RunningApp, asOf?: string): Promise<Snapshot> {
  const query = asOf ? `?scope=all&asOf=${encodeURIComponent(asOf)}` : '?scope=all';
  const response = await client.request(`/api/snapshot${query}`);
  assert.equal(response.status, 200, response.body);
  return response.json<Snapshot>();
}

function conceptAt(value: Snapshot, path: string): Concept {
  const concept = value.concepts.find((item) => item.source.path === path);
  assert.ok(concept, `fixture concept ${path} should be present`);
  return concept;
}

function errorCode(response: ResponseData): string {
  return response.json<{ error?: { code?: string } }>().error?.code ?? '';
}

type ScenarioOptions = {
  eventId: string;
  scenario: string;
  scenarioRevisit?: boolean;
  confidence: number;
  confidenceAt: string;
  observedAt: string;
  answer: string;
  applicability: string;
  cue: LearningEvidence['cue'];
  outcome: LearningEvidence['outcome'];
  basis: LearningEvidence['basis'];
  exposure: 'unexposed' | 'exposed' | 'unknown';
};

/** Construct the same frozen client payload as the scenario practice flow. */
function scenarioObservation(snapshotValue: Snapshot, concept: Concept, options: ScenarioOptions): ObservationRequest {
  let state = createScenarioPracticeState(snapshotValue, {}, options.scenario, options.scenarioRevisit ?? false);
  state = { ...state, confidence: options.confidence };
  state = startScenarioPractice(state, options.confidenceAt);
  state = {
    ...state,
    answer: options.answer,
  };
  state = submitScenarioAnswer(state, options.observedAt, options.eventId);
  state = {
    ...state,
    conceptId: concept.id,
    applicability: options.applicability,
    cue: options.cue,
    outcome: options.outcome,
    basis: options.basis,
    exposure: options.exposure,
  };
  return buildScenarioObservationRequest(state);
}

function scenarioSummary(concept: Concept, observation: ObservationRequest): ApplicationRecordRequest {
  const initialDraft = buildScenarioApplicationDraft(observation);
  assert.equal(initialDraft.kind, 'summary');
  assert.equal(initialDraft.outcome, 'unverified');
  assert.equal(initialDraft.assistance, 'unknown');
  assert.equal(initialDraft.context, SCENARIO);
  assert.equal(initialDraft.content, APPLICABILITY);
  assert.doesNotMatch(initialDraft.content, new RegExp(ORIGINAL_ANSWER));
  return buildApplicationRecordRequest(concept, {
    ...initialDraft,
    insight: SUMMARY_INSIGHT,
    correction: SUMMARY_CORRECTION,
    references: 'PRIVATE_SCENARIO_REFERENCE',
  }, '2026-01-04T00:00:00Z', 'scenario-summary');
}

function review(concept: Concept, eventId: string, occurredAt: string): ReviewRequest {
  return {
    eventId,
    conceptId: concept.id,
    sourceRevision: concept.source.revision,
    kind: 'review',
    occurredAt,
  };
}

function correction(application: ApplicationRecordRequest, sourceRevision: string, eventId: string): CorrectionRequest {
  return {
    eventId,
    applicationEventId: application.eventId,
    conceptId: application.conceptId,
    sourceRevision,
    occurredAt: '2026-01-10T00:00:00Z',
    previousEventId: null,
    status: 'resolved',
    note: '已阅读当前资料并确认修正内容已经纳入。',
  };
}

function assertPromptPrivacy(response: ResponseData, privateText: readonly string[]): void {
  assert.equal(response.status, 200, response.body);
  const body = response.json<{
    sourceId: string;
    asOf: string;
    items: Array<Record<string, unknown>>;
    total: number;
    nextCursor: string | null;
  }>();
  for (const item of body.items) {
    assert.deepEqual(Object.keys(item).sort(), ['eventId', 'observedAt', 'scenario']);
  }
  const serialized = JSON.stringify(body);
  for (const value of privateText) assert.doesNotMatch(serialized, new RegExp(value));
  assert.doesNotMatch(serialized, /conceptId|sourceRevision|answer|applicability|confidence|outcome|cue|basis/);
  assert.ok(body.asOf);
  return;
}

test('scenario recall, summary correction, source refresh, delayed projection and restart remain isolated and idempotent', async () => {
  const fixture = sourceFixture();
  let first: RunningApp | undefined;
  let restarted: RunningApp | undefined;
  try {
    first = await startApp(fixture.root, fixture.dataDir, FIRST_NOW);
    const firstSession = await session(first);
    const headers = tokenHeaders(firstSession);
    const initial = await snapshot(first);
    const alpha = conceptAt(initial, 'Math/Alpha.md');
    const beta = conceptAt(initial, 'Math/Beta.md');
    const oldRevision = alpha.source.revision;

    const oldAnchor = review(alpha, 'scenario-old-anchor', '2026-01-01T00:00:00Z');
    assert.equal((await first.request('/api/reviews', { method: 'POST', headers, body: oldAnchor })).status, 201);
    assert.equal((await first.request('/api/reviews', { method: 'POST', headers, body: oldAnchor })).status, 200);

    const anchored = await snapshot(first);
    const firstObservation = scenarioObservation(anchored, alpha, {
      eventId: 'scenario-first-observation',
      scenario: SCENARIO,
      confidence: 40,
      confidenceAt: '2026-01-02T00:00:00Z',
      observedAt: '2026-01-03T00:00:00Z',
      answer: ORIGINAL_ANSWER,
      applicability: APPLICABILITY,
      cue: 'lookup',
      outcome: 'partial',
      basis: 'self-check',
      exposure: 'unexposed',
    });
    assert.equal(firstObservation.sourceRevision, oldRevision);
    assert.equal(firstObservation.anchorEventId, oldAnchor.eventId);
    assert.equal(firstObservation.observedExposure, false, '资料是在先答后查阅，不能伪装成提交前已看资料');
    assert.deepEqual(firstObservation.learning, {
      task: 'scenario', scenario: SCENARIO, applicability: APPLICABILITY,
      confidence: 40, confidenceAt: '2026-01-02T00:00:00Z',
      cue: 'lookup', outcome: 'partial', basis: 'self-check',
    });
    assert.equal((await first.request('/api/observations', { method: 'POST', headers, body: firstObservation })).status, 201);
    assert.equal((await first.request('/api/observations', { method: 'POST', headers, body: firstObservation })).status, 200);

    const promptBeforeRefresh = await first.request('/api/scenario-prompts?limit=1', {
      headers: { 'x-lm-source-id': firstSession.sourceId },
    });
    assertPromptPrivacy(promptBeforeRefresh, [ORIGINAL_ANSWER, APPLICABILITY]);
    const promptPage = promptBeforeRefresh.json<{ sourceId: string; total: number; items: Array<{ scenario: string }> }>();
    assert.equal(promptPage.sourceId, firstSession.sourceId);
    assert.equal(promptPage.total, 1);
    assert.deepEqual(promptPage.items.map((item) => item.scenario), [SCENARIO]);

    const summary = scenarioSummary(alpha, firstObservation);
    assert.equal((await first.request('/api/applications', { method: 'POST', headers, body: summary })).status, 201);
    assert.equal((await first.request('/api/applications', { method: 'POST', headers, body: summary })).status, 200);
    const afterSummary = await snapshot(first);
    assert.equal(afterSummary.states[alpha.id].anchor?.eventId, oldAnchor.eventId);
    assert.equal(afterSummary.states[alpha.id].retention, null);

    const betaAnchor = review(beta, 'beta-anchor', '2026-01-01T00:00:00Z');
    assert.equal((await first.request('/api/reviews', { method: 'POST', headers, body: betaAnchor })).status, 201);
    const betaRetention = {
      eventId: 'beta-retention-set', conceptId: beta.id, sourceRevision: beta.source.revision,
      occurredAt: '2026-01-02T00:00:00Z', active: true, previousEventId: null,
    };
    assert.equal((await first.request('/api/retentions', { method: 'POST', headers, body: betaRetention })).status, 201);
    assert.equal((await first.request('/api/retentions', { method: 'POST', headers, body: betaRetention })).status, 200);
    assert.equal((await snapshot(first)).states[beta.id].status, 'retained');

    writeFileSync(join(fixture.root, 'Math', 'Alpha.md'), conceptFile('Alpha', '已根据反馈修正的摘要', 'ALPHA_PRIVATE_BODY_V2'));
    assert.equal((await first.request('/api/refresh', { method: 'POST', headers, body: {} })).status, 200);
    const refreshed = await snapshot(first);
    const currentAlpha = conceptAt(refreshed, 'Math/Alpha.md');
    assert.equal(currentAlpha.id, alpha.id);
    assert.notEqual(currentAlpha.source.revision, oldRevision);
    assert.equal(refreshed.states[currentAlpha.id].status, 'pending');
    assert.equal(refreshed.states[currentAlpha.id].anchor?.eventId, oldAnchor.eventId);

    const staleCorrection = correction(summary, oldRevision, 'scenario-correction-stale');
    const staleResponse = await first.request('/api/corrections', { method: 'POST', headers, body: staleCorrection });
    assert.equal(staleResponse.status, 409);
    assert.equal(errorCode(staleResponse), 'SOURCE_REVISION_MISMATCH');

    const resolvedCorrection = correction(summary, currentAlpha.source.revision, 'scenario-correction-resolved');
    assert.equal((await first.request('/api/corrections', { method: 'POST', headers, body: resolvedCorrection })).status, 201);
    assert.equal((await first.request('/api/corrections', { method: 'POST', headers, body: resolvedCorrection })).status, 200);
    const correctedOverview = (await first.request('/api/learning-overview', {
      headers: { 'x-lm-source-id': firstSession.sourceId },
    })).json<LearningOverview>();
    const correctionItem = correctedOverview.corrections?.items.find((item) => item.applicationEventId === summary.eventId);
    assert.ok(correctionItem);
    assert.equal(correctionItem.status, 'resolved');
    assert.equal(correctionItem.needsRecheck, false);
    assert.equal(correctionItem.sourceChanged, true);
    const afterCorrection = await snapshot(first);
    assert.equal(afterCorrection.states[currentAlpha.id].anchor?.eventId, oldAnchor.eventId);

    const currentAnchor = review(currentAlpha, 'scenario-current-anchor', '2026-01-05T00:00:00Z');
    assert.equal((await first.request('/api/reviews', { method: 'POST', headers, body: currentAnchor })).status, 201);
    assert.equal((await first.request('/api/reviews', { method: 'POST', headers, body: currentAnchor })).status, 200);
    const currentAnchored = await snapshot(first);
    assert.equal(currentAnchored.states[currentAlpha.id].anchor?.eventId, currentAnchor.eventId);

    const revisitObservation = scenarioObservation(currentAnchored, currentAlpha, {
      eventId: 'scenario-revisit-observation',
      scenario: SCENARIO,
      scenarioRevisit: true,
      confidence: 80,
      confidenceAt: '2026-01-10T00:00:00Z',
      observedAt: '2026-01-11T00:00:00Z',
      answer: '我独立想起了布尔逻辑、决策表和状态迁移的组合。',
      applicability: '这次能把概念和编排器的强校验边界对应起来。',
      cue: 'independent',
      outcome: 'success',
      basis: 'self-check',
      exposure: 'unexposed',
    });
    assert.equal(revisitObservation.sourceRevision, currentAlpha.source.revision);
    assert.equal(revisitObservation.anchorEventId, currentAnchor.eventId);
    assert.equal(revisitObservation.learning?.scenarioRevisit, true);
    assert.equal(revisitObservation.learning?.confidence, 80);
    assert.equal((await first.request('/api/observations', { method: 'POST', headers, body: revisitObservation })).status, 201);
    assert.equal((await first.request('/api/observations', { method: 'POST', headers, body: revisitObservation })).status, 200);

    const beforeRestart = (await first.request('/api/export')).json<ExportData>();
    assert.equal(beforeRestart.config.halfLifeDays, 7);
    assert.deepEqual(new Set(beforeRestart.anchors.map((event) => event.eventId)), new Set([
      oldAnchor.eventId, betaAnchor.eventId, currentAnchor.eventId,
    ]));
    assert.deepEqual(beforeRestart.retentions?.map((event) => event.eventId), [betaRetention.eventId]);
    assert.deepEqual(beforeRestart.observations?.map((event) => event.eventId), [firstObservation.eventId, revisitObservation.eventId]);
    assert.deepEqual(beforeRestart.applications?.map((event) => event.eventId), [summary.eventId]);
    assert.deepEqual(beforeRestart.corrections?.map((event) => event.eventId), [resolvedCorrection.eventId]);
    const revisitBeforeRestart = beforeRestart.observations?.find((event) => event.eventId === revisitObservation.eventId);
    assert.ok(revisitBeforeRestart);
    assert.equal(revisitBeforeRestart.elapsedDays, 6);
    assert.equal(revisitBeforeRestart.halfLifeDays, 7);

    await first.stop();
    first = undefined;
    restarted = await startApp(fixture.root, fixture.dataDir, RESTART_NOW);
    const restartedSession = await session(restarted);
    assert.equal(restartedSession.sourceId, firstSession.sourceId);
    const afterRestart = await snapshot(restarted);
    const restartedAlpha = conceptAt(afterRestart, 'Math/Alpha.md');
    const delayedAlpha = afterRestart.states[restartedAlpha.id];
    assert.equal(delayedAlpha.anchor?.eventId, currentAnchor.eventId);
    assert.equal(delayedAlpha.status, 'stale');
    assert.equal(delayedAlpha.elapsedDays, 15);
    assert.equal(afterRestart.config.revision, 1);
    assert.equal(delayedAlpha.retention, null);

    const exactProjection = await snapshot(restarted, '2026-01-19T00:00:00Z');
    assert.equal(exactProjection.states[restartedAlpha.id].elapsedDays, 14);
    assert.equal(exactProjection.states[restartedAlpha.id].decay, 0.25);
    assert.equal(exactProjection.states[restartedAlpha.id].status, 'stale');

    const afterRestartOverview = (await restarted.request('/api/learning-overview', {
      headers: { 'x-lm-source-id': restartedSession.sourceId },
    })).json<LearningOverview>();
    const alphaItem = afterRestartOverview.items.find((item) => item.conceptId === restartedAlpha.id);
    assert.ok(alphaItem);
    assert.equal(alphaItem.memory.status, 'stale');
    assert.equal(alphaItem.evidence.currentObservations, 1);
    assert.equal(alphaItem.evidence.previousObservations, 1);
    assert.equal(alphaItem.evidence.previousApplications, 1);
    assert.equal(alphaItem.scenario.total, 1);
    assert.equal(alphaItem.scenario.independentSuccess, 1);
    assert.equal(alphaItem.calibration.scenario.meanConfidence, 80);
    assert.equal(alphaItem.timeRecall?.buckets.length, 0);
    assert.equal(alphaItem.timeRecall?.excluded.scenario, 1);
    assert.equal(afterRestartOverview.corrections?.items.find((item) => item.applicationEventId === summary.eventId)?.needsRecheck, false);

    const history = (await restarted.request(`/api/concepts/${encodeURIComponent(restartedAlpha.id)}/history`)).json<ConceptHistory>();
    assert.equal(history.correctionCount, 1);
    assert.equal(history.corrections?.[summary.eventId]?.latest?.eventId, resolvedCorrection.eventId);
    assert.equal(history.corrections?.[summary.eventId]?.latest?.status, 'resolved');
    assert.deepEqual(new Set(history.entries.map((entry) => entry.event.eventId)), new Set([
      oldAnchor.eventId, firstObservation.eventId, summary.eventId, currentAnchor.eventId, revisitObservation.eventId,
    ]));
    const storedFirstObservation = history.entries.find((entry) => entry.type === 'observation' && entry.event.eventId === firstObservation.eventId);
    assert.ok(storedFirstObservation && storedFirstObservation.type === 'observation');
    assert.equal(storedFirstObservation.event.answer, ORIGINAL_ANSWER);
    assert.equal(storedFirstObservation.event.learning?.scenarioRevisit, undefined);

    const promptPageAfterRestart = await restarted.request('/api/scenario-prompts?limit=1', {
      headers: { 'x-lm-source-id': restartedSession.sourceId },
    });
    assertPromptPrivacy(promptPageAfterRestart, [ORIGINAL_ANSWER, APPLICABILITY, SUMMARY_INSIGHT, SUMMARY_CORRECTION]);
    const firstPromptPage = promptPageAfterRestart.json<{ total: number; nextCursor: string | null; items: Array<{ eventId: string; scenario: string; observedAt: string }> }>();
    assert.equal(firstPromptPage.total, 2);
    assert.equal(firstPromptPage.items.length, 1);
    assert.ok(firstPromptPage.nextCursor);
    const secondPromptPage = await restarted.request(`/api/scenario-prompts?limit=1&cursor=${encodeURIComponent(firstPromptPage.nextCursor!)}`, {
      headers: { 'x-lm-source-id': restartedSession.sourceId },
    });
    assertPromptPrivacy(secondPromptPage, [ORIGINAL_ANSWER, APPLICABILITY, SUMMARY_INSIGHT, SUMMARY_CORRECTION]);
    const secondPrompt = secondPromptPage.json<{ total: number; nextCursor: string | null; items: Array<{ eventId: string }> }>();
    assert.equal(secondPrompt.total, 2);
    assert.equal(secondPrompt.items.length, 1);
    assert.equal(secondPrompt.nextCursor, null);

    const betaBeforeClear = afterRestart.states[beta.id];
    assert.equal(betaBeforeClear.status, 'retained');
    assert.equal(betaBeforeClear.decay, null);
    const betaClear = {
      ...betaRetention,
      eventId: 'beta-retention-clear',
      occurredAt: RESTART_NOW,
      active: false,
      previousEventId: betaRetention.eventId,
    };
    assert.equal((await restarted.request('/api/retentions', { method: 'POST', headers: tokenHeaders(restartedSession), body: betaClear })).status, 201);
    assert.equal((await restarted.request('/api/retentions', { method: 'POST', headers: tokenHeaders(restartedSession), body: betaClear })).status, 200);
    const betaAfterClear = (await snapshot(restarted)).states[beta.id];
    assert.equal(betaAfterClear.status, 'stale');
    assert.equal(betaAfterClear.anchor?.eventId, betaAnchor.eventId);
    assert.equal(betaAfterClear.elapsedDays, 19);
    assert.ok(betaAfterClear.decay !== null && betaAfterClear.decay < 0.25);
    assert.equal(betaAfterClear.retention?.active, false);

    const afterRestartExport = (await restarted.request('/api/export')).json<ExportData>();
    const revisitAfterRestart = afterRestartExport.observations?.find((event) => event.eventId === revisitObservation.eventId);
    assert.ok(revisitAfterRestart);
    assert.equal(revisitAfterRestart.elapsedDays, revisitBeforeRestart.elapsedDays);
    assert.equal(revisitAfterRestart.halfLifeDays, revisitBeforeRestart.halfLifeDays);
    assert.equal(revisitAfterRestart.decay, revisitBeforeRestart.decay);
    assert.deepEqual(afterRestartExport.observations?.map((event) => event.eventId), beforeRestart.observations?.map((event) => event.eventId));
    assert.deepEqual(afterRestartExport.applications?.map((event) => event.eventId), beforeRestart.applications?.map((event) => event.eventId));
    assert.deepEqual(afterRestartExport.corrections?.map((event) => event.eventId), beforeRestart.corrections?.map((event) => event.eventId));
    assert.deepEqual(afterRestartExport.retentions?.map((event) => event.eventId), [betaRetention.eventId, betaClear.eventId]);
  } finally {
    if (first) await first.stop();
    if (restarted) await restarted.stop();
    fixture.cleanup();
  }
});
