import type { Concept } from '../../src/shared/types.js';
import type { ExportDataV3 } from '../../src/shared/answer-clearing-export.js';
import type { ImportOptions } from '../../src/shared/import-data.js';

export const now = '2026-01-10T00:00:00.000Z';
export const sourceId = 'target-source';
export const liveConcept: Concept = { id:'live-alpha',title:'Alpha',aliases:[],domain:'Math',summary:'summary',body:'body',source:{path:'Alpha.md',revision:'rev-1'} };
export const otherConcept: Concept = { ...liveConcept,id:'live-beta',title:'Beta',source:{path:'Beta.md',revision:'rev-beta'} };
export const concepts = [liveConcept,otherConcept];
export function clone<T>(value:T):T { return JSON.parse(JSON.stringify(value)) as T; }
export function fullExport(overrides:Partial<ExportDataV3>={}):ExportDataV3 {
  const endpoint = (concept:Concept) => ({conceptId:concept.id,sourceRevision:concept.source.revision,title:concept.title,path:concept.source.path});
  return {
    schemaVersion:3, exportedAt:'2026-01-09T00:00:00.000Z',
    source:{name:'backup',mode:'local',conceptCount:2,limit:20,diagnostics:[]},
    concepts:concepts.map(({id,title,source})=>({id,title,source:{...source}})),
    config:{modelVersion:'time-only-v0',halfLifeDays:7,revision:1},
    configHistory:[{modelVersion:'time-only-v0',halfLifeDays:7,revision:1}],
    anchors:[{eventId:'anchor-alpha',conceptId:liveConcept.id,sourceRevision:'rev-1',occurredAt:'2026-01-01T00:00:00.000Z',recordedAt:'2026-01-01T00:01:00.000Z',kind:'review'}],
    observations:[{eventId:'observation-alpha',conceptId:liveConcept.id,sourceRevision:'rev-1',observedAt:'2026-01-08T00:00:00.000Z',recordedAt:'2026-01-08T00:01:00.000Z',configRevision:1,halfLifeDays:7,anchorEventId:'anchor-alpha',elapsedDays:7,decay:0.5,answer:'private-answer-sentinel',evidenceMode:'written',rating:'partial',exposure:'unexposed',observedExposure:false,learning:{task:'concept',confidence:60,confidenceAt:'2026-01-07T23:59:00.000Z',cue:'independent',outcome:'partial',basis:'self-check'}}],
    observationRevisions:[{eventId:'revision-alpha',observationEventId:'observation-alpha',conceptId:liveConcept.id,sourceRevision:'rev-1',previousEventId:null,occurredAt:'2026-01-08T01:00:00.000Z',recordedAt:'2026-01-08T01:01:00.000Z',action:'withdraw',reason:'unreliable-evidence',note:'independent audit note'}],
    retentions:[{eventId:'retention-alpha',conceptId:liveConcept.id,sourceRevision:'rev-1',occurredAt:'2026-01-02T00:00:00.000Z',recordedAt:'2026-01-02T00:01:00.000Z',active:true,previousEventId:null}],
    applications:[{eventId:'application-alpha',conceptId:liveConcept.id,sourceRevision:'rev-1',occurredAt:'2026-01-03T00:00:00.000Z',recordedAt:'2026-01-03T00:01:00.000Z',kind:'application',context:'context',content:'content',outcome:'success',assistance:'independent',result:'result',limitations:'',insight:'insight',correction:'correction',references:'',relationSuggestion:{operation:'add',source:endpoint(liveConcept),target:endpoint(otherConcept),after:{type:'related',description:'relationship'}}}],
    corrections:[{eventId:'correction-alpha',applicationEventId:'application-alpha',conceptId:liveConcept.id,sourceRevision:'rev-1',occurredAt:'2026-01-04T00:00:00.000Z',recordedAt:'2026-01-04T00:01:00.000Z',previousEventId:null,status:'open',note:'separate correction'}],
    relationReviews:[{eventId:'relation-alpha',applicationEventId:'application-alpha',conceptId:liveConcept.id,occurredAt:'2026-01-04T01:00:00.000Z',recordedAt:'2026-01-04T01:01:00.000Z',previousEventId:null,status:'open',note:'separate relation',basis:{source:{conceptId:liveConcept.id,current:endpoint(liveConcept)},target:{conceptId:otherConcept.id,current:endpoint(otherConcept)},beforePresent:null,afterPresent:false}}],
    practice:{cards:[{eventId:'card-alpha',cardId:'card-id',previousEventId:null,occurredAt:'2026-01-05T00:00:00.000Z',recordedAt:'2026-01-05T00:01:00.000Z',kind:'detail',title:'Detail',prompt:'Question',referenceAnswer:'Reference',referenceNotes:'Notes',sources:[{conceptId:liveConcept.id,sourceRevision:'rev-1'}],sourceChecked:true,paused:false}],attempts:[{eventId:'attempt-alpha',cardId:'card-id',cardEventId:'card-alpha',answeredAt:'2026-01-06T00:00:00.000Z',recordedAt:'2026-01-06T00:01:00.000Z',answer:'separate practice answer',confidence:null,confidenceAt:null,exposure:'unexposed',observedExposure:false,cue:'independent',outcome:'success',checkNotes:''}]},
    identityBindings:[{operationId:'binding-alpha',rawConceptId:'raw-alpha',conceptId:liveConcept.id,fromPath:'Old.md',toPath:'Alpha.md',sourceRevision:'rev-1',confirmedAt:'2026-01-08T02:00:00.000Z',backupId:'backup-alpha'}],
    reviewPlan:{revision:1,dailyBudget:3,concepts:{[liveConcept.id]:{focus:true,deferUntil:null}}},
    layout:{[liveConcept.id]:{x:1,y:2,z:3}},
    restoreMetadata:{sourceId:'backup-source',anchorRequests:[{eventId:'anchor-alpha',conceptId:liveConcept.id,sourceRevision:'rev-1',kind:'review'}],configRecordedAt:{'1':'2025-12-31T00:00:00.000Z'}},
    ...overrides,
  };
}
export function emptyCurrent(overrides:Partial<ExportDataV3>={}):ExportDataV3 {
  return fullExport({anchors:[],observations:[],observationRevisions:[],retentions:[],applications:[],corrections:[],relationReviews:[],practice:{cards:[],attempts:[]},identityBindings:[],reviewPlan:{revision:0,dailyBudget:5,concepts:{}},layout:{},restoreMetadata:{sourceId,anchorRequests:[],configRecordedAt:{'1':'2025-12-31T00:00:00.000Z'}},...overrides});
}
export function clearedExport(overrides:Partial<ExportDataV3>={}):ExportDataV3 {
  const data=fullExport();
  data.observations=[{...data.observations[0],answer:null,answerClearing:{observationEventId:'observation-alpha',clearedAt:'2026-01-08T03:00:00.000Z'}}];
  return {...data,...overrides};
}
export function importInput(data:unknown=fullExport(),current=emptyCurrent(),options:ImportOptions={restoreLayout:true,restoreReviewPlan:true}) {
  return {data,current,options,concepts:clone(concepts),sourceId,now};
}
export function deepFreeze<T>(value:T):T {
  if(value && typeof value==='object') {for(const nested of Object.values(value)) deepFreeze(nested);Object.freeze(value);}
  return value;
}
