import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { MemoryLockManager } from './helpers/memory-lock-manager';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

class StorageMemory {
  values = new Map<string, string>();
  getItem(key:string) { return this.values.get(key) ?? null; }
  setItem(key:string,value:string) { this.values.set(key,value); }
  removeItem(key:string) { this.values.delete(key); }
}
const pending = (id:string) => ({ id, method:'PUT' as const,path:'/config',payload:{revision:1},eventId:null,conceptId:null,label:'config' });
const old = {learningProtocolVersion:2,writeToken:'old',sourceId:'same'};
const fresh = {learningProtocolVersion:2,writeToken:'new',sourceId:'same',instanceId:'restored'};
const ok = () => new Response(JSON.stringify({status:'accepted'}));
async function setup(name:string) {
  const mod:typeof import('../src/web/api') = await import(new URL(`../src/web/api.ts?instance=${name}`,import.meta.url).href);
  const storage = new StorageMemory();
  const host = new EventTarget();
  Object.assign(host,{localStorage:storage,navigator:{locks:new MemoryLockManager()}});
  Object.defineProperty(globalThis,'window',{value:host,configurable:true});
  return {mod,storage};
}

async function confirmProtocol(mod: typeof import('../src/web/api'), session: typeof old & { instanceId?: string }) {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json(session);
    await mod.api.getSession();
  } finally { globalThis.fetch = original; }
}

test('legacy bytes preserved and restored instance has separate queue and headers', async () => {
  const {mod,storage} = await setup('separate');
  mod.configureSessionScope(old);
  await confirmProtocol(mod,old);
  await mod.queuePendingWrite('same',pending('legacy'));
  const legacyKey='living-memory.pending-writes.v1.same';
  const bytes=storage.getItem(legacyKey);
  assert.ok(bytes);
  mod.configureSessionScope(fresh);
  await confirmProtocol(mod,fresh);
  assert.deepEqual(mod.getPendingWrites('same'),[]);
  let sends=0;
  globalThis.fetch=async (_url,init) => { sends++;assert.equal((init?.headers as Record<string,string>)['x-lm-instance-id'],'restored');return ok(); };
  assert.equal((await mod.flushPendingWrites('new','same')).sent,0);
  await mod.queuePendingWrite('same',pending('fresh'));
  assert.equal((await mod.flushPendingWrites('new','same')).sent,1);
  assert.equal(sends,1);
  assert.equal(storage.getItem(legacyKey),bytes);
});

test('midflight restored scope preserves old queue and new queue without stale error annotation', async () => {
  const {mod,storage}=await setup('flight');
  mod.configureSessionScope(old);
  await confirmProtocol(mod,old);
  await mod.queuePendingWrite('same',pending('old'));
  const bytes=storage.getItem('living-memory.pending-writes.v1.same');
  let release!:(response:Response)=>void;
  let started!:()=>void;
  const ready=new Promise<void>(resolve=>{started=resolve;});
  globalThis.fetch=async()=>{started();return new Promise<Response>(resolve=>{release=resolve;});};
  const flushing=mod.flushPendingWrites('old','same');
  await ready;
  mod.configureSessionScope(fresh);
  await confirmProtocol(mod,fresh);
  await mod.queuePendingWrite('same',pending('new'));
  release(new Response(JSON.stringify({error:{code:'TOKEN_REQUIRED'}}),{status:401}));
  // A late recovery response is not allowed to reactivate an old instance.
  globalThis.fetch=async()=>new Response(JSON.stringify(fresh));
  await flushing;
  assert.equal(storage.getItem('living-memory.pending-writes.v1.same'),bytes);
  assert.equal(mod.getPendingWrites('same')[0]?.id,'new');
});

test('old token retains original instance despite newer GET and direct mismatch never retries', async () => {
  const {mod}=await setup('tokens');
  let session=old as typeof fresh;
  globalThis.fetch=async()=>new Response(JSON.stringify(session));
  await mod.api.getSession();
  session=fresh;
  await mod.api.getSession();
  mod.configureSessionScope(fresh);
  await confirmProtocol(mod,fresh);
  let writes=0;
  globalThis.fetch=async()=>{writes++;return ok();};
  await assert.rejects(mod.writeJson('/config',{},'old','same'),{code:'INSTANCE_MISMATCH'});
  assert.equal(writes,0);
  globalThis.fetch=async()=>{writes++;return new Response(JSON.stringify({error:{code:'INSTANCE_MISMATCH'}}),{status:409});};
  await assert.rejects(mod.writeJson('/config',{},'new','same'),{code:'INSTANCE_MISMATCH'});
  assert.equal(writes,1);
});

test('logout blocks writes and queue capture until explicit new scope configuration', async () => {
  const {mod}=await setup('logout');
  mod.configureSessionScope(old);
  await confirmProtocol(mod,old);
  mod.configureSessionScope(null);
  assert.equal(await mod.queuePendingWrite('same',pending('late')),null);
  let sends=0;
  globalThis.fetch=async()=>{sends++;return ok();};
  await assert.rejects(mod.writeJson('/config',{},'old','same'),{code:'INSTANCE_MISMATCH'});
  assert.equal(sends,0);
});

