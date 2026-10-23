import assert from 'node:assert/strict';
import test from 'node:test';
import { api, configureSessionScope } from '../src/web/api.js';
import { LEARNING_PROTOCOL_HEADER, type LearningProtocolVersion } from '../src/shared/learning-protocol.js';
import { clearedExport, clone, sourceId } from './helpers/answer-clearing-json-fixture.js';

const exported=clearedExport();
const observation=exported.observations[0];
const conceptId=observation.conceptId;
const json=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
function session(version:LearningProtocolVersion,key:string){return{writeToken:`privacy-api-${key}-token`,sourceId,instanceId:`privacy-api-${key}-instance`,learningProtocolVersion:version};}
function histories(parent:unknown=observation){
  return{
    concept:{sourceId,conceptId,sourceRevision:'rev-1',asOf:'2026-01-10T00:00:00.000Z',
      state:{conceptId,status:'unknown',decay:null,elapsedDays:null,anchor:null,reason:null,asOf:'2026-01-10T00:00:00.000Z'},
      entries:[{type:'observation',event:parent}],total:1,nextCursor:null,observationRevisionCount:0,
      observationAssessmentVersion:'a'.repeat(64),observationPrivacy:{cleared:1,excludedFromPerformance:1}},
    revisions:{observation:parent,state:{status:'active',currentAssessment:{rating:'partial',learning:{outcome:'partial',basis:'self-check'}},latestRevisionEventId:null,appliedRevisionCount:0},
      events:[],total:0,observationRevisionCount:0,nextCursor:null},
  };
}

test('confirmed protocol 3 API readers retain a cleared answer and its marker in concept and revision histories',async()=>{
  const original=globalThis.fetch,scope=session(3,'read'),data=histories();const calls:Array<{path:string;headers:Headers}>=[];
  try {
    configureSessionScope(scope);
    globalThis.fetch=async(input,init)=>{const path=String(input);calls.push({path,headers:new Headers(init?.headers)});
      if(path==='/api/session')return json(scope);
      return json(path.includes('/concepts/')?data.concept:data.revisions);
    };
    await api.getSession();
    const concept=await api.getConceptHistory(conceptId,sourceId);
    const revisions=await api.getObservationRevisions(observation.eventId,sourceId);
    const entry=concept.entries[0];assert.equal(entry.type,'observation');
    if(entry.type==='observation'){
      assert.equal(entry.event.answer,null);assert.deepEqual(entry.event,observation);
      if(entry.event.answer===null)assert.deepEqual(entry.event.answerClearing,{observationEventId:observation.eventId,clearedAt:'2026-01-08T03:00:00.000Z'});
    }
    assert.equal(revisions.observation.answer,null);assert.deepEqual(revisions.observation,observation);
    assert.deepEqual(concept.observationPrivacy,{cleared:1,excludedFromPerformance:1});
    assert.equal(calls[0].headers.get(LEARNING_PROTOCOL_HEADER),null);
    assert.ok(calls.slice(1).every(call=>call.headers.get(LEARNING_PROTOCOL_HEADER)==='3'));
  } finally {globalThis.fetch=original;configureSessionScope(null);}
});

test('protocol 3 API export blobs and import preview requests preserve schema and null markers without rewriting JSON',async()=>{
  const original=globalThis.fetch,scope=session(3,'transfer');const calls:Array<{path:string;headers:Headers;body:unknown}>=[];
  const options={restoreLayout:false,restoreReviewPlan:true};
  try {
    configureSessionScope(scope);
    globalThis.fetch=async(input,init)=>{const path=String(input);calls.push({path,headers:new Headers(init?.headers),body:init?.body?JSON.parse(String(init.body)):null});
      if(path==='/api/session')return json(scope);
      if(path==='/api/export')return json(exported);
      assert.equal(path,'/api/import/preview');return json({sourceId,canImport:true,token:'synthetic-preview'});
    };
    await api.getSession();
    const blob=await api.exportData(scope.writeToken,sourceId);
    assert.ok(blob instanceof Blob);assert.deepEqual(JSON.parse(await blob.text()),exported);
    const preview=await api.previewImport({data:exported,options},scope.writeToken,sourceId);
    assert.equal(preview.canImport,true);
    const sent=calls.find(call=>call.path==='/api/import/preview')!;
    assert.deepEqual(sent.body,{data:exported,options});
    const body=sent.body as {data:{schemaVersion:number;observations:Array<{answer:unknown;answerClearing:unknown}>}};
    assert.equal(body.data.schemaVersion,3);assert.equal(body.data.observations[0].answer,null);
    assert.deepEqual(body.data.observations[0].answerClearing,observation.answer===null?observation.answerClearing:undefined);
    assert.ok(calls.filter(call=>call.path!=='/api/session').every(call=>call.headers.get(LEARNING_PROTOCOL_HEADER)==='3'));
  } finally {globalThis.fetch=original;configureSessionScope(null);}
});

test('confirmed protocol 2 API histories reject the same marker-bearing records instead of silently treating them as old observations',async()=>{
  const original=globalThis.fetch,scope=session(2,'legacy'),data=histories();const calls:Array<{path:string;headers:Headers}>=[];
  try {
    configureSessionScope(scope);
    globalThis.fetch=async(input,init)=>{const path=String(input);calls.push({path,headers:new Headers(init?.headers)});
      if(path==='/api/session')return json(scope);return json(path.includes('/concepts/')?data.concept:data.revisions);
    };
    await api.getSession();
    await assert.rejects(api.getConceptHistory(conceptId,sourceId),{code:'LEARNING_PRIVACY_RESPONSE_INVALID'});
    await assert.rejects(api.getObservationRevisions(observation.eventId,sourceId),{code:'LEARNING_PRIVACY_RESPONSE_INVALID'});
    assert.equal(calls.filter(call=>call.path==='/api/session').length,1,'malformed privacy responses do not renew sessions');
    assert.ok(calls.slice(1).every(call=>call.headers.get(LEARNING_PROTOCOL_HEADER)==='2'));
  } finally {globalThis.fetch=original;configureSessionScope(null);}
});

test('protocol 3 API histories fail closed for missing, inconsistent or foreign clearing markers',async()=>{
  const original=globalThis.fetch;
  const base=clone(observation) as unknown as Record<string,unknown>;
  const missing={...base};delete missing.answerClearing;
  const malformed=[missing,{...base,answer:'SYNTHETIC_ANSWER_MUST_NOT_LEAK'},
    {...base,answerClearing:{observationEventId:'other-parent',clearedAt:'2026-01-08T03:00:00.000Z'}},
    {...base,answerClearing:{observationEventId:observation.eventId,clearedAt:'invalid'}}];
  try {
    for(let index=0;index<malformed.length;index++){
      const scope=session(3,`invalid-${index}`),data=histories(malformed[index]);configureSessionScope(scope);
      globalThis.fetch=async input=>String(input)==='/api/session'?json(scope):json(String(input).includes('/concepts/')?data.concept:data.revisions);
      await api.getSession();
      for(const pending of [api.getConceptHistory(conceptId,sourceId),api.getObservationRevisions(observation.eventId,sourceId)]){
        await assert.rejects(pending,error=>{assert.equal((error as {code:string}).code,'LEARNING_PRIVACY_RESPONSE_INVALID');
          assert.doesNotMatch(String(error),/SYNTHETIC_ANSWER_MUST_NOT_LEAK|private-answer-sentinel/);return true;});
      }
    }
  } finally {globalThis.fetch=original;configureSessionScope(null);}
});
