import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Response } from 'express';
import { apiError, createApp, closeApp } from '../src/server/app.js';
import { AnswerClearingSchemaError } from '../src/server/answer-clearing-schema.js';
import { AnswerClearingStoreError } from '../src/server/answer-clearing-store-error.js';
import { AnswerClearingImportError } from '../src/shared/answer-clearing-export.js';
import type { ObservationRequest } from '../src/shared/types.js';
import { appV3Files, appV3Fixture, initializeAppV3, V3_NOW } from './helpers/app-v3-fixture.js';

const headers = (session: { writeToken: string; sourceId: string; instanceId?: string }) => ({
  'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId, 'x-lm-instance-id': session.instanceId ?? 'legacy',
});
function observation(f: Awaited<ReturnType<typeof appV3Fixture>>, eventId = 'written-one'): ObservationRequest {
  const concept = f.app.livingMemory.getSource().index.concepts[0];
  return { eventId, conceptId: concept.id, sourceRevision: concept.source.revision, observedAt: V3_NOW,
    configRevision: f.app.livingMemory.store.getConfig().revision, anchorEventId: null, answer: 'SYNTHETIC_SAVED_ANSWER',
    evidenceMode: 'written', rating: 'clear', exposure: 'unexposed', observedExposure: false };
}

test('explicit App3 rejects absent, empty, v2, unknown and invalid versions before source or account side effects', () => {
  for (const kind of ['missing', 'empty', 'v2', 'unknown', 'null', 'string', 'future'] as const) {
    const files = appV3Files();
    try {
      if (kind === 'empty') writeFileSync(files.dbPath, '');
      if (kind === 'v2') closeApp(createApp(files));
      if (kind === 'unknown') { const db = new DatabaseSync(files.dbPath); db.exec('CREATE TABLE unknown_data(value TEXT)'); db.close(); }
      const before = readdirSync(files.dataDir).sort();
      const bytes = existsSync(files.dbPath) ? readFileSync(files.dbPath) : null;
      const version = kind === 'null' ? null : kind === 'string' ? '3' : kind === 'future' ? 4 : 3;
      assert.throws(() => createApp({ ...files, learningSchemaVersion: version as 3, accountsEnabled: true }));
      assert.deepEqual(readdirSync(files.dataDir).sort(), before);
      if (bytes) assert.deepEqual(readFileSync(files.dbPath), bytes);
      else assert.equal(existsSync(files.dbPath), false);
      assert.equal(existsSync(join(files.dataDir, 'accounts.sqlite')), false);
      assert.equal(existsSync(join(files.dataDir, 'device-session.json')), false);
    } finally { files.remove(); }
  }
});

test('default App stays v2 even with an inherited v3 setting and rejects v3 without altering it', () => {
  const files = appV3Files(); const old = process.env.LM_LEARNING_SCHEMA_VERSION;
  try {
    process.env.LM_LEARNING_SCHEMA_VERSION = '3';
    const app = createApp(files);
    try { const source = app.livingMemory.getSource(); assert.equal(app.livingMemory.store.exportData(source.index.source, source.index.concepts).schemaVersion, 2); }
    finally { closeApp(app); }
  } finally { if (old === undefined) delete process.env.LM_LEARNING_SCHEMA_VERSION; else process.env.LM_LEARNING_SCHEMA_VERSION = old; files.remove(); }
  const v3 = appV3Files();
  try {
    initializeAppV3(v3.dbPath); const bytes = readFileSync(v3.dbPath);
    assert.throws(() => createApp({ ...v3, accountsEnabled: true }));
    assert.deepEqual(readFileSync(v3.dbPath), bytes); assert.deepEqual(readdirSync(v3.dataDir), ['living-memory.sqlite']);
  } finally { v3.remove(); }
});

