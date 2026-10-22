import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildImportPlan } from '../src/server/import-plan.js';
import { parseAnswerClearingExport,serializeAnswerClearingExport,buildAnswerClearingImportPlan,mergeAnswerClearingImport } from '../src/server/answer-clearing-import.js';
import { fullExport,emptyCurrent,clearedExport,importInput,clone,deepFreeze,now,liveConcept } from './helpers/answer-clearing-json-fixture.js';

const parse=(data:unknown)=>parseAnswerClearingExport(data,{now});
const rejects=(fn:()=>unknown)=>assert.throws(fn);

test('JSON v3 parses all nonempty collections and roundtrips cleared answer without losing unrelated text',()=>{
  for(const data of [fullExport(),clearedExport()]) {
    const before=clone(data);deepFreeze(data);
    const parsed=parse(data);
    assert.equal(parsed.schemaVersion,3);
    assert.equal(parsed.observations.length,1);
    for(const key of ['anchors','observationRevisions','retentions','applications','corrections','relationReviews','identityBindings'] as const) assert.equal(parsed[key]?.length,1,key);
    assert.equal(parsed.practice?.cards.length,1);assert.equal(parsed.practice?.attempts.length,1);
    const serialized=serializeAnswerClearingExport(parsed,{now});
    assert.deepEqual(parse(JSON.parse(serialized)),parsed);
    assert.equal(serialized.includes('separate practice answer'),true);
    assert.deepEqual(data,before);
    if(data.observations[0].answer===null)assert.equal(serialized.includes('private-answer-sentinel'),false);
  }
});

test('JSON v3 refuses malformed or time-inconsistent clearing representations',()=>{
  const changes:Array<(data:ReturnType<typeof fullExport>)=>void>=[
    data=>{data.observations[0].answer=null;},
    data=>{(data.observations[0] as unknown as Record<string,unknown>).answerClearing={observationEventId:'observation-alpha',clearedAt:'2026-01-08T03:00:00.000Z'};},
    data=>{const row=clearedExport().observations[0];if(row.answer===null)row.answerClearing.observationEventId='wrong';data.observations=[row];},
    data=>{const row=clearedExport().observations[0];if(row.answer===null)row.answerClearing.clearedAt='2026-01-08T00:00:00.000Z';data.observations=[row];},
    data=>{const row=clearedExport().observations[0];if(row.answer===null)row.answerClearing.clearedAt='2026-01-09T00:00:01.000Z';data.observations=[row];},
    data=>{const row=clearedExport().observations[0];row.evidenceMode='mental';data.observations=[row];},
    data=>{const row=clearedExport().observations[0];if(row.answer===null)(row.answerClearing as unknown as Record<string,unknown>).answerHash='forbidden';data.observations=[row];},
    data=>{data.observations[0].halfLifeDays=8;},
    data=>{data.observations[0].decay=0.75;},
  ];
  for(const mutate of changes){const data=fullExport();mutate(data);rejects(()=>parse(data));}
  rejects(()=>parse({...fullExport(),schemaVersion:2}));
  rejects(()=>parse({...fullExport(),exportedAt:'2026-01-11T00:00:00.000Z'}));
});

test('legacy v1 and v2 import normalize into v3 while legacy markers are prohibited',()=>{
  for(const schemaVersion of [1,2]) {
    const data:Record<string,unknown>=clone(fullExport());data.schemaVersion=schemaVersion;
    if(schemaVersion===1)delete data.observationRevisions;
    const prepared=buildAnswerClearingImportPlan(importInput(data));
    assert.equal(prepared.preview.canImport,true,JSON.stringify(prepared.preview.issues));
    assert.equal(prepared.normalized.schemaVersion,3);
    assert.equal(prepared.newObservations[0].answer,'private-answer-sentinel');
    data.observations=clearedExport().observations;
    rejects(()=>buildAnswerClearingImportPlan(importInput(data)));
  }
});

