import assert from 'node:assert/strict';
import test from 'node:test';
import { planObservationRevisionImport, ObservationRevisionImportError, type ObservationRevisionImportInput } from '../src/server/observation-revision-import.js';
import type { Observation } from '../src/shared/types.js';
import type { ObservationRevision } from '../src/shared/observation-revisions.js';

function parent(eventId='parent'): Observation {
  return { eventId,conceptId:'concept',sourceRevision:'revision',observedAt:'2026-10-18T00:00:00Z',recordedAt:'2026-10-18T00:01:00Z',
    configRevision:1,halfLifeDays:7,anchorEventId:null,elapsedDays:null,decay:null,answer:'Private frozen answer',rating:'clear',
    exposure:'unexposed',observedExposure:false,evidenceMode:'written',learning:{task:'concept',confidence:80,confidenceAt:'2026-10-17T23:59:00Z',
      cue:'independent',outcome:'success',basis:'self-check'} };
}
function root(eventId='z',observationEventId='parent'): ObservationRevision {
  return {eventId,observationEventId,previousEventId:null,occurredAt:'2026-10-18T00:02:00Z',recordedAt:'2026-10-18T00:03:00Z',
    action:'revise',reason:'input-error',assessment:{rating:'partial',learning:{outcome:'failure',basis:'self-check'}},conceptId:'concept',sourceRevision:'revision'};
}
function action(action:'withdraw'|'reinstate',eventId:string,previousEventId:string,observationEventId='parent'): ObservationRevision {
  const {assessment:_assessment,...base}=root(eventId,observationEventId);return {...base,action,previousEventId};
}
function input(overrides: Partial<ObservationRevisionImportInput>={}): ObservationRevisionImportInput {
  return {currentObservations:[parent()],observations:[parent()],currentRevisions:[],incomingRevisions:[],occupiedEventIds:new Set(['parent']),exportedAt:'2026-10-18T00:10:00Z',...overrides};
}
function rejects(data: ObservationRevisionImportInput, suffix: string) {
  assert.throws(()=>planObservationRevisionImport(data),error=>{
    assert.ok(error instanceof ObservationRevisionImportError);
    assert.equal(error.code,`OBSERVATION_REVISION_IMPORT_${suffix}`);assert.equal(error.message,error.code);
    assert.doesNotMatch(error.message,/Private|answer|note|SQL/);return true;
  });
}

test('v1 empty incoming preserves the current chain and a later current receipt is never filtered by the older export time',()=>{
  const late={...root(),recordedAt:'2026-10-20T00:00:00Z'};
  const plan=planObservationRevisionImport(input({currentRevisions:[late],exportedAt:'2026-10-18T00:04:00Z'}));
  assert.deepEqual(plan.newRevisions,[]);assert.deepEqual(plan.duplicateEventIds,[]);
  assert.equal(plan.mergedRevisions[0].recordedAt,'2026-10-20T00:00:00.000Z');
});

test('old prefix replays are idempotent and new successors follow the current tail in chain rather than lexical order',()=>{
  const z=root(),a=action('withdraw','a','z'),m=action('reinstate','m','a');
  const prefix=planObservationRevisionImport(input({currentRevisions:[m,z,a],incomingRevisions:[a,z]}));
  assert.deepEqual(prefix.duplicateEventIds,['a','z']);assert.deepEqual(prefix.newRevisions,[]);
  assert.deepEqual(prefix.mergedRevisions.map(event=>event.eventId),['z','a','m']);
  const next=action('withdraw','b','m');
  const appended=planObservationRevisionImport(input({currentRevisions:[a,z,m],incomingRevisions:[next,z]}));
  assert.deepEqual(appended.newRevisions.map(event=>event.eventId),['b']);
  assert.deepEqual(appended.mergedRevisions.map(event=>event.eventId),['z','a','m','b']);
});

test('canonical complete event duplicates normalize time and key order but preserve metadata and receipt conflicts',()=>{
  const original=root();
  const canonical=Object.fromEntries(Object.entries({...original,occurredAt:'2026-10-18T08:02:00+08:00',recordedAt:'2026-10-18T08:03:00+08:00'}).reverse());
  const plan=planObservationRevisionImport(input({currentRevisions:[original,canonical],incomingRevisions:[canonical,original]}));
  assert.equal(plan.mergedRevisions.length,1);assert.deepEqual(plan.duplicateEventIds,['z']);
  for(const changed of [{...original,note:''},{...original,recordedAt:'2026-10-18T00:04:00Z'},
    {...original,conceptId:'another-concept'},{...original,sourceRevision:'another-revision'},{...original,reason:'other'}]){
    rejects(input({currentRevisions:[original],incomingRevisions:[changed]}),'EVENT_CONFLICT');
  }
  rejects(input({currentRevisions:[original,{...original,note:'different'}]}),'EVENT_CONFLICT');
});

test('repeated incoming events collapse without changing new-event ordering and occupied IDs never enter the revision ledger',()=>{
  const z=root(),a=action('withdraw','a','z');
  const plan=planObservationRevisionImport(input({incomingRevisions:[a,z,z,a]}));
  assert.deepEqual(plan.newRevisions.map(event=>event.eventId),['z','a']);assert.deepEqual(plan.duplicateEventIds,['a','z']);
  for(const kind of ['anchor','observation','retention','application','correction','relation-review','practice-card','practice-attempt']){
    rejects(input({incomingRevisions:[root(kind)],occupiedEventIds:new Set([kind])}),'EVENT_CONFLICT');
    rejects(input({currentRevisions:[root(kind)],occupiedEventIds:new Set([kind])}),'EVENT_CONFLICT');
  }
});

