import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '../../src/server/accounts.js';
import { Store } from '../../src/server/store.js';
import { loadKnowledgeGraph } from '../../src/server/kg.js';
import { resolveSourceIdentity } from '../../src/server/source-identities.js';
import { feishuReviewEventId, withFeishuReviewFrozen } from '../../src/shared/feishu-review.js';
import type { FeishuReviewMutation, FeishuReviewState } from '../../src/shared/feishu-review.js';
export const instant = '2026-10-16T08:00:00.000Z';
export const now = () => new Date(instant);
export const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export function tableRows(path:string) {
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>[
      String(row.name), db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"','""')}"`).all()
        .map(value=>JSON.parse(JSON.stringify(value))).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ]));
  } finally { db.close(); }
}
export function treeHashes(root:string,skip=new Set<string>()):Record<string,string> {
  const result:Record<string,string>={};
  const visit=(dir:string,prefix:string)=>{
    for(const entry of readdirSync(dir,{withFileTypes:true})) {
      const name=prefix ? `${prefix}/${entry.name}`:entry.name;
      if(skip.has(name)) continue;
      if(entry.isDirectory()) visit(join(dir,entry.name),name);
      else result[name]=digest(readFileSync(join(dir,entry.name)));
    }
  }; visit(root,'');return result;
}
export async function instanceFixture() {
  const base=mkdtempSync(join(tmpdir(),'lm-instance-backup-'));
  const dataDir=join(base,'original-data'),kgRoot=join(base,'external-owner-kg'),cliStateDir=join(base,'external-cli'),procRoot=join(base,'empty-proc');
  for(const dir of [dataDir,kgRoot,cliStateDir,procRoot]) mkdirSync(dir,{recursive:true,mode:0o700});
  const envFile=join(base,'synthetic.env'),cliSessionFile=join(base,'device-session.json');
  writeFileSync(envFile,'LM_FEISHU_ENABLED=1\nLM_FEISHU_APP_SECRET=synthetic-never-execute\n',{mode:0o600});
  writeFileSync(cliSessionFile,JSON.stringify({version:1,baseUrl:'http://synthetic.invalid',sessionToken:'synthetic-device-secret',expiresAt:'2027-01-01T00:00:00Z'}),{mode:0o600});
  writeFileSync(join(cliStateDir,'learning-receipts.json'),'[{"eventId":"legacy-learning"}]');
  writeFileSync(join(cliStateDir,'activity-pending.json'),'[{"epoch":0,"eventId":"old-instance-only"}]');
  writeFileSync(join(cliStateDir,'hook-marker.json'),'{"lastIngest":"synthetic-ingest"}');
  writeFileSync(join(dataDir,'unknown-private.bin'),'must-report-exclusion');
  const accounts=new Accounts({dataDir,now});
  const owner=await accounts.setup('synthetic-owner','synthetic-owner-password');
  const member=await accounts.createUser('synthetic-member','synthetic-member-password');
  const ownerSession=accounts.issueSession(owner.id),memberSession=accounts.issueSession(member.id);
  const actor={appId:'cli_1234567890abcdef',tenantKey:'synthetic-tenant',openId:'synthetic-owner'};
  const issued=accounts.issueFeishuBindingRequest(owner.id,ownerSession.sessionId,actor);
  assert.equal(accounts.confirmFeishuBinding({...actor,code:issued.command.split(' ')[1],eventId:'bind',messageId:'bind',chatId:'private'}).status,'confirmed');
  accounts.issueFeishuBindingRequest(member.id,memberSession.sessionId,actor);
  const auth={userId:owner.id,accessRevision:owner.accessRevision,bindingId:accounts.getFeishuBindingState(owner.id).binding!.id};
  const memberRoot=join(dataDir,'users',member.id,'knowledge');
  mkdirSync(memberRoot,{recursive:true});
  const sources=[kgRoot,memberRoot].map((root,index)=>{
    mkdirSync(join(root,'Math'),{recursive:true});
    writeFileSync(join(root,'Math','Alpha.md'),`---\ntype: concept\ntitle: ${index ? 'Member':'Owner'} Alpha\n---\n# Alpha\nSynthetic ${index} ![attachment](../image.bin)\n`);
    writeFileSync(join(root,'Root.md'),'---\ntype: concept\ntitle: Root concept\n---\n# Root\nRoot-domain fallback\n');
    writeFileSync(join(root,'image.bin'),Buffer.from([0,1,2,3,255,index]));
    const identity=resolveSourceIdentity(dataDir,root);
    const source=loadKnowledgeGraph({root,identityHash:identity.identityHash,displayName:identity.displayName});
    const raw=source.index.concepts.find(concept=>concept.source.path==='Math/Alpha.md')!;assert.ok(raw);
    const stable={...raw,id:`stable-${index}`,source:{...raw.source,path:'Old/Alpha.md'}};
    const store=new Store({dataDir,namespace:source.namespace,now});
    store.rememberConcepts([stable,raw]);
    store.addReview({eventId:`anchor-${index}`,conceptId:stable.id,sourceRevision:stable.source.revision,kind:'review',occurredAt:instant});
    store.addObservation({eventId:`observation-${index}`,conceptId:stable.id,sourceRevision:stable.source.revision,observedAt:instant,configRevision:1,anchorEventId:`anchor-${index}`,answer:'synthetic answer',rating:'partial',exposure:'unknown',observedExposure:false},`anchor-${index}`);
    store.addRetention({eventId:`retention-${index}`,conceptId:stable.id,sourceRevision:stable.source.revision,occurredAt:instant,active:true,previousEventId:null},null);
    store.setLayout({[stable.id]:{x:index+1,y:2,z:3}});
    store.updateReviewPlan({revision:0,dailyBudget:0});
    const preview=store.previewIdentityLink({fromConceptId:stable.id,toConceptId:raw.id},source.index.source,[raw]);
    assert.equal(preview.canLink,true,JSON.stringify(preview.issues));
    store.commitIdentityLink({fromConceptId:stable.id,toConceptId:raw.id,operationId:`move-${index}`,previewToken:preview.token,confirmed:true},source.index.source,[raw],()=>`synthetic-backup-${index}`);
    const activity=store.activity;
    activity.updateSettings({enabled:false,expectedRevision:0});
    activity.updateSettings({enabled:true,expectedRevision:1});
    activity.append({principalId:index ? member.id:owner.id,sessionKind:'accounts',deliveryChannel:'web',allowedOriginChannels:['web'],inspectReference:()=>({status:'current'})},
      {epoch:1,event:{schemaVersion:1,eventId:`query-${index}`,operationId:`operation-${index}`,stepKey:'query',occurredAt:instant,actor:{kind:'user'},channel:'web',kind:'query.submitted',refs:[],payload:{resultCount:0,queryText:'explicit synthetic query',queryTextSavedByUser:true}},delivery:{deliveryId:`delivery-${index}`,channel:'web'}});
    activity.clearOperation({operationId:`deleted-operation-${index}`,expectedEpoch:1});
    store.close();return {root,identity,source,raw,stable};
  });
  const scope={namespace:sources[0].source.namespace,sourceFingerprint:sources[0].identity.sourceRootFingerprint,originChatId:'private'};
  let message=0;
  const transition=(mutation:FeishuReviewMutation | null)=>
    accounts.claimFeishuReviewTransition(actor,auth,{kind:'message',message:{...actor,messageId:`m-${++message}`,eventId:`e-${message}`,chatId:'private',text:'知识 复习'}},scope,()=>mutation)!;
  const front:FeishuReviewState={domainId:'Math',conceptId:sources[0].stable.id,sourceRevision:sources[0].raw.source.revision,phase:'front',paused:false,page:1,frozen:null,
    batch:{requestedSize:3,cursor:0,items:[{id:'1'.repeat(32),conceptId:sources[0].stable.id,sourceRevision:sources[0].raw.source.revision,frozen:null,disposition:'open'},
      {id:'2'.repeat(32),conceptId:'another-synthetic-concept',sourceRevision:'another-revision',frozen:null,disposition:'open'}]}};
  let review=transition({kind:'create',id:'a'.repeat(32),state:front}).session!;
  const frozen={observedAt:instant,configRevision:1,halfLifeDays:7,anchorEventId:null};
  review=transition({kind:'update',state:{...withFeishuReviewFrozen(review.state,frozen),phase:'revealed'}}).session!;
  review=transition({kind:'update',state:review.state,intent:{kind:'observation',request:{eventId:feishuReviewEventId(review,'observation'),conceptId:front.conceptId,sourceRevision:front.sourceRevision,observedAt:instant,configRevision:1,anchorEventId:null,answer:'',evidenceMode:'mental',rating:'clear',exposure:'unknown',observedExposure:false,learning:{task:'concept',cue:'unknown',outcome:'unverified',basis:'self-check',confidence:null,confidenceAt:null}}}}).session!;
  review=accounts.settleFeishuReviewOperation(feishuReviewEventId(review,'observation'),actor,auth,{status:'applied'})!;
  assert.ok(review);
  review=transition({kind:'update',state:review.state,intent:{kind:'review',request:{eventId:feishuReviewEventId(review,'review'),conceptId:front.conceptId,sourceRevision:front.sourceRevision,kind:'review',occurredAt:instant}}}).session!;
  assert.ok(review);
  for(const active of [false,true]) {
    const card=accounts.createFeishuCardDraft(actor,auth,{...scope,view:{kind:'review',sessionId:review.id,version:review.version,verb:'show',page:1},actions:[{id:'a0',target:{kind:'review',sessionId:review.id,version:review.version,verb:'show',page:1}}]})!;
    assert.ok(card); if(active) assert.equal(accounts.activateFeishuCard(card.id,actor,auth,{messageId:`card-${card.id}`,chatId:'private'}),true);
  }
  assert.equal(accounts.claimFeishuRead('b'.repeat(32),actor,auth),true);
  accounts.close();
  const options={dataDir,kgRoot,cliStateDir,procRoot,envFile,cliSessionFile,output:join(base,'bundle'),now};
  return {base,options,owner,member,sources,review,actor,auth,cleanup:()=>rmSync(base,{recursive:true,force:true})};
}