test('local clearing blocks incoming intact answers including empty answer without disclosing raw text',()=>{
  for(const answer of ['private-answer-sentinel','']) {
    const incoming=fullExport();incoming.observations[0].answer=answer;
    for(const execute of [()=>buildAnswerClearingImportPlan(importInput(incoming,clearedExport())),()=>mergeAnswerClearingImport(importInput(incoming,clearedExport()),'untrusted-token')]) {
      assert.throws(execute,(error:unknown)=>{
        assert.equal((error as {code:string}).code,'ANSWER_CLEARED');
        assert.equal(String(error),'AnswerClearingImportError: ANSWER_CLEARED');
        assert.equal(JSON.stringify(error).includes('private-answer-sentinel'),false);
        return true;
      });
    }
  }
});

test('import cannot clear an existing original, and only identical clearing marker and non-answer payload duplicate',()=>{
  assert.throws(()=>buildAnswerClearingImportPlan(importInput(clearedExport(),fullExport())),{code:'LOCAL_CLEARING_REQUIRED'});
  const current=clearedExport();const incoming=clearedExport();
  incoming.observations[0].recordedAt='2026-01-08T00:02:00.000Z';
  const duplicate=buildAnswerClearingImportPlan(importInput(incoming,current));
  assert.equal(duplicate.preview.canImport,true,JSON.stringify(duplicate.preview.issues));
  assert.equal(duplicate.newObservations.length,0);
  const merged=mergeAnswerClearingImport(importInput(incoming,current),duplicate.preview.token);
  assert.deepEqual(merged.observations,current.observations);
  const markerChanged=clearedExport();const row=markerChanged.observations[0];
  if(row.answer===null)row.answerClearing.clearedAt='2026-01-08T04:00:00.000Z';
  assert.throws(()=>buildAnswerClearingImportPlan(importInput(markerChanged,current)),{code:'CLEARING_CONFLICT'});
  const ratingChanged=clearedExport();ratingChanged.observations[0].rating='clear';
  assert.throws(()=>buildAnswerClearingImportPlan(importInput(ratingChanged,current)),{code:'CLEARING_CONFLICT'});
});

test('fresh cleared record is admitted but a broken current chain cannot be repaired through incoming data',()=>{
  const input=importInput(clearedExport());const prepared=buildAnswerClearingImportPlan(input);
  assert.equal(prepared.preview.canImport,true,JSON.stringify(prepared.preview.issues));
  assert.equal(prepared.newObservations[0].answer,null);
  const broken=emptyCurrent({observationRevisions:fullExport().observationRevisions});
  rejects(()=>buildAnswerClearingImportPlan(importInput(fullExport(),broken)));
});

test('global event IDs remain occupied across all collections and assessment revisions',()=>{
  const base=fullExport();
  const collections=[base.anchors,base.observations,base.retentions!,base.applications!,base.corrections!,base.relationReviews!,base.practice!.cards,base.practice!.attempts,base.observationRevisions];
  for(const collection of collections) {
    const incoming=fullExport();incoming.observations[0].eventId=collection[0].eventId;
    if(collection===base.observations)continue;
    // Referencing revision follows the renamed observation so the failure is an occupied global ID.
    incoming.observationRevisions[0].observationEventId=incoming.observations[0].eventId;
    rejects(()=>parse(incoming));
  }
});

test('merge recomputes from original input, preserves local audit and source bindings, and appends new collections',()=>{
  const current=emptyCurrent();
  current.identityBindings=fullExport().identityBindings;
  const input=importInput(clearedExport(),current);deepFreeze(input);const before=clone(input);
  const prepared=buildAnswerClearingImportPlan(input);
  assert.equal(prepared.preview.canImport,true,JSON.stringify(prepared.preview.issues));
  const untrusted={...input,prepared:{newObservations:[]}};
  const merged=mergeAnswerClearingImport(untrusted,prepared.preview.token);
  assert.equal(merged.observations.length,1);assert.equal(merged.observations[0].answer,null);
  assert.equal(merged.observationRevisions.length,1);assert.equal(merged.practice?.attempts.length,1);
  assert.deepEqual(merged.identityBindings,current.identityBindings);
  assert.equal(merged.restoreMetadata?.configRecordedAt['1'],current.restoreMetadata?.configRecordedAt['1']);
  assert.equal(Object.hasOwn(merged.restoreMetadata!.anchorRequests[0],'occurredAt'),false);
  assert.deepEqual(input,before);
  const disabled=importInput(fullExport(),emptyCurrent(),{restoreLayout:false,restoreReviewPlan:false});
  const disabledPlan=buildAnswerClearingImportPlan(disabled);
  const noLayout=mergeAnswerClearingImport(disabled,disabledPlan.preview.token);
  assert.deepEqual(clone(noLayout.layout),clone(disabled.current.layout));assert.deepEqual(clone(noLayout.reviewPlan),clone(disabled.current.reviewPlan));
  assert.deepEqual(clone(merged.layout),clone(prepared.mergedLayout));assert.deepEqual(clone(merged.reviewPlan),clone(prepared.mergedReviewPlan));
});

