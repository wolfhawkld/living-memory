import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli/index.js';
import { LEARNING_PROTOCOL_HEADER } from '../src/shared/learning-protocol.js';

const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const session=(version:unknown)=>({writeToken:'synthetic-cli-token',sourceId:'synthetic-cli-source',instanceId:'synthetic-cli-instance',learningProtocolVersion:version});
function fixture(){const stateDir=mkdtempSync(join(tmpdir(),'lm-cli-negotiated-protocol-'));return{stateDir,close:()=>rmSync(stateDir,{recursive:true,force:true})};}

test('CLI bootstraps without claiming a protocol and sends each confirmed server version on protected writes',async()=>{
  const f=fixture();
  try {
    for(const version of [2,3] as const){
      const calls:Array<{path:string;headers:Headers}>=[];
      const result=await runCli(['refresh'],{stateDir:f.stateDir,env:{},fetchImpl:async(input,init)=>{
        const path=new URL(String(input)).pathname;calls.push({path,headers:new Headers(init?.headers)});
        return response(path==='/api/session'?session(version):{status:'refreshed'});
      }});
      assert.equal((result as {command:string}).command,'refresh');
      assert.deepEqual(calls.map(call=>call.path),['/api/session','/api/refresh']);
      assert.equal(calls[0].headers.get(LEARNING_PROTOCOL_HEADER),null);
      assert.equal(calls[1].headers.get(LEARNING_PROTOCOL_HEADER),String(version));
      assert.deepEqual(readdirSync(f.stateDir),[]);
    }
  } finally {f.close();}
});

test('CLI refuses absent, unsupported and malformed session versions before protected requests or local receipts',async()=>{
  const f=fixture();
  try {
    for(const version of [undefined,null,0,1,4,'2','3',{},true]){
      const calls:string[]=[];
      await assert.rejects(runCli(['review','Alpha','--confirm','--event-id','protocol-test'],{stateDir:f.stateDir,env:{},fetchImpl:async(input,init)=>{
        calls.push(new URL(String(input)).pathname);
        assert.equal(new Headers(init?.headers).get(LEARNING_PROTOCOL_HEADER),null);
        return response(session(version));
      }}),{code:'LEARNING_PROTOCOL_REQUIRED'});
      assert.deepEqual(calls,['/api/session']);assert.deepEqual(readdirSync(f.stateDir),[]);
    }
  } finally {f.close();}
});

test('a protocol 426 never renews or automatically replays a CLI review and an explicit retry preserves its frozen request',async()=>{
  const f=fixture();
  const concept={id:'alpha',title:'Alpha',aliases:[],domain:'Math',summary:'summary',body:'body',source:{path:'Alpha.md',revision:'revision-1'}};
  const snapshot={concepts:[concept],links:[],states:{alpha:{conceptId:'alpha',status:'unknown',decay:null,elapsedDays:null,anchor:null,reason:null,asOf:'2026-01-03T00:00:00.000Z'}},asOf:'2026-01-03T00:00:00.000Z',config:{modelVersion:'time-only-v0',halfLifeDays:7,revision:1},observationsCount:0,
    source:{name:'synthetic',mode:'local',conceptCount:1,limit:20,diagnostics:[]}};
  const calls:Array<{path:string;headers:Headers;body:unknown}>=[];let rejectWrite=true;
  const runner={stateDir:f.stateDir,env:{},now:()=>new Date('2026-01-03T00:00:00.000Z'),fetchImpl:async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=new URL(String(input)).pathname;calls.push({path,headers:new Headers(init?.headers),body:init?.body?JSON.parse(String(init.body)):null});
    if(path==='/api/session')return response(session(3));
    if(path==='/api/snapshot')return response(snapshot);
    if(path==='/api/reviews')return rejectWrite?response({error:{code:'LEARNING_PROTOCOL_REQUIRED',message:'upgrade required'}},426):response({status:'duplicate',eventId:'protocol-review'});
    assert.fail(`Unexpected request ${path}`);
  }};
  try {
    await assert.rejects(runCli(['review','Alpha','--confirm','--event-id','protocol-review'],runner),{code:'LEARNING_PROTOCOL_REQUIRED'});
    assert.deepEqual(calls.map(call=>call.path),['/api/session','/api/snapshot','/api/reviews']);
    assert.equal(calls[0].headers.get(LEARNING_PROTOCOL_HEADER),null);
    assert.ok(calls.slice(1).every(call=>call.headers.get(LEARNING_PROTOCOL_HEADER)==='3'));
    const receipts=readdirSync(f.stateDir).filter(name=>name.endsWith('.json'));assert.equal(receipts.length,1);
    const before=JSON.parse(readFileSync(join(f.stateDir,receipts[0]),'utf8'));assert.equal(before.status,'pending');
    rejectWrite=false;
    const retried=await runCli(['retry','protocol-review'],runner) as {receipt:{status:string}};
    assert.equal(retried.receipt.status,'succeeded');
    assert.deepEqual(calls.map(call=>call.path),['/api/session','/api/snapshot','/api/reviews','/api/session','/api/reviews']);
    assert.deepEqual(calls[2].body,calls[4].body);assert.deepEqual(calls[2].body,before.request);
    assert.equal(calls[3].headers.get(LEARNING_PROTOCOL_HEADER),null);assert.equal(calls[4].headers.get(LEARNING_PROTOCOL_HEADER),'3');
  } finally {f.close();}
});
