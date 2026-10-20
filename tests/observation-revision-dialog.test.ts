import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Observation } from '../src/shared/types';
import type { ObservationRevisionHistory } from '../src/shared/observation-revision-history';
import { ObservationRevisionDialog, RevisionJudgmentFields, revisionPendingRelation, revisionPersistenceAfterResult, freezeRevisionDraft, initialRevisionDraft, revisionDraftDisabledReason } from '../src/web/ObservationRevisionDialog';
import { createObservationRevisionHistoryLoader } from '../src/web/observation-revision-history-loader';
const parent: Observation = { eventId: 'saved-parent', conceptId: 'archived-concept', sourceRevision: 'old-version', observedAt: '2026-10-01T00:00:00.000Z',
  recordedAt: '2026-10-01T01:00:00.000Z', configRevision: 1, halfLifeDays: 7, anchorEventId: null, elapsedDays: null, decay: null,
  answer: 'PRIVATE_ORIGINAL_ANSWER', rating: 'clear', exposure: 'unexposed', observedExposure: false,
  learning: { task: 'scenario', scenario: 'PRIVATE_SCENARIO', applicability: 'PRIVATE_SUPPLEMENT', confidence: 70, confidenceAt: '2026-09-30T23:59:00.000Z',
    cue: 'independent', outcome: 'success', basis: 'self-check' } };
