import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store, StoreError, parseObservationRequest } from '../src/server/store.js';
import type { Concept, ObservationRequest } from '../src/shared/types.js';

const now = '2026-01-10T12:00:00.000Z';
const concept: Concept = { id: 'concept-alpha', title: 'Alpha', aliases: [], domain: 'Math',
  summary: 'summary', body: 'body', source: { path: 'Math/Alpha.md', revision: 'rev-1' } };
const options = { restoreLayout: false, restoreReviewPlan: false };
const source = { name: 'synthetic', mode: 'local' as const, conceptCount: 1, limit: 1, diagnostics: [] };
const request = (fields: Partial<ObservationRequest> = {}): ObservationRequest => ({
  eventId: 'obs-1', conceptId: concept.id, sourceRevision: concept.source.revision,
  observedAt: '2026-01-09T12:00:00.000Z', configRevision: 1, anchorEventId: null,
  answer: '', rating: 'blank', exposure: 'unexposed', observedExposure: false, ...fields,
});
const modeError = (error: unknown) => error instanceof StoreError && error.code === 'INVALID_EVIDENCE_MODE';
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'lm-evidence-mode-'));
  const dbPath = join(dataDir, 'test.sqlite');
  const open = () => new Store({ dbPath, namespace: 'synthetic', now: () => new Date(now) });
  let store = open();
  return { get store() { return store; }, dbPath, reopen(closed = false) { if (!closed) store.close(); store = open(); },
    cleanup() { store.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

test('request mode is explicit, validates mental empty answers exactly, and preserves written blanks', () => {
  assert.equal(Object.hasOwn(parseObservationRequest(request()), 'evidenceMode'), false);
  assert.equal(parseObservationRequest(request({ evidenceMode: 'mental' })).evidenceMode, 'mental');
  assert.equal(parseObservationRequest(request({ evidenceMode: 'written' })).answer, '');
  assert.equal(parseObservationRequest(request({ evidenceMode: 'written', answer: 'explanation' })).evidenceMode, 'written');
  for (const evidenceMode of [null, 'spoken', '', false, 0, {}]) {
    assert.throws(() => parseObservationRequest({ ...request(), evidenceMode }), modeError);
  }
  for (const answer of [' ', '\n', 'explanation', null, undefined, 1]) {
    assert.throws(() => parseObservationRequest({ ...request(), evidenceMode: 'mental', answer }), modeError);
  }
});

test('direct store validates evidence, keeps legacy payload deduplication, and mode changes conflict', () => {
  const f = fixture();
  try {
    for (const evidenceMode of [null, 'spoken', '']) {
      assert.throws(() => f.store.addObservation({ ...request(), evidenceMode } as ObservationRequest, null), modeError);
    }
    assert.throws(() => f.store.addObservation(request({ evidenceMode: 'mental', answer: ' ' }), null), modeError);
    assert.equal(f.store.countObservations(), 0);
    assert.equal(f.store.addObservation(request(), null).status, 'accepted');
    assert.equal(f.store.addObservation(request(), null).status, 'duplicate');
    assert.throws(() => f.store.addObservation(request({ evidenceMode: 'mental' }), null),
      (e: unknown) => e instanceof StoreError && e.code === 'EVENT_CONFLICT');
    for (const mode of ['mental', 'written'] as const) {
      const value = request({ eventId: `obs-${mode}`, evidenceMode: mode });
      assert.equal(f.store.addObservation(value, null).status, 'accepted');
      assert.equal(f.store.addObservation(value, null).status, 'duplicate');
    }
    f.reopen();
    const observations = f.store.getObservations();
    assert.equal(Object.hasOwn(observations[0]!, 'evidenceMode'), false);
    assert.deepEqual(observations.slice(1).map(o => o.evidenceMode), ['mental', 'written']);
    const history = f.store.getConceptHistory(concept, now, 20).entries.filter(e => e.type === 'observation');
    assert.deepEqual(new Map(history.map(e => [e.event.eventId, e.event.evidenceMode])),
      new Map(observations.map(o => [o.eventId, o.evidenceMode])));
  } finally { f.cleanup(); }
});

test('mental evidence freezes original half life and decay without changing anchor or retained status', () => {
  const f = fixture();
  try {
    f.store.addReview({ eventId: 'anchor', conceptId: concept.id, sourceRevision: concept.source.revision,
      kind: 'review', occurredAt: '2026-01-02T12:00:00.000Z' });
    f.store.addRetention({ eventId: 'retained', conceptId: concept.id, sourceRevision: concept.source.revision,
      occurredAt: '2026-01-03T12:00:00.000Z', active: true, previousEventId: null }, null);
    const before = f.store.exportData(source, [concept]);
    f.store.addObservation(request({ evidenceMode: 'mental', anchorEventId: 'anchor' }), 'anchor');
    f.store.updateConfig(14, 1);
    const exported = f.store.exportData(source, [concept]);
    assert.deepEqual(exported.anchors, before.anchors);
    assert.deepEqual(exported.retentions, before.retentions);
    assert.equal(exported.observations[0]!.halfLifeDays, 7);
    assert.equal(exported.observations[0]!.elapsedDays, 7);
    assert.equal(exported.observations[0]!.decay, 0.5);
    assert.equal(exported.observations[0]!.anchorEventId, 'anchor');
  } finally { f.cleanup(); }
});

test('additive SQLite migration leaves legacy stored fields and canonical retry payload unchanged', () => {
  const f = fixture();
  try {
    f.store.addObservation(request({ answer: 'legacy answer' }), null);
    f.store.close();
    const db = new DatabaseSync(f.dbPath);
    const before = db.prepare('SELECT request_payload, answer, half_life_days FROM observations').get();
    db.exec('ALTER TABLE observations DROP COLUMN evidence_mode');
    db.close();
    f.reopen(true);
    assert.equal(Object.hasOwn(f.store.getObservations()[0]!, 'evidenceMode'), false);
    assert.equal(f.store.addObservation(request({ answer: 'legacy answer' }), null).status, 'duplicate');
    const migrated = new DatabaseSync(f.dbPath);
    assert.deepEqual(migrated.prepare('SELECT request_payload, answer, half_life_days FROM observations').get(), before);
    assert.equal((migrated.prepare('SELECT evidence_mode FROM observations').get() as { evidence_mode: null }).evidence_mode, null);
    migrated.close();
  } finally { f.cleanup(); }
});

test('JSON export, preview, restore and repeated imports preserve explicit modes and absent legacy mode', () => {
  const donor = fixture(); const target = fixture();
  try {
    for (const [eventId, evidenceMode] of [['legacy', undefined], ['mental', 'mental'], ['written', 'written']] as const) {
      donor.store.addObservation(request({ eventId, ...(evidenceMode ? { evidenceMode } : {}) }), null);
    }
    const data = JSON.parse(JSON.stringify(donor.store.exportData(source, [concept])));
    assert.equal(data.schemaVersion, 1);
    const preview = target.store.previewImport(data, options, source, [concept]);
    assert.equal(preview.canImport, true, JSON.stringify(preview.issues));
    const commit = { data, options, importId: 'restore', previewToken: preview.token, confirmed: true as const };
    target.store.commitImport(commit, source, [concept], () => 'synthetic-backup');
    assert.deepEqual(target.store.getObservations(), donor.store.getObservations());
    const replay = target.store.previewImport(data, options, source, [concept]);
    assert.equal(replay.canImport, true, JSON.stringify(replay.issues));
    assert.equal(replay.counts.added.observations, 0);
    assert.equal(target.store.addObservation(request({ eventId: 'legacy' }), null).status, 'duplicate');
    assert.equal(target.store.addObservation(request({ eventId: 'mental', evidenceMode: 'mental' }), null).status, 'duplicate');
    for (const evidenceMode of [null, 'other']) {
      const invalid = structuredClone(data); invalid.observations[0].evidenceMode = evidenceMode;
      assert.throws(() => target.store.previewImport(invalid, options, source, [concept]), modeError);
    }
    const invalid = structuredClone(data); invalid.observations[1].answer = 'nonempty';
    assert.throws(() => target.store.previewImport(invalid, options, source, [concept]), modeError);
  } finally { donor.cleanup(); target.cleanup(); }
});

test('import identity remapping preserves modes, while legacy observations keep no mode key', () => {
  const donor = fixture(); const target = fixture();
  try {
    for (const [eventId, evidenceMode] of [['legacy', undefined], ['mental', 'mental'], ['written', 'written']] as const) {
      donor.store.addObservation(request({ eventId, ...(evidenceMode ? { evidenceMode } : {}) }), null);
    }
    const data = donor.store.exportData(source, [concept]);
    const mappedConcept = { ...concept, id: 'mapped-alpha' };
    const preview = target.store.previewImport(data, options, source, [mappedConcept]);
    assert.equal(preview.canImport, true, JSON.stringify(preview.issues));
    assert.equal(preview.matches.find(m => m.fromId === concept.id)?.match, 'path-revision');
    target.store.commitImport({ data, options, importId: 'mapped-restore', previewToken: preview.token, confirmed: true },
      source, [mappedConcept], () => 'synthetic-backup');
    assert.deepEqual(target.store.getObservations(), donor.store.getObservations().map(o => ({ ...o, conceptId: mappedConcept.id })));
    const exported = target.store.exportData(source, [mappedConcept]);
    assert.equal(Object.hasOwn(exported.observations[0]!, 'evidenceMode'), false);
    assert.equal(exported.observations[1]!.evidenceMode, 'mental');
    assert.equal(exported.observations[2]!.evidenceMode, 'written');
  } finally { donor.cleanup(); target.cleanup(); }
});