test('old token 401 cannot retry against restored instance of same source', async () => {
  const {mod}=await setup('recovery');
  mod.configureSessionScope(old);
  await confirmProtocol(mod,old);
  let writes=0; let sessions=0;
  globalThis.fetch=async url=>{
    if (String(url).endsWith('/session')) { sessions++;return new Response(JSON.stringify(fresh)); }
    writes++;return new Response(JSON.stringify({error:{code:'TOKEN_REQUIRED'}}),{status:401});
  };
  const events:string[]=[];
  const unsubscribe=mod.subscribeToSessionRecovery(event=>events.push(event.kind));
  await assert.rejects(mod.writeJson('/config',{},'old','same'),{code:'INSTANCE_MISMATCH'});
  unsubscribe();
  assert.equal(writes,1); assert.equal(sessions,1);
  assert.ok(events.includes('instance-mismatch'));
  // Merely getting a newer session did not change the active legacy queue.
  await mod.queuePendingWrite('same',pending('still-original'));
  assert.equal(mod.getPendingWrites('same')[0]?.id,'still-original');
});

test('successful old ack cannot clean either queue after scope changes', async () => {
  const {mod,storage}=await setup('ack');
  mod.configureSessionScope(old);
  await confirmProtocol(mod,old);
  await mod.queuePendingWrite('same',pending('old'));
  const original=storage.getItem('living-memory.pending-writes.v1.same');
  let release!:(response:Response)=>void; let started!:()=>void;
  const ready=new Promise<void>(resolve=>{started=resolve;});
  globalThis.fetch=async()=>{started();return new Promise<Response>(resolve=>{release=resolve;});};
  const flushing=mod.flushPendingWrites('old','same');
  await ready;
  mod.configureSessionScope(fresh);
  await confirmProtocol(mod,fresh);
  await mod.queuePendingWrite('same',pending('new'));
  const restored=storage.getItem('living-memory.pending-writes.v1.same:instance:restored');
  release(ok());
  await flushing;
  assert.equal(storage.getItem('living-memory.pending-writes.v1.same'),original);
  assert.equal(storage.getItem('living-memory.pending-writes.v1.same:instance:restored'),restored);
});

test('same instance rotation updates credentials once without interrupting batch', async () => {
  const {mod}=await setup('rotation');
  const first={...fresh,writeToken:'first'};
  const rotated={...fresh,writeToken:'second'};
  mod.configureSessionScope(first);
  await confirmProtocol(mod,first);
  await mod.queuePendingWrite('same',pending('rotate'));
  const tokens:string[]=[];
  globalThis.fetch=async(url,init)=>{
    if (String(url).endsWith('/session')) return new Response(JSON.stringify(rotated));
    const headers=init!.headers as Record<string,string>;
    tokens.push(headers['x-lm-token']);
    assert.equal(headers['x-lm-instance-id'],'restored');
    return tokens.length===1 ? new Response(JSON.stringify({error:{code:'TOKEN_REQUIRED'}}),{status:401}) : ok();
  };
  assert.equal((await mod.flushPendingWrites('first','same')).sent,1);
  assert.deepEqual(tokens,['first','second']);
  assert.deepEqual(mod.getPendingWrites('same'),[]);
});

test('a token cannot be rebound to another instance by a late GET', async () => {
  const {mod}=await setup('binding');
  mod.configureSessionScope(old);
  await confirmProtocol(mod,old);
  globalThis.fetch=async()=>new Response(JSON.stringify({...fresh,writeToken:'old'}));
  await assert.rejects(mod.api.getSession(),{code:'INSTANCE_MISMATCH'});
});

test('late same-instance recovery cannot notify after leaving and returning to scope', async () => {
  const {mod}=await setup('late-generation');
  mod.configureSessionScope(fresh);
  await confirmProtocol(mod,fresh);
  let release!:(response:Response)=>void; let started!:()=>void;
  const ready=new Promise<void>(resolve=>{started=resolve;});
  let writes=0;
  globalThis.fetch=async url=>{
    if (String(url).endsWith('/session')) { started();return new Promise<Response>(resolve=>{release=resolve;}); }
    writes++;return new Response(JSON.stringify({error:{code:'TOKEN_REQUIRED'}}),{status:401});
  };
  const events:string[]=[];
  mod.subscribeToSessionRecovery(event=>events.push(event.kind));
  const sending=mod.writeJson('/config',{},'new','same');
  const rejection=assert.rejects(sending,{code:'INSTANCE_MISMATCH'});
  await ready;
  mod.configureSessionScope(null);
  mod.configureSessionScope(fresh);
  await confirmProtocol(mod,fresh);
  release(new Response(JSON.stringify({...fresh,writeToken:'rotated'})));
  await rejection;
  assert.equal(writes,1);
  assert.ok(!events.includes('recovered'));
});