function history(fields: Partial<ObservationRevisionHistory> = {}): ObservationRevisionHistory {
  return { observation: structuredClone(parent), state: { status: 'active', currentAssessment: { rating: 'clear', learning: { outcome: 'success', basis: 'self-check' } }, latestRevisionEventId: null, appliedRevisionCount: 0 },
    events: [], total: 0, observationRevisionCount: 0, nextCursor: null, ...fields };
}
const now = '2026-10-02T00:00:00.000Z';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
test('dialog initially omits original answer, scenario and supplement; mental keeps calibration boundary', () => {
  const props = { scopeKey: 'owner-source-instance', observation: parent, disabledReason: null, loadHistory: async () => history(),
    onSubmit: async () => ({ status: 'context-changed' as const }), onRetryPending: async () => ({ status: 'context-changed' as const }),
    onRecheckRejected: async () => false, onRevealAnswer() {}, onClose() {} };
  const html = renderToStaticMarkup(createElement(ObservationRevisionDialog, props));
  for (const secret of [parent.answer, parent.learning!.scenario!, parent.learning!.applicability!]) assert.ok(!html.includes(secret));
  assert.match(html, /原始判断/); assert.match(html, /当前采用/); assert.match(html, /本次判断/); assert.match(html, /展开原始回答/);
  const mental = renderToStaticMarkup(createElement(ObservationRevisionDialog, { ...props, observation: { ...parent, evidenceMode: 'mental' } }));
  assert.match(mental, /仍不计入独立成功或信心校准/); assert.doesNotMatch(mental, /展开原始回答/);
});
test('only an explicit changed assessment and reason can freeze; timestamps, predecessor and note stay exact', () => {
  const h = history(); const draft = initialRevisionDraft(h); draft.reason = 'input-error';
  assert.match(revisionDraftDisabledReason(parent, h, draft, now)!, /相同/);
  draft.assessment.rating = 'partial'; draft.note = '  原始说明\n';
  const request = freezeRevisionDraft(parent, h, draft, 'revision-1', now);
  assert.equal(request.eventId, 'revision-1'); assert.equal(request.previousEventId, null); assert.equal(request.occurredAt, now);
  assert.equal(request.note, draft.note); assert.equal(request.observationEventId, parent.eventId);
  assert.equal(Object.hasOwn(request, 'answer'), false); assert.equal(Object.hasOwn(request, 'sourceRevision'), false);
  draft.note = 'x'.repeat(1001); assert.match(revisionDraftDisabledReason(parent,h,draft,now)!, /1000/);
  draft.note = ''; draft.reason = ''; assert.match(revisionDraftDisabledReason(parent,h,draft,now)!, /原因/);
});
test('withdraw and reinstate are constrained by adopted state and never send assessment', () => {
  const h = history(); const draft = initialRevisionDraft(h); draft.reason = 'unreliable-evidence'; draft.action = 'withdraw';
  assert.equal(revisionDraftDisabledReason(parent,h,draft,now), null);
  assert.equal(Object.hasOwn(freezeRevisionDraft(parent,h,draft,'withdraw-1',now),'assessment'),false);
  draft.action = 'reinstate'; assert.match(revisionDraftDisabledReason(parent,h,draft,now)!, /状态已变化/);
  h.state.status = 'withdrawn'; assert.equal(revisionDraftDisabledReason(parent,h,draft,now),null);
  draft.action = 'revise'; assert.match(revisionDraftDisabledReason(parent,h,draft,now)!, /状态已变化/);
});
test('clock earlier than original or latest decision is blocked without synthesizing future time', () => {
  const h=history(); const draft=initialRevisionDraft(h); draft.reason='other'; draft.action='withdraw';
  assert.match(revisionDraftDisabledReason(parent,h,draft,'2026-09-30T00:00:00Z')!, /本机时间/);
  h.state.latestRevisionEventId='tail'; h.events=[{ eventId:'tail',observationEventId:parent.eventId, previousEventId:null,
    action:'revise',assessment:h.state.currentAssessment,reason:'other',occurredAt:'2026-10-03T00:00:00Z',recordedAt:'2026-10-03T00:00:00Z',conceptId:parent.conceptId,sourceRevision:parent.sourceRevision }];
  assert.match(revisionDraftDisabledReason(parent,h,draft,now)!, /本机时间/);
});
test('legacy assessment preserves null learning and never manufactures original conditions', () => {
  const old={...parent}; delete old.learning;
  const h=history({observation:old}); h.state.currentAssessment={rating:'clear',learning:null};
  const draft=initialRevisionDraft(h); draft.reason='other'; draft.assessment.rating='blank';
  draft.assessment.learning={outcome:'failure',basis:'self-check'};
  assert.match(revisionDraftDisabledReason(old,h,draft,now)!, /字段结构/); draft.assessment.learning=null;
  const request=freezeRevisionDraft(old,h,draft,'legacy-revision',now);
  assert.equal(request.action,'revise'); if(request.action==='revise') assert.equal(request.assessment.learning,null);
});
test('loader refuses wrong parent and unavailable state instead of adopting original rating',async()=>{
  for(const field of ['eventId','conceptId','sourceRevision'] as const){
    const h=history(); h.observation[field]='wrong'; const loader=createObservationRevisionHistoryLoader(parent,async()=>h);
    assert.equal(await loader.refresh(),null); assert.equal(loader.getSnapshot().history,null); assert.match(loader.getSnapshot().error!,/不匹配/); loader.dispose();
  }
  const loader=createObservationRevisionHistoryLoader(parent,async()=>{throw new Error('503 unavailable');});
  await loader.refresh(); assert.equal(loader.getSnapshot().history,null); assert.match(loader.getSnapshot().error!,/503/);
});
test('late responses after dispose or superseding refresh cannot install metadata',async()=>{
  const late=deferred<ObservationRevisionHistory>(); let calls=0;
  const loader=createObservationRevisionHistoryLoader(parent,async()=>++calls===1?late.promise:history({total:2}));
  const first=loader.refresh(); await loader.refresh(); late.resolve(history({total:99})); await first;
  assert.equal(loader.getSnapshot().history!.total,2);
  const later=deferred<ObservationRevisionHistory>(); const closed=createObservationRevisionHistoryLoader(parent,()=>later.promise);
  const loading=closed.refresh(); closed.dispose(); later.resolve(history()); assert.equal(await loading,null); assert.equal(closed.getSnapshot().history,null);
});
test('pagination uses twenty per page, caps at 100 and restarts after changed tail or HISTORY_CHANGED',async()=>{
  let calls=0; const options: unknown[]=[];
  const loader=createObservationRevisionHistoryLoader(parent,async opts=>{options.push(opts); calls++;return history({ total: calls===1?5:6,nextCursor:calls<3?'next':null });});
  await loader.refresh(); await loader.loadMore(); assert.equal(calls,3); assert.equal(loader.getSnapshot().history!.total,6);
  assert.equal((options[0] as {limit:number}).limit,20); assert.equal((options[1] as {cursor:string}).cursor,'next'); assert.equal((options[2] as {cursor?:string}).cursor,undefined);
  let n=0; const changed=createObservationRevisionHistoryLoader(parent,async()=>{if(++n===2)throw Object.assign(new Error('changed'),{code:'OBSERVATION_REVISION_HISTORY_CHANGED'});return history({nextCursor:'next'});});
  await changed.refresh(); await changed.loadMore(); assert.equal(n,3); assert.equal(changed.getSnapshot().error,null);
  const hundred=history({events:Array.from({length:100},(_,i)=>({eventId:`e-${i}`,observationEventId:parent.eventId,conceptId:parent.conceptId,sourceRevision:parent.sourceRevision, previousEventId:null,action:'withdraw' as const,reason:'other' as const,occurredAt:now,recordedAt:now})),nextCursor:'next'});
  let fetches=0;const capped=createObservationRevisionHistoryLoader(parent,async()=>{fetches++;return hundred;}); await capped.refresh();await capped.loadMore();assert.equal(fetches,1);
});

