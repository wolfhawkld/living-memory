import { parseObservationRevisionRequest, observationRevisionRequestEqual, type ObservationRevisionRequest } from '../shared/observation-revisions.js';
import type { ObservationRevisionReceipt } from '../shared/observation-revision-history.js';
import { isValidInstant } from '../core/time-model.js';
import { withPendingStorageLock, withPendingSyncLock } from './pending-coordination.js';

export interface ObservationRevisionPendingScope { accountId: string; sourceId: string; instanceId: string }
export interface ObservationRevisionPendingContext extends ObservationRevisionPendingScope { authenticated: boolean; authRevision: number; mode: 'real' | 'example' | 'forecast'; locked: boolean }
export interface ObservationRevisionPendingRow { readonly request: ObservationRevisionRequest; readonly queuedAt: string; readonly state: 'pending' | 'rejected' | 'archived'; readonly lastError?: string }
export type ObservationRevisionPendingReason = 'inactive' | 'context-changed' | 'invalid-request' | 'conflict' | 'already-archived' | 'parent-pending' | 'full' | 'storage-unavailable' | 'storage-corrupt' | 'coordination-unavailable';
export type ObservationRevisionPendingSnapshot = { status: 'available'; rows: readonly ObservationRevisionPendingRow[] } | { status: 'unavailable'; reason: ObservationRevisionPendingReason };
export type ObservationRevisionPendingEnqueueResult = { status: 'queued' | 'already-queued'; eventId: string } | { status: 'not-saved'; reason: ObservationRevisionPendingReason };
export type ObservationRevisionPendingFlushItem = { eventId: string; status: 'confirmed'; receipt: ObservationRevisionReceipt; cleanup: 'removed' | 'retained' } | { eventId: string; status: 'pending' | 'rejected' | 'paused'; code: string };
export interface ObservationRevisionPendingFlushResult { status: 'done' | 'inactive' | 'busy' | 'context-changed' | 'unavailable'; items: ObservationRevisionPendingFlushItem[]; reason?: ObservationRevisionPendingReason }
export interface ObservationRevisionPendingOptions {
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  transport: { append(request: ObservationRevisionRequest, scope: ObservationRevisionPendingScope): Promise<ObservationRevisionReceipt> };
  now?: () => number;
  withStorageLock?: <T>(scope: string, action: () => T) => Promise<T>;
  withSyncLock?: <T>(scope: string, action: () => Promise<T>, busy: () => T) => Promise<T>;
}
export function observationRevisionPendingStorageKey(scope: ObservationRevisionPendingScope): string {
  return `living-memory.observation-revision-pending.v1.${encodeURIComponent(JSON.stringify([scope.accountId, scope.sourceId, scope.instanceId]))}`;
}
const rejectedStatuses: Record<string, number> = Object.fromEntries([
  ['PREVIOUS_EVENT_CONFLICT',409], ['EVENT_CONFLICT',409], ['INVALID_TRANSITION',409], ['UNCHANGED_ASSESSMENT',409], ['INVALID_TIME',400], ['INVALID_REQUEST',400], ['NOT_FOUND',404],
] .map(([code,status]) => [`OBSERVATION_REVISION_${code}`,Number(status)]));
const diagnosticCodes = new Set([...Object.keys(rejectedStatuses), 'REVISION_OUTCOME_UNKNOWN', 'REVISION_RECEIPT_INVALID', 'REVISION_AUTH_REQUIRED', 'REVISION_PROTOCOL_REQUIRED', 'SOURCE_MISMATCH', 'INSTANCE_MISMATCH']);
class QueueFailure { constructor(readonly reason: ObservationRevisionPendingReason) {} }
const bytes = (s: string) => new TextEncoder().encode(s).length;
const ownKeys = (x: object, allowed: string[]) => Object.keys(x).every(k => allowed.includes(k));
const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && [null,Object.prototype].includes(Object.getPrototypeOf(x));
function scopeOf(context: ObservationRevisionPendingContext): ObservationRevisionPendingScope { return Object.freeze({ accountId: context.accountId, sourceId: context.sourceId, instanceId: context.instanceId }); }
function rowEqual(a: ObservationRevisionPendingRow, b: ObservationRevisionPendingRow): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function parseRow(value: unknown): ObservationRevisionPendingRow {
  if (!plain(value) || !ownKeys(value,['request','queuedAt','state','lastError']) || typeof value.queuedAt !== 'string' || !isValidInstant(value.queuedAt) || !['pending','rejected','archived'].includes(String(value.state)) || ('lastError' in value && (typeof value.lastError !== 'string' || !diagnosticCodes.has(value.lastError)))) throw new QueueFailure('storage-corrupt');
  const deterministic = typeof value.lastError === 'string' && Object.hasOwn(rejectedStatuses, value.lastError);
  if (value.state === 'pending' ? deterministic : !deterministic) throw new QueueFailure('storage-corrupt');
  const request = parseObservationRevisionRequest(value.request);
  return Object.freeze({request,queuedAt:value.queuedAt,state:value.state as ObservationRevisionPendingRow['state'],...('lastError' in value ? {lastError:value.lastError as string} : {})});
}

