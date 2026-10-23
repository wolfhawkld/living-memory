import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initializeAnswerClearingSchemaV3 } from '../src/server/answer-clearing-schema.js';
import { AnswerClearingStore } from '../src/server/answer-clearing-store.js';
import { decodeAnswerClearingObservation } from '../src/server/answer-clearing-observation-codec.js';
import { ObservationRevisionStore, ObservationRevisionStoreError } from '../src/server/observation-revision-store.js';
import { initializeLearningSchemaV2 } from '../src/server/learning-schema.js';
import { prepareObservationRevision } from '../src/core/observation-revisions.js';
import type { PrivacyObservation } from '../src/shared/answer-clearing.js';

const recordedAt = '2026-10-18T00:00:01.000Z';
const revisedAt = '2026-10-18T00:10:00.000Z';
const clearedAt = '2026-10-23T00:00:00.000Z';
const secret = 'SYNTHETIC_REMOVED_REVISION_ANSWER';
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  initializeAnswerClearingSchemaV3(db, { recordedAt }); db.exec('COMMIT');
  for (const namespace of ['owner', 'other']) {
    db.prepare('INSERT INTO namespaces(namespace,created_at) VALUES (?,?)').run(namespace, recordedAt);
    db.prepare('INSERT INTO config_history(namespace,revision,model_version,half_life_days,recorded_at) VALUES (?,1,?,7,?)')
      .run(namespace, 'time-only-v0', recordedAt);
    db.prepare(`INSERT INTO observations(namespace,event_id,concept_id,source_revision,observed_at,recorded_at,
      config_revision,half_life_days,anchor_event_id,elapsed_days,decay,answer,rating,exposure,observed_exposure,
      learning_json,evidence_mode,request_payload) VALUES (?,?,'concept','rev',?,?,1,7,NULL,NULL,NULL,?,'clear','unexposed',0,NULL,'written',?)`)
      .run(namespace, 'parent', '2026-10-18T00:00:00.000Z', recordedAt, secret, JSON.stringify({ answer: secret }));
  }
  let clockReads = 0, clockFails = false;
  const options = { db, namespace: 'owner', schemaVersion: 3 as const,
    now: () => { clockReads++; if (clockFails) throw new Error('clock must not be read'); return new Date(revisedAt); },
    getObservation(namespace: string, eventId: string): PrivacyObservation | null {
      const row = db.prepare('SELECT * FROM observations WHERE namespace=? AND event_id=?').get(namespace,eventId);
      return row ? decodeAnswerClearingObservation(row) : null;
    },
    findOtherEvent(namespace: string, eventId: string) {
      const row = db.prepare('SELECT request_payload FROM observations WHERE namespace=? AND event_id=?').get(namespace,eventId);
      return row ? { kind: 'observation', requestPayload: row.request_payload as string | null } : null;
    } };
  const store = new ObservationRevisionStore(options);
  const privacy = new AnswerClearingStore({ db, namespace: 'owner', now: () => new Date(clearedAt) });
  return { db, options, store, privacy, failClock() { clockFails = true; }, get clockReads() { return clockReads; } };
}
function revision(eventId = 'r1', previousEventId: string | null = null) {
  return { eventId, observationEventId: 'parent', previousEventId, occurredAt: '2026-10-18T00:02:00.000Z',
    action: 'revise' as const, reason: 'rechecked-original' as const, assessment: { rating: 'partial' as const, learning: null } };
}
function action(kind: 'withdraw' | 'reinstate', eventId: string, previousEventId: string) {
  const { assessment: _assessment, ...request } = revision(eventId,previousEventId);
  return { ...request, action: kind, reason: 'other' as const };
}
function failure(code: string, status: number) {
  return (error: unknown) => { assert.ok(error instanceof ObservationRevisionStoreError);
    assert.equal(error.code, `OBSERVATION_REVISION_${code}`); assert.equal(error.message,error.code); assert.equal(error.status,status); return true; };
}

test('explicit v3 revision ledger rejects empty and v2 databases without changing schema', () => {
  for (const version of ['empty','v2'] as const) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys=ON');
      if (version === 'v2') initializeLearningSchemaV2(db,{recordedAt});
      const before = db.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
      assert.throws(() => new ObservationRevisionStore({ db,namespace:'owner',schemaVersion:3,
        getObservation:() => null, findOtherEvent:() => null }), failure('SCHEMA_UNAVAILABLE',503));
      assert.equal(db.isTransaction,false); assert.deepEqual(db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(),before);
    } finally { db.close(); }
  }
});

