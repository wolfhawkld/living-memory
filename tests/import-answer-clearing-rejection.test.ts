import assert from 'node:assert/strict';
import test from 'node:test';
import { buildImportPlan } from '../src/server/import-plan.js';
import { StoreError } from '../src/server/store-error.js';
import { DEFAULT_IMPORT_OPTIONS } from '../src/shared/import-data.js';
import { concepts, emptyCurrent, fullExport, now, sourceId } from './helpers/answer-clearing-json-fixture.js';
import type { ExportDataV2, Observation } from '../src/shared/types.js';

function input(){
  const raw=fullExport();
  const data:ExportDataV2={...raw,schemaVersion:2,observations:raw.observations.map(event=>({...event,answer:event.answer as string}))};
  const current:ExportDataV2={...emptyCurrent(),schemaVersion:2,observations:[]};
  return{data,current,concepts,now,sourceId,options:DEFAULT_IMPORT_OPTIONS};
}

test('legacy learning JSON cannot silently discard an answerClearing property beside an intact answer',()=>{
  for(const version of [1,2] as const){
    for(const marker of [undefined,null,{},'SYNTHETIC_PRIVATE_MARKER',{observationEventId:'observation-alpha',clearedAt:'2026-01-08T03:00:00.000Z'}]){
      const args=input();
      const data:Record<string,unknown>={...args.data,schemaVersion:version,
        observations:args.data.observations.map(event=>({...event,answerClearing:marker}))};
      if(version===1)delete data.observationRevisions;
      assert.throws(()=>buildImportPlan({...args,data}),error=>{
        assert.ok(error instanceof StoreError);assert.equal(error.code,'INVALID_ANSWER_CLEARING');assert.equal(error.status,400);
        assert.doesNotMatch(error.message,/SYNTHETIC_PRIVATE_MARKER|private-answer-sentinel/);return true;
      });
    }
  }
});

test('unmarked v2 imports remain supported while the current import entry still rejects schema 3',()=>{
  const args=input();const before=JSON.stringify(args.data);
  assert.equal(buildImportPlan(args).preview.canImport,true);assert.equal(JSON.stringify(args.data),before);
  assert.equal((buildImportPlan(args).normalized.observations[0] as Observation).answer,'private-answer-sentinel');
  assert.throws(()=>buildImportPlan({...args,data:{...args.data,schemaVersion:3}}),{code:'UNSUPPORTED_SCHEMA'});
});