/** Independent manual-only durable queue; never changes raw observations or learning pending writes. */
export function createObservationRevisionPending(options: ObservationRevisionPendingOptions) {
  const storageLock = options.withStorageLock ?? withPendingStorageLock;
  const syncLock = options.withSyncLock ?? withPendingSyncLock;
  let context: ObservationRevisionPendingContext | null = null;
  let generation = 0;
  function capture(write: boolean) {
    if (!context?.authenticated || (write && (context.mode !== 'real' || context.locked))) throw new QueueFailure('inactive');
    const scope = scopeOf(context), token = generation;
    return {scope, key:observationRevisionPendingStorageKey(scope), lock:`observation-revision:${observationRevisionPendingStorageKey(scope)}`, check() { if (generation !== token) throw new QueueFailure('context-changed'); }};
  }
  type Capture = ReturnType<typeof capture>;
  function read(c: Capture): ObservationRevisionPendingRow[] {
    c.check();
    let raw: string | null;
    try { raw=options.storage.getItem(c.key); } catch { throw new QueueFailure('storage-unavailable'); }
    if (raw === null) return [];
    try {
      if (bytes(raw)>512*1024) throw 0;
      const record: unknown=JSON.parse(raw);
      if (!plain(record) || !ownKeys(record,['version','scope','rows']) || record.version!==1 || !plain(record.scope) || !ownKeys(record.scope,['accountId','sourceId','instanceId']) || !(['accountId','sourceId','instanceId'] as const).every(k=>record.scope && (record.scope as Record<string,unknown>)[k]===c.scope[k]) || !Array.isArray(record.rows) || record.rows.length>100) throw 0;
      const rows=record.rows.map(parseRow), ids=new Set<string>(), parents=new Set<string>();
      for (const row of rows) { if(ids.has(row.request.eventId)) throw 0; ids.add(row.request.eventId); if(row.state!=='archived') { if(parents.has(row.request.observationEventId)) throw 0; parents.add(row.request.observationEventId); } }
      return rows;
    } catch { throw new QueueFailure('storage-corrupt'); }
  }
  function save(c: Capture, rows: ObservationRevisionPendingRow[]) {
    c.check(); const raw=JSON.stringify({version:1,scope:c.scope,rows});
    if(rows.length>100 || bytes(raw)>512*1024) throw new QueueFailure('full');
    try { options.storage.setItem(c.key,raw); } catch(error) { let quota=false;try{quota=!!error && typeof error==='object' && 'name' in error && error.name==='QuotaExceededError';}catch{/* Denied diagnostic access is an unavailable store. */}throw new QueueFailure(quota ? 'full' : 'storage-unavailable'); }
  }
  async function locked<T>(c:Capture, action:()=>T):Promise<T> {
    try { const result=await storageLock(c.lock,()=>{c.check();return action();}); c.check();return result; }
    catch(error) { if(error instanceof QueueFailure) throw error; throw new QueueFailure('coordination-unavailable'); }
  }
  const reason=(error:unknown):ObservationRevisionPendingReason => error instanceof QueueFailure ? error.reason : 'coordination-unavailable';
  return {
    setContext(next: ObservationRevisionPendingContext | null) {
      const valid=next && ['accountId','sourceId','instanceId'].every(k=>typeof next[k as keyof typeof next]==='string' && !!String(next[k as keyof typeof next]).trim()) && Number.isSafeInteger(next.authRevision) && next.authRevision>=0 && ['real','example','forecast'].includes(next.mode) && typeof next.authenticated==='boolean' && typeof next.locked==='boolean';
      const copied=valid ? Object.freeze({...next}) as ObservationRevisionPendingContext : null;
      if(JSON.stringify(copied)!==JSON.stringify(context)) { generation++;context=copied; }
    },
    async snapshot():Promise<ObservationRevisionPendingSnapshot> {
      try { const c=capture(false);return {status:'available',rows:Object.freeze(await locked(c,()=>read(c)))}; }
      catch(error) { return {status:'unavailable',reason:reason(error)}; }
    },
    async enqueue(input:unknown):Promise<ObservationRevisionPendingEnqueueResult> {
      let request:ObservationRevisionRequest;
      try {request=parseObservationRevisionRequest(input);} catch {return {status:'not-saved',reason:'invalid-request'};}
      try {const c=capture(true);return await locked(c,()=>{
        const rows=read(c),old=rows.find(r=>r.request.eventId===request.eventId);
        if(old) { if(!observationRevisionRequestEqual(old.request,request)) throw new QueueFailure('conflict'); if(old.state==='archived') throw new QueueFailure('already-archived'); return {status:'already-queued' as const,eventId:request.eventId}; }
        if(rows.some(r=>r.state!=='archived' && r.request.observationEventId===request.observationEventId)) throw new QueueFailure('parent-pending');
        const queuedAt=new Date((options.now??Date.now)()).toISOString();
        save(c,[...rows,Object.freeze({request,queuedAt,state:'pending' as const})]);return {status:'queued' as const,eventId:request.eventId};
      });} catch(error) {return {status:'not-saved',reason:reason(error)};}
    },
    async flush(filter:{eventId?:string}={}):Promise<ObservationRevisionPendingFlushResult> {
      const items:ObservationRevisionPendingFlushItem[]=[];
      try {const c=capture(true);const result=await syncLock<ObservationRevisionPendingFlushResult>(c.lock,async()=>{
        c.check(); const candidates=await locked(c,()=>read(c).filter(r=>r.state==='pending' && (!filter.eventId || r.request.eventId===filter.eventId)).slice(0,10));
        for(const candidate of candidates) {
          c.check();const row=await locked(c,()=>read(c).find(r=>rowEqual(r,candidate)));
          c.check(); if(!row) continue;
          let receipt:ObservationRevisionReceipt;
          try {
            receipt=await options.transport.append(row.request,c.scope);c.check();
            if(!receipt || !['accepted','duplicate'].includes(receipt.status) || receipt.eventId!==row.request.eventId || (typeof receipt.recordedAt!=='string' || !isValidInstant(receipt.recordedAt))) {
              await locked(c,()=>{const rows=read(c),i=rows.findIndex(r=>rowEqual(r,row));if(i>=0){rows[i]=Object.freeze({...row,lastError:'REVISION_RECEIPT_INVALID'});save(c,rows);}});
              items.push({eventId:row.request.eventId,status:'pending',code:'REVISION_RECEIPT_INVALID'});continue;
            }
          } catch(error) {
            c.check(); const e=error as {status?:number;code?:string};
            let code='REVISION_OUTCOME_UNKNOWN',state:'pending'|'rejected'|'paused'='pending';
            if(e?.code==='SOURCE_MISMATCH' || e?.code==='INSTANCE_MISMATCH') {code=e.code;state='paused';}
            else if(e?.status===401 || e?.status===403) {code='REVISION_AUTH_REQUIRED';state='paused';}
            else if(e?.status===426) {code='REVISION_PROTOCOL_REQUIRED';state='paused';}
            else if(e?.code && Object.hasOwn(rejectedStatuses,e.code) && rejectedStatuses[e.code]===e.status) {code=e.code;state='rejected';}
            await locked(c,()=>{const rows=read(c),i=rows.findIndex(r=>rowEqual(r,row));if(i>=0) {rows[i]=Object.freeze({...row,state:state==='rejected'?'rejected':'pending',lastError:code});save(c,rows);}});
            items.push({eventId:row.request.eventId,status:state,code}); if(state==='paused') break;continue;
          }
          try {const removed=await locked(c,()=>{const rows=read(c),i=rows.findIndex(r=>rowEqual(r,row));if(i<0)return false;rows.splice(i,1);save(c,rows);return true;});
            items.push({eventId:row.request.eventId,status:'confirmed',receipt,cleanup:removed?'removed':'retained'});
            if(!removed) return {status:'unavailable' as const,items,reason:'conflict' as const};
          } catch(error) {if(reason(error)==='context-changed')throw error;items.push({eventId:row.request.eventId,status:'confirmed',receipt,cleanup:'retained'});return {status:'unavailable' as const,items,reason:reason(error)};}
        }
        return {status:'done' as const,items};
      },()=>({status:'busy' as const,items}));c.check();return result;
      }catch(error){const why=reason(error);return {status:why==='inactive'?'inactive':why==='context-changed'?'context-changed':'unavailable',items,reason:why};}
    },
    async archiveRejected(expectedRow:ObservationRevisionPendingRow):Promise<{archived:boolean;reason?:ObservationRevisionPendingReason}> {
      try {const expected=parseRow(expectedRow),c=capture(true);const result=await syncLock(c.lock,async()=>{c.check();return locked(c,()=>{const rows=read(c),i=rows.findIndex(r=>rowEqual(r,expected));if(i<0 || rows[i].state!=='rejected')return {archived:false,reason:'conflict' as const};rows[i]=Object.freeze({...rows[i],state:'archived' as const});save(c,rows);return {archived:true};});},()=>({archived:false,reason:'conflict' as const}));c.check();return result;}
      catch(error){return {archived:false,reason:reason(error)};}
    },
    async clearArchived():Promise<{cleared:number;reason?:ObservationRevisionPendingReason}> {
      try {const c=capture(true);return await locked(c,()=>{const rows=read(c),remaining=rows.filter(r=>r.state!=='archived');save(c,remaining);return {cleared:rows.length-remaining.length};});}
      catch(error){return {cleared:0,reason:reason(error)};}
    },
  };
}