test('App3 declares exactly protocol3 and gates JSON, writes and SSE without relaxing attachment or source authentication', async () => {
  const f = await appV3Fixture();
  try {
    const session = (await f.send('/api/session', { protocol: null })).body;
    assert.equal(session.learningProtocolVersion, 3);
    const source = f.app.livingMemory.getSource();
    const before = f.app.livingMemory.store.exportData(source.index.source, source.index.concepts);
    for (const protocol of [null, '2', '4', '03', ['3', '3']] as const) {
      const response = await f.send('/api/snapshot', { protocol: protocol as string | string[] | null });
      assert.equal(response.status, 426); assert.equal(response.body.error.code, 'LEARNING_PROTOCOL_REQUIRED');
      assert.equal((await f.send('/api/observations', { protocol: protocol as string | string[] | null, method: 'POST', headers: headers(session), body: observation(f) })).status, 426);
    }
    assert.equal((await f.send('/api/snapshot')).status, 200);
    assert.equal((await f.send('/api/snapshot', { headers: { 'x-lm-source-id': 'another-space' } })).status, 409);
    for (const path of ['/api/changes', '/api/changes?learningProtocol=2', '/api/changes?learningProtocol=3&learningProtocol=3']) {
      assert.equal((await f.send(path, { protocol: null })).status, 426);
    }
    assert.equal((await f.send('/api/changes?learningProtocol=3', { protocol: '2' })).status, 426);
    const stream = await f.send('/api/changes?learningProtocol=3', { protocol: null, firstFrame: true });
    assert.equal(stream.status, 200); assert.match(stream.text, /connected/);
    const concept = f.app.livingMemory.getSource().index.concepts[0];
    const attachment = await f.send(`/api/concepts/${concept.id}/attachment?sourceId=${session.sourceId}&sourceRevision=${concept.source.revision}&path=missing.svg`, { protocol: null });
    assert.equal(attachment.status, 404, 'attachment retains its own path checks, not protocol rejection');
    assert.deepEqual(f.app.livingMemory.store.exportData(source.index.source, source.index.concepts), before);
    assert.equal((await f.send('/api/observations/written-one/clear', { method: 'POST', headers: headers(session), body: {} })).status, 404);
  } finally { await f.close(); }
});

test('real App3 history, revisions and JSON keep cleared answers while legacy retries reach the Store before clocks and missing concepts', async () => {
  const f = await appV3Fixture();
  try {
    const session = (await f.send('/api/session')).body;
    const request = observation(f); const send = (path: string, body: unknown) => f.send(path, { method: 'POST', headers: headers(session), body });
    assert.equal((await send('/api/observations', request)).status, 201);
    const raw = (await f.send('/api/export')).body;
    const state = f.app.livingMemory.store.getStates(f.app.livingMemory.getSource().index.concepts, V3_NOW);
    const receipt = f.app.livingMemory.store.clearObservationAnswer({ observationEventId: request.eventId });
    f.setClock('2026-10-19T00:00:00.000Z');
    const replay = await send('/api/observations', request);
    assert.equal(replay.status, 409); assert.equal(replay.body.error.code, 'ANSWER_CLEARED'); assert.doesNotMatch(replay.text, /SYNTHETIC_SAVED_ANSWER/);
    f.setClock(V3_NOW);
    const history = await f.send(`/api/concepts/${request.conceptId}/history`);
    assert.equal(history.status, 200);
    const parent = history.body.entries.find((entry: any) => entry.type === 'observation').event;
    assert.equal(parent.answer, null); assert.deepEqual(parent.answerClearing, { observationEventId: request.eventId, clearedAt: receipt.clearedAt });
    assert.deepEqual(history.body.observationPrivacy, { cleared: 1, excludedFromPerformance: 1 });
    const path = f.app.livingMemory.getSource().index.concepts.find(c => c.id === request.conceptId)!.source.path;
    renameSync(join(f.root, path), join(f.root, 'archived.txt'));
    assert.equal((await send('/api/refresh', {})).status, 200);
    assert.equal((await send('/api/observations', request)).body.error.code, 'ANSWER_CLEARED');
    assert.equal((await f.send(`/api/concepts/${request.conceptId}/history`)).status, 404, 'concept route retains the existing live-source boundary');
    const revisions = await f.send(`/api/observations/${request.eventId}/revisions`);
    assert.equal(revisions.status, 200); assert.deepEqual(revisions.body.observation, parent);
    const exported = await f.send('/api/export');
    assert.equal(exported.body.schemaVersion, 3); assert.equal(exported.body.observations[0].answer, null);
    assert.equal(exported.headers['cache-control'], 'no-store'); assert.doesNotMatch(exported.text, /SYNTHETIC_SAVED_ANSWER/);
    const rejectedImport = await send('/api/import/preview', { data: raw, options: { restoreLayout: false, restoreReviewPlan: false } });
    assert.equal(rejectedImport.status, 409); assert.equal(rejectedImport.body.error.code, 'ANSWER_CLEARED');
    assert.doesNotMatch(rejectedImport.text, /SYNTHETIC_SAVED_ANSWER/);
    assert.equal(state[request.conceptId].anchor, null);
    f.restart(); assert.deepEqual((await f.send('/api/export')).body.observations, exported.body.observations);
  } finally { await f.close(); }
});