test('preview token covers current privacy, decisions, graph, options, source, and accepted paths; stale merge is refused',()=>{
  const input=importInput(fullExport());const token=buildAnswerClearingImportPlan(input).preview.token;
  const mutations:Array<(value:typeof input & {acceptedPaths?:Record<string,string[]>})=>void>=[
    value=>{value.current=fullExport();},
    value=>{value.concepts[0].source.revision='changed-revision';},
    value=>{value.options.restoreLayout=false;},
    value=>{value.sourceId='different-source';},
    value=>{value.acceptedPaths={[liveConcept.id]:['old/Alpha.md']};},
  ];
  for(const mutate of mutations) {
    const changed:typeof input & {acceptedPaths?:Record<string,string[]>}=clone(input);mutate(changed);
    assert.notEqual(buildAnswerClearingImportPlan(changed).preview.token,token);
    rejects(()=>mergeAnswerClearingImport(changed,token));
  }
  const full=importInput(fullExport(),fullExport());
  const stable=buildAnswerClearingImportPlan(full).preview.token;
  const reordered=clone(full);reordered.concepts.reverse();
  reordered.current.concepts.reverse();(reordered.data as ReturnType<typeof fullExport>).concepts.reverse();
  assert.equal(buildAnswerClearingImportPlan(reordered).preview.token,stable);
});

test('a cleared observation without any anchor keeps frozen null time conditions',()=>{
  const data=clearedExport();data.anchors=[];data.restoreMetadata!.anchorRequests=[];
  Object.assign(data.observations[0],{anchorEventId:null,elapsedDays:null,decay:null});
  const parsed=parse(data);
  assert.equal(parsed.observations[0].anchorEventId,null);
  assert.equal(parsed.observations[0].elapsedDays,null);
  assert.equal(parsed.observations[0].decay,null);
  const prepared=buildAnswerClearingImportPlan(importInput(data));
  assert.equal(prepared.preview.canImport,true,JSON.stringify(prepared.preview.issues));
  assert.equal(prepared.newObservations[0].halfLifeDays,7);
});

test('changes to current first clearing marker and revision payload invalidate preview, not only observation counts',()=>{
  const input=importInput(clearedExport(),clearedExport());
  const token=buildAnswerClearingImportPlan(input).preview.token;
  const changed=clone(input);const row=changed.current.observations[0];
  if(row.answer===null)row.answerClearing.clearedAt='2026-01-08T04:00:00.000Z';
  const incoming=(changed.data as ReturnType<typeof fullExport>).observations[0];
  if(incoming.answer===null)incoming.answerClearing.clearedAt='2026-01-08T04:00:00.000Z';
  assert.notEqual(buildAnswerClearingImportPlan(changed).preview.token,token);
  assert.throws(()=>mergeAnswerClearingImport(changed,token),{code:'IMPORT_STALE'});
  const revision=clone(input);revision.current.observationRevisions[0].note='changed audit';
  assert.notEqual(buildAnswerClearingImportPlan(revision).preview.token,token);
  assert.throws(()=>mergeAnswerClearingImport(revision,token),{code:'IMPORT_STALE'});
});

test('legal event, metadata, and object-key ordering does not alter preview token',()=>{
  const data=fullExport();
  const original=data.observations[0];
  data.observations.push({...original,eventId:'observation-beta',observedAt:'2026-01-08T00:00:01.000Z',recordedAt:'2026-01-08T00:01:01.000Z',elapsedDays:7+1/86400,decay:Math.pow(0.5,(7+1/86400)/7)});
  data.retentions!.push({...data.retentions![0],eventId:'retention-beta',previousEventId:'retention-alpha',active:false,occurredAt:'2026-01-02T01:00:00.000Z',recordedAt:'2026-01-02T01:01:00.000Z'});
  const input=importInput(data);const before=buildAnswerClearingImportPlan(input);
  assert.equal(before.preview.canImport,true,JSON.stringify(before.preview.issues));
  const reordered=clone(input);const backup=reordered.data as ReturnType<typeof fullExport>;
  backup.observations.reverse();backup.retentions!.reverse();backup.concepts.reverse();reordered.concepts.reverse();
  backup.source={diagnostics:[],limit:20,conceptCount:2,mode:'local',name:'backup'};
  assert.equal(buildAnswerClearingImportPlan(reordered).preview.token,before.preview.token);
});

