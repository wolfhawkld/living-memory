import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createObservationRevisionTables, ObservationRevisionStore, ObservationRevisionStoreError } from '../src/server/observation-revision-store.js';
import type { Observation } from '../src/shared/types.js';

const prefix = 'OBSERVATION_REVISION_';
function failure(code: string, status: number) {
  return (error: unknown) => { assert.ok(error instanceof ObservationRevisionStoreError); assert.equal(error.code, prefix + code);
    assert.equal(error.message, prefix + code); assert.equal(error.status, status); return true; };
}
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE observations(namespace TEXT,event_id TEXT,body TEXT,request_payload TEXT,PRIMARY KEY(namespace,event_id));
    CREATE TABLE other_events(namespace TEXT,event_id TEXT,kind TEXT,request_payload TEXT);`);
  const raw: Observation = { eventId: 'parent', conceptId: 'old-concept', sourceRevision: 'old-revision',
    observedAt: '2026-10-18T00:00:00Z', recordedAt: '2026-10-18T00:00:01Z', rating: 'clear', answer: 'private original answer',
    evidenceMode: 'written', exposure: 'unexposed', observedExposure: false, configRevision: 1, halfLifeDays: 7,
    anchorEventId: null, elapsedDays: null, decay: null,
    learning: { task: 'concept', confidence: 80, confidenceAt: '2026-10-17T23:59:00Z', cue: 'independent', outcome: 'success', basis: 'self-check' } };
  for (const namespace of ['alice', 'bob']) db.prepare('INSERT INTO observations VALUES(?,?,?,?)').run(namespace, 'parent', JSON.stringify(raw), 'original raw payload');
  createObservationRevisionTables(db);
  let clockReads = 0;
  let time = '2026-10-18T00:10:00Z';
  const options = { db, namespace: 'alice', now: () => { clockReads++; return new Date(time); },
    getObservation(namespace: string, eventId: string) {
      const row = db.prepare('SELECT body FROM observations WHERE namespace=? AND event_id=?').get(namespace, eventId);
      return row ? JSON.parse(String(row.body)) as Observation : null;
    },
    findOtherEvent(namespace: string, eventId: string) {
      const row = db.prepare('SELECT kind,request_payload FROM other_events WHERE namespace=? AND event_id=?').get(namespace, eventId);
      if (row) return { kind: String(row.kind), requestPayload: String(row.request_payload) };
      if (db.prepare('SELECT 1 FROM observations WHERE namespace=? AND event_id=?').get(namespace,eventId)) return { kind: 'observation', requestPayload: 'original raw payload' };
      return null;
    },
  };
  const store = new ObservationRevisionStore(options);
  return { db, raw, options, store, setTime(value: string) { time = value; }, get clockReads() { return clockReads; } };
}
function revision(eventId = 'r1', previousEventId: string | null = null) {
  return { eventId, observationEventId: 'parent', previousEventId, occurredAt: '2026-10-18T00:02:00Z', action: 'revise', reason: 'input-error',
    assessment: { rating: 'partial', learning: { outcome: 'failure', basis: 'self-check' } } };
}
function action(action: 'withdraw' | 'reinstate', eventId: string, previousEventId: string) {
  const { assessment: _assessment, ...base } = revision(eventId, previousEventId); return { ...base, action };
}

test('explicit DDL stays in the caller transaction and construction neither creates schema nor takes ownership of the connection', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE observations(namespace TEXT,event_id TEXT,PRIMARY KEY(namespace,event_id))');
    const options = { db, namespace: 'alice', getObservation: () => null, findOtherEvent: () => null };
    const before = db.prepare('SELECT * FROM sqlite_master').all();
    assert.throws(() => new ObservationRevisionStore(options), failure('SCHEMA_UNAVAILABLE',503));
    assert.deepEqual(db.prepare('SELECT * FROM sqlite_master').all(),before);
    db.exec('BEGIN'); createObservationRevisionTables(db); db.exec('ROLLBACK');
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='observation_revisions'").get()!.n,0);
    createObservationRevisionTables(db);
    const schema = db.prepare('SELECT * FROM sqlite_master').all();
    new ObservationRevisionStore(options);
    assert.deepEqual(db.prepare('SELECT * FROM sqlite_master').all(),schema);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,0);
    db.exec('DROP INDEX observation_revisions_root');
    assert.throws(() => new ObservationRevisionStore(options), failure('SCHEMA_UNAVAILABLE',503));
    assert.equal(db.prepare('SELECT 1 AS n').get()!.n,1);
  } finally {db.close();}
});

test('revise withdraw and reinstate preserve the original observation and restore the last adopted assessment', () => {
  const f=fixture();
  try {
    const before=f.db.prepare('SELECT * FROM observations ORDER BY namespace').all();
    assert.equal(f.store.append({...revision(),note:''}).status,'accepted');
    f.store.append(action('withdraw','r2','r1')); f.store.append(action('reinstate','r3','r2'));
    const history=f.store.readHistory('parent');
    assert.deepEqual(history.events.map(event=>event.eventId),['r3','r2','r1']);
    assert.deepEqual(history.state,{status:'active',currentAssessment:revision().assessment,latestRevisionEventId:'r3',appliedRevisionCount:3});
    assert.deepEqual(history.observation,f.raw);assert.equal(history.total,3);assert.equal(history.observationRevisionCount,3);
    assert.equal(history.nextCursor,null);
    assert.deepEqual(f.db.prepare('SELECT * FROM observations ORDER BY namespace').all(),before);
    const rows=f.db.prepare('SELECT note,assessment_json FROM observation_revisions ORDER BY event_id').all();
    assert.equal(rows[0].note,'');assert.equal(rows[1].note,null);assert.equal(rows[1].assessment_json,null);
    assert.equal(JSON.stringify(f.store.getRevisions()).includes('private original answer'),false);
  } finally {f.db.close();}
});

test('duplicate receipt wins over advanced tail and invalid new clock, conflicts never change persisted requests', () => {
  const f=fixture();
  try {
    const first=f.store.append(revision());f.store.append(action('withdraw','r2','r1'));
    const original=f.db.prepare('SELECT * FROM observation_revisions ORDER BY event_id').all();
    f.setTime('invalid');const reads=f.clockReads;
    assert.deepEqual(f.store.append(revision()),{...first,status:'duplicate'});assert.equal(f.clockReads,reads);
    assert.throws(()=>f.store.append({...revision(),note:'different'}),failure('EVENT_CONFLICT',409));
    f.db.prepare('INSERT INTO other_events VALUES(?,?,?,?)').run('alice','other','anchor','private payload');
    assert.throws(()=>f.store.append(revision('other','r2')),failure('EVENT_CONFLICT',409));
    assert.throws(()=>f.store.append(revision('parent','r2')),failure('EVENT_CONFLICT',409));
    assert.deepEqual(f.db.prepare('SELECT * FROM observation_revisions ORDER BY event_id').all(),original);
  } finally {f.db.close();}
});

test('missing parents, stale predecessors, unchanged assessments and invalid transitions are distinguished and release write transactions', () => {
  const f=fixture();
  try {
    assert.throws(()=>f.store.append({...revision(),observationEventId:'missing'}),failure('NOT_FOUND',404));
    assert.throws(()=>f.store.append({...revision(),assessment:{rating:'clear',learning:{outcome:'success',basis:'self-check'}}}),failure('UNCHANGED_ASSESSMENT',409));
    assert.throws(()=>f.store.append({...revision(),conceptId:'spoof'}),failure('INVALID_REQUEST',400));
    assert.throws(()=>f.store.append({...revision(),occurredAt:'2027-01-01T00:00:00Z'}),failure('INVALID_TIME',400));
    f.store.append(revision());
    assert.throws(()=>f.store.append(revision('r2')),failure('PREVIOUS_EVENT_CONFLICT',409));
    f.store.append(action('withdraw','r2','r1'));
    assert.throws(()=>f.store.append(revision('r3','r2')),failure('INVALID_TRANSITION',409));
    assert.throws(()=>f.store.append({...action('reinstate','r3','r2'),assessment:undefined}),failure('INVALID_REQUEST',400));
    const beforeSuccessfulAppend=f.clockReads;
    assert.equal(f.store.append(action('reinstate','r3','r2')).status,'accepted');
    assert.equal(f.clockReads,beforeSuccessfulAppend+1);
  } finally {f.db.close();}
});

test('history cursors follow chain order at equal receipts and only changes to their own parent invalidate pagination', () => {
  const f=fixture();
  try {
    f.store.append(revision('z'));f.store.append(action('withdraw','a','z'));f.store.append(action('reinstate','m','a'));
    const first=f.store.readHistory('parent',{limit:1});assert.equal(first.events[0].eventId,'m');assert.ok(first.nextCursor);
    assert.deepEqual(f.store.getRevisions().map(event=>event.eventId),['a','m','z']);
    const other={...f.raw,eventId:'second'};f.db.prepare('INSERT INTO observations VALUES(?,?,?,?)').run('alice','second',JSON.stringify(other),'second raw');
    f.store.append({...revision('other'),observationEventId:'second'});
    const second=f.store.readHistory('parent',{limit:1,cursor:first.nextCursor!});
    assert.equal(second.events[0].eventId,'a');assert.equal(second.observationRevisionCount,4);
    assert.equal(f.store.readHistory('parent',{cursor:second.nextCursor!}).events[0].eventId,'z');
    for(const limit of [0,51,1.5,NaN])assert.throws(()=>f.store.readHistory('parent',{limit}),failure('INVALID_HISTORY_QUERY',400));
    assert.throws(()=>f.store.readHistory('parent',{limit:null as unknown as number}),failure('INVALID_HISTORY_QUERY',400));
    const getter={get limit():number {throw new Error('private original answer');}};
    assert.throws(()=>f.store.readHistory('parent',getter),failure('INVALID_HISTORY_QUERY',400));
    assert.throws(()=>f.store.readHistory('second',{cursor:first.nextCursor!}),failure('INVALID_HISTORY_QUERY',400));
    const bob=new ObservationRevisionStore({...f.options,namespace:'bob'});
    assert.throws(()=>bob.readHistory('parent',{cursor:first.nextCursor!}),failure('INVALID_HISTORY_QUERY',400));
    assert.equal(bob.getRevisionCount(),0);
    f.store.append(action('withdraw','next','m'));
    assert.throws(()=>f.store.readHistory('parent',{cursor:first.nextCursor!}),failure('HISTORY_CHANGED',409));
    const decoded=JSON.parse(Buffer.from(f.store.readHistory('parent',{limit:1}).nextCursor!,'base64url').toString());
    decoded.beforeEventId='absent';
    assert.throws(()=>f.store.readHistory('parent',{cursor:Buffer.from(JSON.stringify(decoded)).toString('base64url')}),failure('INVALID_HISTORY_QUERY',400));
    for(const cursor of ['bad=', '_'.repeat(2049), Buffer.from('{}').toString('base64url')])assert.throws(()=>f.store.readHistory('parent',{cursor}),failure('INVALID_HISTORY_QUERY',400));
  } finally {f.db.close();}
});

test('history reads preserve caller transactions and never use a backwards now to hide a saved tail', () => {
  const f=fixture();
  try {
    f.store.append(revision());f.setTime('2020-01-01T00:00:00Z');
    f.db.exec('BEGIN');f.db.prepare('INSERT INTO other_events VALUES(?,?,?,?)').run('alice','outer','anchor','outer payload');
    const history=f.store.readHistory('parent');assert.equal(history.state.latestRevisionEventId,'r1');
    assert.throws(()=>f.store.readHistory('missing'),failure('NOT_FOUND',404));
    assert.throws(()=>f.store.append(action('withdraw','r2','r1')),failure('WRITE_FAILED',503));
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM other_events WHERE event_id='outer'").get()!.n,1);
    f.db.exec('ROLLBACK');
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM other_events WHERE event_id='outer'").get()!.n,0);
  } finally {f.db.close();}
});

test('corrupt stored payloads, columns or complete chains fail closed with fixed diagnostics', () => {
  for(const corruption of ['payload','columns','chain'] as const){
    const f=fixture();
    try {
      f.store.append(revision());
      if(corruption==='payload')f.db.exec("UPDATE observation_revisions SET request_payload='private original answer'");
      else if(corruption==='columns')f.db.exec("UPDATE observation_revisions SET note='private original answer'");
      else {
        const event=f.store.getRevisions()[0];
        const request={...revision(),assessment:{rating:'clear',learning:{outcome:'success',basis:'self-check'}}};
        f.db.prepare('UPDATE observation_revisions SET assessment_json=?,request_payload=?').run(JSON.stringify(request.assessment),JSON.stringify(request));
        assert.equal(event.eventId,'r1');
      }
      assert.throws(()=>f.store.readHistory('parent'),failure('DATA_INVALID',503));
      if(corruption!=='chain')assert.throws(()=>f.store.getRevisions(),failure('DATA_INVALID',503));
      assert.throws(()=>f.store.append(action('withdraw','r2','r1')),failure('DATA_INVALID',503));
      f.db.exec('BEGIN; ROLLBACK');
    } finally {f.db.close();}
  }
});

test('construction rejects altered CHECK literals and already broken foreign keys without repairing either', () => {
  const changed=fixture();
  try {
    const sql=String(changed.db.prepare("SELECT sql FROM sqlite_master WHERE name='observation_revisions'").get()!.sql);
    changed.db.exec('DROP TABLE observation_revisions');
    changed.db.exec(sql.replace("'revise'","'REVISE'"));
    createObservationRevisionTables(changed.db);
    const before=changed.db.prepare('SELECT * FROM sqlite_master').all();
    assert.throws(()=>new ObservationRevisionStore(changed.options),failure('SCHEMA_UNAVAILABLE',503));
    assert.deepEqual(changed.db.prepare('SELECT * FROM sqlite_master').all(),before);
  } finally {changed.db.close();}
  const broken=fixture();
  try {
    broken.store.append(revision());
    broken.db.exec('PRAGMA foreign_keys=OFF');
    broken.db.exec("UPDATE observation_revisions SET observation_event_id='missing'");
    broken.db.exec('PRAGMA foreign_keys=ON');
    const before=broken.db.prepare('SELECT * FROM observation_revisions').all();
    assert.throws(()=>new ObservationRevisionStore(broken.options),failure('SCHEMA_UNAVAILABLE',503));
    assert.deepEqual(broken.db.prepare('SELECT * FROM observation_revisions').all(),before);
  } finally {broken.db.close();}
});

test('a maximal UTF-8 namespace roundtrips bounded history cursors while invalid namespaces leave schema unchanged', () => {
  const f=fixture();
  try {
    const namespace='字'.repeat(85)+'a';assert.equal(Buffer.byteLength(namespace,'utf8'),256);
    f.db.prepare('INSERT INTO observations VALUES(?,?,?,?)').run(namespace,'parent',JSON.stringify(f.raw),'original raw payload');
    const store=new ObservationRevisionStore({...f.options,namespace});
    const rootId='r'+'a'.repeat(127),tailId='w'+'b'.repeat(127);
    store.append(revision(rootId));store.append(action('withdraw',tailId,rootId));
    const first=store.readHistory('parent',{limit:1});
    assert.equal(first.events[0].eventId,tailId);assert.ok(first.nextCursor);
    assert.ok(first.nextCursor.length<=2048);
    const second=store.readHistory('parent',{limit:1,cursor:first.nextCursor});
    assert.equal(second.events[0].eventId,rootId);assert.equal(second.nextCursor,null);
    const before=f.db.prepare('SELECT * FROM sqlite_master').all();
    for(const invalid of ['', ' alice', 'alice ', 'alice\n', 'alice\u0000', 'alice\u007f', 'a'.repeat(257), '字'.repeat(86)]){
      assert.throws(()=>new ObservationRevisionStore({...f.options,namespace:invalid}),failure('INVALID_REQUEST',400));
    }
    assert.deepEqual(f.db.prepare('SELECT * FROM sqlite_master').all(),before);
  } finally {f.db.close();}
});
