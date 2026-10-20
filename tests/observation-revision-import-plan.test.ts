import assert from 'node:assert/strict';
import test from 'node:test';
import { buildImportPlan } from '../src/server/import-plan.js';
import { DEFAULT_IMPORT_OPTIONS, MAX_IMPORT_BYTES } from '../src/shared/import-data.js';
import type { Concept, ExportData, ExportDataV1, ExportDataV2, Observation } from '../src/shared/types.js';
import type { ObservationRevision } from '../src/shared/observation-revisions.js';

const live:Concept={id:'live',title:'Concept',aliases:[],domain:'Math',body:'body',summary:'summary',source:{path:'Math/A.md',revision:'revision'}};
function observation(conceptId='backup'):Observation {
  return {eventId:'parent',conceptId,sourceRevision:'revision',observedAt:'2026-01-02T00:00:00Z',recordedAt:'2026-01-02T00:01:00Z',
    configRevision:1,halfLifeDays:7,anchorEventId:null,elapsedDays:null,decay:null,answer:'private original answer',rating:'clear',exposure:'unknown',observedExposure:false};
}
function v1():ExportDataV1 {
  const config={modelVersion:'time-only-v0' as const,halfLifeDays:7,revision:1};
  return {schemaVersion:1,exportedAt:'2026-01-10T00:00:00Z',source:{name:'synthetic',mode:'local',conceptCount:1,limit:1,diagnostics:[]},
    concepts:[{id:'backup',title:live.title,source:live.source}],config,configHistory:[config],anchors:[],observations:[observation()],layout:{}};
}
function revision(eventId='z',previousEventId:string|null=null):ObservationRevision {
  return {eventId,observationEventId:'parent',previousEventId,conceptId:'backup',sourceRevision:'revision',occurredAt:'2026-01-03T00:00:00Z',
    recordedAt:'2026-01-03T00:01:00Z',action:'revise',reason:'input-error',assessment:{rating:'partial',learning:null}};
}
function withdraw(eventId='a',previousEventId='z'):ObservationRevision {
  const {assessment:_assessment,...base}=revision(eventId,previousEventId);return {...base,action:'withdraw'};
}
function v2(events:ObservationRevision[]=[]):ExportDataV2 { return {...v1(),schemaVersion:2,observationRevisions:events}; }
function current(events:ObservationRevision[]=[],parents:Observation[]=[]):ExportDataV2 {
  return {...v2(events),concepts:[{id:live.id,title:live.title,source:live.source}],observations:parents};
}
function plan(data:unknown,existing:ExportData=current()) {
  return buildImportPlan({data,current:existing,concepts:[live],sourceId:'namespace',now:'2026-01-12T00:00:00Z',options:DEFAULT_IMPORT_OPTIONS});
}
function blocked(data:unknown,existing:ExportData=current()) {
  const result=plan(data,existing);assert.equal(result.preview.canImport,false);
  assert.ok(result.preview.issues.some(issue=>issue.severity==='error'));return result;
}

test('v1 and v2 envelopes normalize to v2 while legacy count shape and raw observations remain compatible',()=>{
  const legacy=plan(v1());assert.equal(legacy.preview.canImport,true);
  assert.equal(legacy.normalized.schemaVersion,2);assert.deepEqual(legacy.normalized.observationRevisions,[]);
  assert.deepEqual(legacy.newObservationRevisions,[]);assert.equal(legacy.preview.counts.observationRevisions,undefined);
  const next=plan(v2());assert.equal(next.preview.canImport,true);assert.equal(next.preview.counts.observationRevisions,0);
  assert.deepEqual(next.preview.counts.added,{anchors:0,observations:1,retentions:0,applications:0,corrections:0});
  assert.equal(next.newObservations[0].answer,'private original answer');
});

test('v1 revision properties, missing v2 arrays and unknown versions are rejected before preview',()=>{
  for(const data of [{...v1(),observationRevisions:undefined},{...v1(),observationRevisions:[]},
    {...v1(),schemaVersion:2},{...v1(),schemaVersion:2,observationRevisions:undefined},
    {...v1(),schemaVersion:2,observationRevisions:null},{...v1(),schemaVersion:3}])assert.throws(()=>plan(data));
});

test('strict revision parsing precedes mapping and root-to-tail preparation preserves event, parent and predecessor IDs',()=>{
  const source=v2([withdraw(),revision()]);const before=structuredClone(source);
  const result=plan(source);assert.equal(result.preview.canImport,true);
  assert.deepEqual(result.newObservationRevisions.map(event=>event.eventId),['z','a']);assert.equal(result.preview.counts.observationRevisions,2);
  for(const event of result.newObservationRevisions){assert.equal(event.conceptId,live.id);assert.equal(event.observationEventId,'parent');}
  assert.equal(result.newObservationRevisions[1].previousEventId,'z');assert.equal(result.newObservationRevisions[0].recordedAt,'2026-01-03T00:01:00.000Z');
  assert.deepEqual(source,before);
  blocked(v2([{...revision(),answer:'private forbidden answer'} as unknown as ObservationRevision]));
  assert.ok(blocked(v2([{...revision(),note:undefined}])).preview.issues.some(issue=>issue.code==='OBSERVATION_REVISION_IMPORT_INVALID_INCOMING'));
});