test('incoming observation cannot reuse IDs already occupied by any current event kind',()=>{
  const current=fullExport();
  const occupied=[...current.anchors,...current.observations,...current.retentions!,...current.applications!,...current.corrections!,...current.relationReviews!,...current.practice!.cards,...current.practice!.attempts,...current.observationRevisions];
  for(const row of occupied) {
    const incoming=emptyCurrent();
    incoming.observations=[{...fullExport().observations[0],eventId:row.eventId,anchorEventId:null,elapsedDays:null,decay:null}];
    const prepared=buildAnswerClearingImportPlan(importInput(incoming,current));
    assert.equal(prepared.preview.canImport,false,row.eventId);
    assert.equal(prepared.newObservations.length,0,row.eventId);
  }
});


test('unknown observation payload/hash fields are rejected or sanitized and never serialized',()=>{
  for(const key of ['answerHash','request_payload']) {
    const data=clearedExport();(data.observations[0] as unknown as Record<string,unknown>)[key]='unknown-secret-sentinel';
    let parsed:ReturnType<typeof parse>;
    try {parsed=parse(data);} catch(error) {
      assert.equal(String(error).includes('unknown-secret-sentinel'),false);continue;
    }
    const serialized=serializeAnswerClearingExport(parsed,{now});
    assert.equal(serialized.includes(key),false);assert.equal(serialized.includes('unknown-secret-sentinel'),false);
  }
});

test('current privacy state changes the preview token even when incoming has no observations',()=>{
  const input=importInput(emptyCurrent(),fullExport());
  const token=buildAnswerClearingImportPlan(input).preview.token;
  const changed={...input,current:clearedExport()};
  assert.notEqual(buildAnswerClearingImportPlan(changed).preview.token,token);
  assert.throws(()=>mergeAnswerClearingImport(changed,token),{code:'IMPORT_STALE'});
});


test('JSON codec never invokes getters or toJSON and rejects cycles and nonfinite values',()=>{
  let calls=0;
  const getter=fullExport();Object.defineProperty(getter.source,'name',{enumerable:true,get(){calls++;return 'secret-getter';}});
  assert.throws(()=>parse(getter),{code:'INVALID_IMPORT_DATA'});
  const conversion=fullExport();Object.defineProperty(conversion,'toJSON',{enumerable:true,value:()=>{calls++;return fullExport();}});
  assert.throws(()=>parse(conversion),{code:'INVALID_IMPORT_DATA'});
  const cycle=fullExport();(cycle.source as unknown as Record<string,unknown>).cycle=cycle;
  assert.throws(()=>parse(cycle),{code:'INVALID_IMPORT_DATA'});
  for(const value of [NaN,Infinity,-Infinity]) {
    const invalid=fullExport();invalid.layout['live-alpha'].x=value;
    assert.throws(()=>parse(invalid),{code:'INVALID_IMPORT_DATA'});
  }
  const undefinedMarker=clearedExport();const cleared=undefinedMarker.observations[0];
  if(cleared.answer===null)Object.defineProperty(cleared.answerClearing,'answerHash',{value:undefined,enumerable:true});
  assert.throws(()=>parse(undefinedMarker),{code:'INVALID_IMPORT_DATA'});
  assert.equal(calls,0);
});

test('unknown source, identity, and observation fields cannot leak from normalized exports',()=>{
  for(const target of ['source','identity','observation']) {
    const data=clearedExport();
    const item=target==='source'?data.source:target==='identity'?data.identityBindings![0]:data.observations[0];
    (item as unknown as Record<string,unknown>).unknownPrivateValue='unknown-private-sentinel';
    let normalized:ReturnType<typeof parse>;
    try {normalized=parse(data);}catch(error){assert.equal(String(error).includes('unknown-private-sentinel'),false);continue;}
    const serialized=serializeAnswerClearingExport(normalized,{now});
    assert.equal(serialized.includes('unknownPrivateValue'),false,target);
    assert.equal(serialized.includes('unknown-private-sentinel'),false,target);
  }
});