test('App3 exact retries and cross-kind collisions retain identities after source archival and clock rollback', async () => {
  const f = await appV3Fixture();
  try {
    const session = (await f.send('/api/session')).body, request = observation(f, 'retry-parent');
    const send = (body: unknown) => f.send('/api/observations', { method: 'POST', headers: headers(session), body });
    assert.equal((await send(request)).status, 201);
    const concept = f.app.livingMemory.getSource().index.concepts.find(c => c.id === request.conceptId)!;
    f.app.livingMemory.store.addReview({ eventId: 'occupied-review', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review' });
    renameSync(join(f.root, concept.source.path), join(f.root, 'archived.txt')); f.app.livingMemory.refresh();
    f.setClock('2026-10-19T00:00:00.000Z');
    assert.equal((await send(request)).body.status, 'duplicate');
    assert.equal((await send({ ...request, eventId: 'occupied-review' })).body.error.code, 'EVENT_CONFLICT');
    assert.equal((await send({ ...request, eventId: 'fresh-missing' })).body.error.code, 'CONCEPT_NOT_FOUND');
  } finally { await f.close(); }
});

test('App3 import and identity endpoints write real schema3 backups and preserve safe retries across reopening', async () => {
  const f = await appV3Fixture();
  try {
    let session = (await f.send('/api/session')).body;
    const request = observation(f); const source = f.app.livingMemory.getSource();
    f.app.livingMemory.store.addObservation(request, null);
    f.app.livingMemory.store.clearObservationAnswer({ observationEventId: request.eventId });
    f.app.livingMemory.store.updateConfig(12, 1);
    const data = (await f.send('/api/export')).body;
    const options = { restoreLayout: false, restoreReviewPlan: false };
    const preview = await f.send('/api/import/preview', { method: 'POST', headers: headers(session), body: { data, options } });
    assert.equal(preview.status, 200); assert.equal(preview.body.canImport, true);
    const commit = { data, options, importId: 'app-import-3', previewToken: preview.body.token, confirmed: true };
    const imported = await f.send('/api/import/commit', { method: 'POST', headers: headers(session), body: commit });
    assert.equal(imported.status, 201, imported.text);
    const backup = JSON.parse(readFileSync(join(f.dataDir, 'import-backups', imported.body.backupId), 'utf8'));
    assert.equal(backup.schemaVersion, 3); assert.deepEqual(backup.observations, data.observations);
    const old = source.index.concepts.find(c => c.id === request.conceptId)!;
    renameSync(join(f.root, old.source.path), join(f.root, 'Moved.md')); f.app.livingMemory.refresh();
    const target = f.app.livingMemory.getSource().index.concepts.find(c => c.title === old.title)!;
    assert.notEqual(target.id, old.id);
    const identity = { fromConceptId: old.id, toConceptId: target.id };
    const plan = await f.send('/api/identities/preview', { method: 'POST', headers: headers(session), body: identity });
    assert.equal(plan.body.canLink, true, plan.text);
    const link = { ...identity, operationId: 'app-identity-3', previewToken: plan.body.token, confirmed: true };
    const linked = await f.send('/api/identities/commit', { method: 'POST', headers: headers(session), body: link });
    assert.equal(linked.status, 201, linked.text);
    const identityBackup = JSON.parse(readFileSync(join(f.dataDir, 'identity-backups', linked.body.backupId), 'utf8'));
    assert.equal(identityBackup.schemaVersion, 3); assert.deepEqual(identityBackup.observations, data.observations);
    f.restart(); session = (await f.send('/api/session')).body;
    assert.equal(f.app.livingMemory.store.getConfig().halfLifeDays, 12);
    const retry = await f.send('/api/identities/commit', { method: 'POST', headers: headers(session), body: { ...link, previewToken: 'fresh-token-not-a-credential' } });
    assert.equal(retry.status, 200, retry.text); assert.equal(retry.body.status, 'duplicate');
    assert.equal((await f.send('/api/export')).body.observations[0].answer, null);
  } finally { await f.close(); }
});

test('privacy errors map to fixed HTTP statuses without echoing payloads or SQL', () => {
  for (const [code, status] of [['INVALID_IMPORT_DATA', 400], ['INVALID_IMPORT_CURRENT', 503], ['ANSWER_CLEARED', 409],
    ['LOCAL_CLEARING_REQUIRED', 409], ['CLEARING_CONFLICT', 409], ['IMPORT_STALE', 409], ['IMPORT_REJECTED', 409]] as const) {
    let result: any; let actualStatus = 0;
    const response = { status(value: number) { actualStatus = value; return this; }, json(value: unknown) { result = value; } } as Response;
    const error = new AnswerClearingImportError(code); error.message = 'PRIVATE_ANSWER_SQL_SENTINEL'; apiError(response, error);
    assert.equal(actualStatus, status); assert.equal(result.error.code, code); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ANSWER_SQL_SENTINEL/);
  }
  for (const error of [new AnswerClearingSchemaError('ANSWER_CLEARING_SCHEMA_INVALID'), new AnswerClearingStoreError('ANSWER_CLEARED', 409)]) {
    let status = 0; let body: any;
    apiError({ status(value: number) { status = value; return this; }, json(value: unknown) { body = value; } } as Response, error);
    assert.equal(status, error instanceof AnswerClearingSchemaError ? 503 : 409); assert.equal(body.error.code, error.code);
  }
});
