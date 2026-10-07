import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '../src/server/accounts.js';
import { planFeishuCardView } from '../src/server/feishu-card-view.js';
import type { FeishuCardActionDefinition, FeishuCardDraftInput, FeishuBrowseView } from '../src/shared/feishu-cards.js';
import type { FeishuReadContext } from '../src/server/feishu-read-view.js';
import type { ReviewPlanResponse } from '../src/shared/review-plan.js';
import type { Concept } from '../src/shared/types.js';

const actor = { appId: 'app_synthetic', tenantKey: 'tenant_synthetic', openId: 'open_synthetic' };
const asOf = '2026-10-02T00:00:00.000Z';
const domain = '中'.repeat(384);
const query = '概'.repeat(120);
const concepts: Concept[] = Array.from({ length: 20 }, (_, index) => ({
  id: `synthetic-budget-${String(index).padStart(2,'0')}`, title: `知识 ${String(index).padStart(2,'0')}`,
  aliases: [query], domain: 'unused', summary: '', body: 'Synthetic body content. '.repeat(220),
  source: { path: `${domain}/concept-${index}.md`, revision: `synthetic-revision-${index}` },
}));
const context: FeishuReadContext = { concepts, states: {}, anchors: [], asOf };
const reviewPlan: ReviewPlanResponse = { sourceId:'synthetic', asOf, timeZone:'UTC', dayKey:'2026-10-02',
  plan:{ revision:1, dailyBudget:5, concepts:{} }, completedConceptIds:[] };

for (const envelope of [
  { name:'normal namespace/chat identifiers', namespace:`local-${'a'.repeat(64)}`, originChatId:`oc_${'b'.repeat(40)}` },
  { name:'maximum control-character namespace/chat identifiers', namespace:'\u0001'.repeat(256), originChatId:'\u0002'.repeat(256) },
]) {
  test(`renderer navigation drafts fit the Accounts metadata budget with ${envelope.name}`, async () => {
    const dataDir=mkdtempSync(join(tmpdir(),'lm-feishu-card-budget-'));
    const accounts=new Accounts({dataDir,now:()=>new Date(asOf)});
    try {
      const user=await accounts.setup('owner','synthetic-card-budget-password');
      const session=accounts.issueSession(user.id);
      const request=accounts.issueFeishuBindingRequest(user.id,session.sessionId,actor);
      assert.equal(accounts.confirmFeishuBinding({ ...actor,code:request.command.split(' ')[1],eventId:'synthetic-bind',
        messageId:'synthetic-bind-message',chatId:'synthetic-bind-chat' }).status,'confirmed');
      const auth={userId:user.id,accessRevision:user.accessRevision,bindingId:accounts.getFeishuBindingState(user.id).binding!.id};
      const persist=(view:FeishuBrowseView) => {
        const plan=planFeishuCardView(view,context,reviewPlan);
        const input:FeishuCardDraftInput={namespace:envelope.namespace,sourceFingerprint:'c'.repeat(64),
          originChatId:envelope.originChatId,view,actions:plan.actions};
        const metadataBytes=Buffer.byteLength(JSON.stringify(input),'utf8');
        assert.ok(metadataBytes<=16*1024,`complete metadata: ${metadataBytes} bytes`);
        const stored=accounts.createFeishuCardDraft(actor,auth,input);
        assert.ok(stored,`Accounts must accept a renderer plan: ${metadataBytes} bytes`);
        const card=plan.build(stored.id);
        const buttons=(card.body as {elements:{tag:string}[]}).elements.filter(element=>element.tag==='button');
        assert.ok(buttons.length>0,'normal navigation must not collapse into an error/empty card');
        assert.equal(buttons.length,plan.actions.length);
        assert.ok(Buffer.byteLength(JSON.stringify(card))<=20*1024);
        assert.deepEqual(stored.actions,plan.actions);
        assert.deepEqual(stored.view,view);
        accounts.discardFeishuCard(stored.id,actor,auth);
        return plan;
      };
      let view:FeishuBrowseView={kind:'list',domainId:domain,query,sort:'title',page:1};
      const references=new Set<string>();
      let pages=0;
      while(view.kind==='list') {
        assert.ok(++pages<=20,'list traversal must terminate');
        const current:Extract<FeishuBrowseView,{kind:'list'}>=view;
        const rendered=persist(current);
        const reads=rendered.actions.filter(action=>action.target.kind==='read');
        assert.ok(reads.length>0,'every collection page must retain accessible concepts');
        for(const action of reads) {
          if(action.target.kind!=='read')continue;
          assert.deepEqual(action.target.back,current);
          references.add(action.target.reference);
          let read:FeishuBrowseView=action.target;
          let bodyPages=0;
          while(read.kind==='read') {
            assert.ok(++bodyPages<=10,'body traversal must terminate');
            const body=persist(read);
            const back=body.actions.find(action=>action.target.kind==='list');
            assert.ok(back);
            assert.deepEqual(back.target,current);
            persist(back.target);
            const next=body.actions.find(action=>action.target.kind==='read'&&action.target.page===(read as {page:number}).page+1);
            if(!next)break;
            read=next.target as FeishuBrowseView;
          }
          assert.ok(bodyPages>1,'read next/back must be exercised, not just a one-page body');
        }
        const next:FeishuCardActionDefinition|undefined=rendered.actions.find(action=>action.target.kind==='list'&&action.target.sort==='title'
          &&action.target.domainId===domain&&action.target.query===query&&action.target.page===current.page+1);
        if(!next)break;
        view=next.target as FeishuBrowseView;
      }
      assert.ok(pages>2,'exercise full metadata at several intermediate pages');
      assert.equal(references.size,concepts.length,'all matching concepts remain reachable');
    } finally {accounts.close();rmSync(dataDir,{recursive:true,force:true});}
  });
}