test('a v1 merge preserves current chains and repeated v2 imports deduplicate complete receipts deterministically',()=>{
  const first=plan(v2([revision()]));
  const saved=current(first.newObservationRevisions,first.newObservations);
  const legacy=plan(v1(),saved);assert.equal(legacy.preview.canImport,true);assert.deepEqual(legacy.newObservationRevisions,[]);
  assert.deepEqual(legacy.normalized.observationRevisions,[]);
  const second=plan(v2([revision()]),saved),third=plan(v2([revision()]),saved);
  assert.equal(second.preview.canImport,true);assert.equal(second.preview.counts.observationRevisions,0);
  assert.equal(second.preview.counts.duplicates,2);assert.equal(second.preview.token,third.preview.token);
  const advanced=plan(v2([withdraw(),revision()]),saved);assert.equal(advanced.preview.canImport,true);
  assert.deepEqual(advanced.newObservationRevisions.map(event=>event.eventId),['a']);
  blocked(v2([{...revision(),recordedAt:'2026-01-03T00:02:00Z'}]),saved);
});

test('both directions of cross-kind ID collisions and bad parent chains block the entire preview',()=>{
  blocked(v2([revision('parent')]));
  const incoming=v2([revision()]);incoming.anchors=[{eventId:'z',conceptId:'backup',sourceRevision:'revision',kind:'review',occurredAt:'2026-01-01T00:00:00Z',recordedAt:'2026-01-01T00:00:00Z'}];
  blocked(incoming);
  const saved=current([{...revision(),conceptId:live.id}],[observation(live.id)]);
  const other=v1();other.observations=[];other.anchors=[{eventId:'z',conceptId:'backup',sourceRevision:'revision',kind:'review',occurredAt:'2026-01-01T00:00:00Z',recordedAt:'2026-01-01T00:00:00Z'}];
  blocked(other,saved);
  blocked(v2([{...revision(),observationEventId:'missing'}]));
  blocked(v2([revision(),revision('fork')]));
  blocked(v2([{...revision(),previousEventId:'missing'}]));
  blocked(v2([{...revision(),sourceRevision:'wrong'}]));
  // The new parent in this incoming export cannot repair an existing orphan.
  blocked(v2(),current([{...revision(),conceptId:live.id}],[]));
});

test('future or malformed revision records cannot disappear through projection and input notes never leak into issues',()=>{
  const future={...revision(),recordedAt:'2026-01-11T00:00:00Z',note:'private-note-sentinel'};
  const result=blocked(v2([future]));assert.ok(result.preview.issues.some(issue=>issue.code==='OBSERVATION_REVISION_IMPORT_INVALID_TIME'));
  assert.doesNotMatch(JSON.stringify(result.preview.issues),/private-note-sentinel|private original answer/);
  blocked(v2([{...revision(),occurredAt:'2026-01-04T00:00:00Z'}]));
});

test('preview tokens include current revision state and incoming full receipts with stable collection ordering',()=>{
  const parent=observation(live.id);const initial=current([], [parent]);
  const known={...revision(),conceptId:live.id};const newer={...withdraw(),conceptId:live.id};
  const a=plan(v1(),initial),b=plan(v1(),current([known],[parent])),c=plan(v1(),current([known,newer],[parent]));
  assert.notEqual(a.preview.token,b.preview.token);assert.notEqual(b.preview.token,c.preview.token);
  const same=plan(v1(),current([newer,known],[parent]));assert.equal(c.preview.token,same.preview.token);
  const incomingA=plan(v2([revision()])),incomingB=plan(v2([{...revision(),note:''}]));
  assert.notEqual(incomingA.preview.token,incomingB.preview.token);
  const late={...known,recordedAt:'2026-01-11T00:00:00Z'};
  const oldExport=plan(v1(),current([late],[parent]));assert.equal(oldExport.preview.canImport,true);
});

test('revision events count towards both event admission and the existing total JSON byte cap',()=>{
  const excessive=v2(Array.from({length:50000},()=>revision()));
  assert.throws(()=>plan(excessive),error=>{assert.equal((error as {code:string}).code,'IMPORT_LIMIT');return true;});
  const huge={...v2(),observationRevisions:[{...revision(),note:'x'.repeat(MAX_IMPORT_BYTES)}]};
  assert.throws(()=>plan(huge),error=>{assert.equal((error as {code:string}).code,'IMPORT_LIMIT');return true;});
});