test('a same-total changed tail restarts audit paging without retaining the old page', async () => {
  let calls=0;
  const loader=createObservationRevisionHistoryLoader(parent,async()=>{
    const h=history({total:2,nextCursor:calls++===0?'next':null});
    h.state.latestRevisionEventId=calls===1?'old-tail':'new-tail'; return h;
  });
  await loader.refresh();await loader.loadMore();assert.equal(calls,3);
  assert.equal(loader.getSnapshot().history!.state.latestRevisionEventId,'new-tail');
});

test('malformed responses cannot provide a writable state, and StrictMode cleanup can safely reactivate',async()=>{
  for(const fields of [{state:null},{events:[{}]},{nextCursor:4},{state:{...history().state,currentAssessment:{rating:'unknown',learning:null}}}]){
    const loader=createObservationRevisionHistoryLoader(parent,async()=>({...history(),...fields} as unknown as ObservationRevisionHistory));
    assert.equal(await loader.refresh(),null); assert.equal(loader.getSnapshot().history,null);assert.ok(loader.getSnapshot().error);
  }
  const late=deferred<ObservationRevisionHistory>();let calls=0;
  const loader=createObservationRevisionHistoryLoader(parent,async()=>++calls===1?late.promise:history({total:4}));
  const old=loader.refresh();loader.dispose();loader.activate();await loader.refresh();late.resolve(history({total:9}));await old;
  assert.equal(loader.getSnapshot().history!.total,4);
});

test('changing unverified outcome before its basis is a blocked intermediate draft, never a render exception',()=>{
  const h=history();h.state.currentAssessment={rating:'partial',learning:{outcome:'unverified',basis:'unknown'}};
  const draft=initialRevisionDraft(h);draft.reason='rechecked-original';draft.assessment.learning!.outcome='success';
  assert.doesNotThrow(()=>revisionDraftDisabledReason(parent,h,draft,now));
  assert.match(revisionDraftDisabledReason(parent,h,draft,now)!, /核对依据/);
  draft.assessment.learning!.basis='self-check';assert.equal(revisionDraftDisabledReason(parent,h,draft,now),null);
  assert.equal(freezeRevisionDraft(parent,h,draft,'intermediate-safe',now).action,'revise');
});