test('nonempty merge appends a new config, anchor and observation without rewriting existing receipts',()=>{
  const current=fullExport();
  const incoming=fullExport();
  incoming.config={modelVersion:'time-only-v0',revision:2,halfLifeDays:10};
  incoming.configHistory.push({...incoming.config});
  incoming.restoreMetadata!.configRecordedAt['2']='2026-01-08T04:00:00.000Z';
  const anchor={...incoming.anchors[0],eventId:'anchor-new',occurredAt:'2026-01-08T05:00:00.000Z',recordedAt:'2026-01-08T05:01:00.000Z'};
  incoming.anchors.push(anchor);
  incoming.restoreMetadata!.anchorRequests.push({eventId:anchor.eventId,conceptId:anchor.conceptId,sourceRevision:anchor.sourceRevision,kind:anchor.kind,occurredAt:anchor.occurredAt});
  incoming.observations.push({...incoming.observations[0],eventId:'observation-new',observedAt:'2026-01-08T06:00:00.000Z',recordedAt:'2026-01-08T06:01:00.000Z',configRevision:2,halfLifeDays:10,anchorEventId:anchor.eventId,elapsedDays:1/24,decay:Math.pow(0.5,(1/24)/10)});
  const input=importInput(incoming,current);const before=clone(input);deepFreeze(input);
  const prepared=buildAnswerClearingImportPlan(input);
  assert.equal(prepared.preview.canImport,true,JSON.stringify(prepared.preview.issues));
  const merged=mergeAnswerClearingImport(input,prepared.preview.token);
  assert.deepEqual(merged.configHistory,[...current.configHistory,incoming.config]);
  assert.equal(merged.restoreMetadata!.configRecordedAt['1'],current.restoreMetadata!.configRecordedAt['1']);
  assert.equal(merged.restoreMetadata!.configRecordedAt['2'],incoming.restoreMetadata!.configRecordedAt['2']);
  assert.deepEqual(merged.anchors.slice(0,current.anchors.length),current.anchors);
  assert.deepEqual(merged.observations.slice(0,current.observations.length),current.observations);
  assert.equal(Object.hasOwn(merged.restoreMetadata!.anchorRequests[0],'occurredAt'),false);
  assert.deepEqual(merged.restoreMetadata!.anchorRequests[1],incoming.restoreMetadata!.anchorRequests[1]);
  assert.deepEqual(input,before);
});

test('existing v2 product import planner still rejects actual JSON v3',()=>{
  const input=importInput(fullExport());
  assert.throws(()=>buildImportPlan({...input,current:{...input.current,schemaVersion:2,observations:[]}}));
});


test('privacy preflight cannot be bypassed by earlier same-ID observation or different event kind',()=>{
  const cleared=clearedExport().observations[0];
  const intact=fullExport().observations[0];
  const cases=[
    {current:clearedExport(),incoming:clearedExport({observations:[clone(cleared),clone(intact)]}),code:'ANSWER_CLEARED'},
    {current:clearedExport(),incoming:fullExport({anchors:[...fullExport().anchors,{...fullExport().anchors[0],eventId:intact.eventId}],observations:[clone(intact)]}),code:'ANSWER_CLEARED'},
    {current:fullExport(),incoming:fullExport({observations:[clone(intact),clone(cleared)]}),code:'LOCAL_CLEARING_REQUIRED'},
  ];
  for(const entry of cases) {
    const input=importInput(entry.incoming,entry.current);
    for(const run of [()=>buildAnswerClearingImportPlan(input),()=>mergeAnswerClearingImport(input,'untrusted-token')]) {
      assert.throws(run,(error:unknown)=>{
        assert.equal((error as {code:string}).code,entry.code);
        assert.equal(String(error).includes('private-answer-sentinel'),false);
        assert.equal(JSON.stringify(error).includes('private-answer-sentinel'),false);
        return true;
      });
    }
  }
});