test('bad current chains cannot be repaired or selected by incoming records even when their union would be valid',()=>{
  const z=root(),a=action('withdraw','a','z');
  rejects(input({currentRevisions:[a],incomingRevisions:[z]}),'INVALID_CHAIN');
  rejects(input({currentRevisions:[z,root('fork')],incomingRevisions:[]}),'INVALID_CHAIN');
  rejects(input({currentRevisions:[{...z,reason:'private invalid value'}],incomingRevisions:[z]}),'INVALID_CURRENT');
});

test('parent attribution, cycles, forks, missing predecessors and illegal state changes fail without reverting to raw scores',()=>{
  const z=root(),a=action('withdraw','a','z');
  for(const events of [[{...z,observationEventId:'missing'}],[{...z,conceptId:'wrong'}],[{...z,sourceRevision:'wrong'}],
    [z,root('fork')],[{...z,previousEventId:'missing'}],[{...z,previousEventId:'a'},a],
    [z,a,action('withdraw','m','a')],[{...z,assessment:{rating:'clear',learning:{outcome:'success',basis:'self-check'}}}],
    [z,{...a,occurredAt:'2026-10-18T00:01:00Z'}]]){
    rejects(input({incomingRevisions:events}),'INVALID_CHAIN');
  }
  rejects(input({observations:[parent(),parent()]}),'INVALID_INPUT');
  rejects(input({currentObservations:[parent(),parent()]}),'INVALID_INPUT');
  rejects(input({observations:[{...parent(),recordedAt:'private invalid timestamp'}]}),'INVALID_INPUT');
  rejects(input({incomingRevisions:[{...z,assessment:{rating:'partial',learning:null}}]}),'INVALID_CHAIN');
  rejects(input({observations:[parent('one'),parent('two')],incomingRevisions:[root('r-one','one'),action('withdraw','cross','r-one','two')]}),'INVALID_CHAIN');
});

test('incoming future receipts and malformed events are rejected before asOf projection could hide them',()=>{
  rejects(input({incomingRevisions:[{...root(),recordedAt:'2026-10-19T00:00:00Z'}]}),'INVALID_TIME');
  rejects(input({incomingRevisions:[{...root(),occurredAt:'2026-10-19T00:00:00Z',recordedAt:'2026-10-19T00:01:00Z'}]}),'INVALID_TIME');
  rejects(input({incomingRevisions:[{...root(),recordedAt:'2026-10-19T00:00:00Z',answer:'Private frozen answer'}]}),'INVALID_INCOMING');
  rejects(input({incomingRevisions:[{...root(),occurredAt:'2026-10-18T00:04:00Z'}]}),'INVALID_INCOMING');
  rejects(input({exportedAt:'2026-10-18'}),'INVALID_INPUT');
});

test('merged order is deterministic by parent and pointer chain and all input objects remain unchanged',()=>{
  const parents=[parent('b-parent'),parent('a-parent')];
  const b=root('b-root','b-parent'),a=root('a-root','a-parent'),tail=action('withdraw','a-tail','a-root','a-parent');
  const events=[b,tail,a];const observationsBefore=structuredClone(parents),eventsBefore=structuredClone(events);
  Object.freeze(parents);for(const event of events)Object.freeze(event);Object.freeze(events);
  const occupied=new Set(['a-parent','b-parent']);
  const first=planObservationRevisionImport(input({observations:parents,incomingRevisions:events,occupiedEventIds:occupied}));
  const second=planObservationRevisionImport(input({observations:[...parents].reverse(),incomingRevisions:[...events].reverse(),occupiedEventIds:occupied}));
  assert.deepEqual(first,second);assert.deepEqual(first.mergedRevisions.map(event=>event.eventId),['a-root','a-tail','b-root']);
  assert.deepEqual(parents,observationsBefore);assert.deepEqual(events,eventsBefore);assert.deepEqual([...occupied],['a-parent','b-parent']);
  assert.notEqual(first.newRevisions[0],a);assert.ok(Object.isFrozen(first.newRevisions[0]));
  const empty=planObservationRevisionImport(input({currentObservations:[],observations:[],occupiedEventIds:new Set()}));
  assert.deepEqual(empty,{newRevisions:[],duplicateEventIds:[],mergedRevisions:[]});
});

test('incoming parents cannot repair an orphan current revision but new parents may bring their own new chains',()=>{
  rejects(input({currentObservations:[],observations:[parent()],currentRevisions:[root()]}),'INVALID_CHAIN');
  const newParent=planObservationRevisionImport(input({currentObservations:[],observations:[parent()],incomingRevisions:[root()]}));
  assert.deepEqual(newParent.newRevisions.map(event=>event.eventId),['z']);
  const successor=planObservationRevisionImport(input({currentObservations:[parent()],observations:[parent()],
    currentRevisions:[root()],incomingRevisions:[action('withdraw','a','z')]}));
  assert.deepEqual(successor.newRevisions.map(event=>event.eventId),['a']);
});