test('cleared v3 parents retain original assessments and append-only withdraw/reinstate history without answer copies', () => {
  const f = fixture();
  try {
    const receipt = f.store.append(revision());
    f.privacy.clear({observationEventId:'parent'});
    f.store.append(action('withdraw','r2','r1')); f.store.append(action('reinstate','r3','r2'));
    const history = f.store.readHistory('parent');
    assert.equal(history.observation.answer,null);
    if (history.observation.answer === null) assert.deepEqual(history.observation.answerClearing,{observationEventId:'parent',clearedAt});
    assert.equal(history.observation.rating,'clear'); assert.equal(history.state.currentAssessment.rating,'partial');
    assert.equal(history.state.status,'active'); assert.deepEqual(history.events.map(event=>event.eventId),['r3','r2','r1']);
    assert.equal(history.total,3); assert.equal(history.observationRevisionCount,3);
    assert.equal(JSON.stringify(history).includes(secret),false);
    assert.equal(f.options.getObservation('other','parent')!.answer,secret);
    f.failClock(); const beforeReads=f.clockReads;
    assert.deepEqual(f.store.append(revision()),{...receipt,status:'duplicate'}); assert.equal(f.clockReads,beforeReads);
    assert.throws(()=>f.store.append({...revision(),note:'changed'}),failure('EVENT_CONFLICT',409));
    const row=f.db.prepare('SELECT answer,request_payload,answer_cleared_at FROM observations WHERE namespace=? AND event_id=?').get('owner','parent');
    assert.deepEqual({...row},{answer:null,request_payload:null,answer_cleared_at:clearedAt});
  } finally {f.db.close();}
});

test('new rechecked-original decisions reject a cleared parent while a different explicit basis remains available', () => {
  const f=fixture();
  try {
    f.privacy.clear({observationEventId:'parent'});
    const before=f.db.prepare('SELECT * FROM observation_revisions').all();
    assert.throws(()=>f.store.append(revision()),failure('INVALID_TRANSITION',409));
    assert.deepEqual(f.db.prepare('SELECT * FROM observation_revisions').all(),before);
    assert.equal(f.db.isTransaction,false);
    assert.equal(f.store.append({...revision(),reason:'input-error'}).status,'accepted');
    assert.equal(f.store.readHistory('parent').observation.answer,null);
  } finally {f.db.close();}
});

test('v3 revision cursors bind the current clearing marker and never navigate using a pre-clear page', () => {
  const f=fixture();
  try {
    f.store.append(revision()); f.store.append(action('withdraw','r2','r1')); f.store.append(action('reinstate','r3','r2'));
    const before=f.store.readHistory('parent',{limit:1}); assert.ok(before.nextCursor);
    const beforeCursor=JSON.parse(Buffer.from(before.nextCursor,'base64url').toString());
    assert.equal(beforeCursor.version,2); assert.equal(beforeCursor.clearedAt,null);
    assert.equal(JSON.stringify(beforeCursor).includes(secret),false);
    f.privacy.clear({observationEventId:'parent'});
    assert.throws(()=>f.store.readHistory('parent',{limit:1,cursor:before.nextCursor!}),failure('HISTORY_CHANGED',409));
    const fresh=f.store.readHistory('parent',{limit:1}); assert.ok(fresh.nextCursor);
    assert.equal(JSON.parse(Buffer.from(fresh.nextCursor,'base64url').toString()).clearedAt,clearedAt);
    assert.equal(f.store.readHistory('parent',{limit:1,cursor:fresh.nextCursor}).events[0].eventId,'r2');
    const forged={...beforeCursor,version:1}; delete forged.clearedAt;
    assert.throws(()=>f.store.readHistory('parent',{cursor:Buffer.from(JSON.stringify(forged)).toString('base64url')}),failure('INVALID_HISTORY_QUERY',400));
    assert.equal(f.db.isTransaction,false);
  } finally {f.db.close();}
});

test('a cleared parent keeps its occupied event ID and failed nested append preserves caller transaction work', () => {
  const f=fixture();
  try {
    f.privacy.clear({observationEventId:'parent'});
    assert.throws(()=>f.store.append({...revision('parent'),reason:'input-error'}),failure('EVENT_CONFLICT',409));
    f.db.exec('BEGIN IMMEDIATE');
    f.db.prepare('UPDATE config_history SET half_life_days=11 WHERE namespace=?').run('owner');
    assert.throws(()=>f.store.append({...revision(),reason:'input-error'}),failure('WRITE_FAILED',503));
    assert.equal(f.db.isTransaction,true);
    assert.equal(f.db.prepare('SELECT half_life_days FROM config_history WHERE namespace=?').get('owner')!.half_life_days,11);
    assert.equal(f.store.readHistory('parent').observation.answer,null); assert.equal(f.db.isTransaction,true);
    f.db.exec('ROLLBACK');
    assert.equal(f.db.prepare('SELECT half_life_days FROM config_history WHERE namespace=?').get('owner')!.half_life_days,7);
  } finally {if(f.db.isTransaction)f.db.exec('ROLLBACK'); f.db.close();}
});

test('pure preparation preserves an exact historical recheck after clearing but refuses a new claim to recheck it', () => {
  const f=fixture();
  try {
    f.store.append(revision()); const events=f.store.getRevisions(); f.privacy.clear({observationEventId:'parent'});
    const parent=f.options.getObservation('owner','parent')!;
    assert.deepEqual(prepareObservationRevision({observation:parent,revisions:events,request:revision(),recordedAt:'invalid'}),{status:'duplicate',event:events[0]});
    assert.throws(()=>prepareObservationRevision({observation:parent,revisions:events,
      request:{...revision('r2','r1'),assessment:{rating:'blank',learning:null}},recordedAt:revisedAt}),{code:'INVALID_TRANSITION'});
  } finally {f.db.close();}
});