test('form labels name each control precisely without including option text',()=>{
  const html=renderToStaticMarkup(createElement(RevisionJudgmentFields,{draft:initialRevisionDraft(history()),status:'active',disabled:false,idPrefix:'stable',onEdit(){}}));
  for(const [field,label] of [['action','操作'],['rating','自评'],['outcome','核对结果'],['basis','核对依据']]){
    assert.ok(html.includes(`<label for="stable-${field}">${label}</label><select id="stable-${field}"`));
  }
  const dialog=renderToStaticMarkup(createElement(ObservationRevisionDialog,{scopeKey:'scope',observation:parent,disabledReason:null,loadHistory:async()=>history(),
    onSubmit:async()=>({status:'context-changed' as const}),onRetryPending:async()=>({status:'context-changed' as const}),onRecheckRejected:async()=>false,onRevealAnswer(){},onClose(){}}));
  for(const [field,label,tag] of [['reason','决定原因','select'],['note','说明（可选，最多 1000 字符）','textarea']]){
    const match=dialog.match(new RegExp(`<label for="([^"]+-${field})">${label.replace(/[（）]/g,'\\$&')}</label><${tag} id="([^"]+)"`));
    assert.ok(match,field);assert.equal(match[1],match[2]);
  }
});

test('an external tab pending row never adopts or permanently locks this drafts request',()=>{
  const h=history();const draft=initialRevisionDraft(h);draft.reason='other';draft.assessment.rating='blank';
  const own=freezeRevisionDraft(parent,h,draft,'own-event',now);const other={...own,eventId:'external-event'};
  const snapshot=JSON.stringify(draft);
  assert.equal(revisionPendingRelation(null,{request:other,queuedAt:now,state:'pending'}),'foreign');
  assert.equal(revisionPendingRelation(own,{request:other,queuedAt:now,state:'pending'}),'foreign');
  assert.equal(revisionPendingRelation(own,null),'none');assert.equal(JSON.stringify(draft),snapshot);
  assert.equal(revisionPendingRelation(own,{request:structuredClone(own),queuedAt:now,state:'pending'}),'own');
  assert.equal(revisionPendingRelation(own,{request:{...own,note:'different'},queuedAt:now,state:'pending'}),'foreign');
  assert.equal(revisionPendingRelation(own,{request:own,queuedAt:now,state:'archived'}),'none');
});

test('unknown outcomes and unexpected failures retain original persistence facts and prohibit rebasing',()=>{
  const notSaved={status:'not-saved' as const,persisted:false as const,message:'unknown',outcomeUnknown:true as const};
  assert.deepEqual(revisionPersistenceAfterResult({durable:false,uncertain:false},notSaved),{durable:false,uncertain:true});
  assert.deepEqual(revisionPersistenceAfterResult({durable:true,uncertain:false},notSaved),{durable:true,uncertain:true});
  assert.deepEqual(revisionPersistenceAfterResult({durable:false,uncertain:false},'unexpected-error'),{durable:false,uncertain:true});
  assert.deepEqual(revisionPersistenceAfterResult({durable:false,uncertain:true},{status:'not-saved',persisted:false,message:'this retry made zero POST'}),{durable:false,uncertain:true});
  assert.deepEqual(revisionPersistenceAfterResult({durable:false,uncertain:false},{status:'not-saved',persisted:false,message:'first attempt made zero POST'}),{durable:false,uncertain:false});
  assert.deepEqual(revisionPersistenceAfterResult({durable:false,uncertain:true},{status:'confirmed',cleanupPending:true,receipt:{eventId:'same-original',status:'duplicate',recordedAt:now}}),{durable:true,uncertain:false});
  assert.deepEqual(revisionPersistenceAfterResult({durable:false,uncertain:true},{status:'context-changed'}),{durable:false,uncertain:true});
});
