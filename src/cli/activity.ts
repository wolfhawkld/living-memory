import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseActivityAppendRequest, type ActivityAppendRequest, type ActivityAppendResult, type ActivityReference, type ActivitySettings } from '../shared/activity.js';
import type { Concept } from '../shared/types.js';
import { isValidInstant } from '../core/time-model.js';

export interface CliActivityScope { baseUrl: string; principalId: string; sourceId: string; instanceId: string }
export interface CliActivityTransport {
  scope: CliActivityScope;
  getSettings: (timeoutMs: number) => Promise<ActivitySettings>;
  append: (request: ActivityAppendRequest, timeoutMs: number) => Promise<ActivityAppendResult>;
}
export interface CliActivityOptions { stateDir: string; transport: CliActivityTransport; now?: () => Date; timeoutMs?: number }
export interface CliActivityResult { status: 'recorded' | 'pending' | 'disabled' | 'unavailable' | 'discarded' | 'quarantined' | 'cleared'; operationId?: string; pending?: number; code?: string; cleared?: number }
export type CliActivityInput = { kind: 'query'; concepts: readonly Concept[]; resultCount: number; queryText?: string }
  | { kind: 'show'; concept: Concept }
  | { kind: 'after'; operationId: string; workflow: 'query' | 'ingest' | 'consolidate' };
type Workflow = Extract<CliActivityInput, { kind: 'after' }>['workflow'];
interface ReceiptBase { format: 'living-memory-cli-activity'; version: 1; scope: CliActivityScope; operationId: string; epoch: number }
interface PendingReceipt extends ReceiptBase { state: 'pending' | 'quarantined'; command: 'query' | 'show' | 'after'; workflow?: Workflow; requests: ActivityAppendRequest[]; acknowledged: string[] }
interface HookMarker extends ReceiptBase { state: 'completed' | 'discarded'; command: 'after'; workflow: Workflow; eventId: string; occurredAt: string }
type Receipt = PendingReceipt | HookMarker;
const FORMAT = 'living-memory-cli-activity' as const;
const MAX_PENDING = 100; const MAX_PENDING_BYTES = 512 * 1024; const MAX_MARKERS = 1000; const MAX_DIRECTORY_BYTES = 2 * 1024 * 1024;
const LEASE_OVERHEAD = 64 * 1024;
const DIAGNOSTIC_CODES = new Set([
  'ACTIVITY_LOCAL_BUSY', 'ACTIVITY_LOCAL_UNSAFE', 'ACTIVITY_LOCAL_CAPACITY', 'ACTIVITY_RECEIPT_INVALID',
  'ACTIVITY_SETTINGS_INVALID', 'ACTIVITY_ACK_INVALID', 'ACTIVITY_TIMEOUT', 'ACTIVITY_RECEIPT_NOT_FOUND',
  'ACTIVITY_DISABLED', 'ACTIVITY_EPOCH_CHANGED', 'ACTIVITY_DELETED', 'ACTIVITY_CONFLICT', 'INVALID_ACTIVITY',
  'INVALID_ACTIVITY_REFERENCE', 'ACTIVITY_CHANNEL_FORBIDDEN', 'ACTIVITY_SETTINGS_CHANGED',
  'TIMEOUT', 'NETWORK_ERROR', 'AUTH_REQUIRED', 'FORBIDDEN', 'HTTP_ERROR', 'INVALID_RESPONSE',
  'SESSION_REQUIRED', 'SOURCE_MISMATCH', 'INSTANCE_MISMATCH', 'TOKEN_INVALID', 'WRITE_TOKEN_REQUIRED', 'REDIRECT_REJECTED',
]);
const fixedCode = (error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && DIAGNOSTIC_CODES.has(code) ? code : 'ACTIVITY_UNAVAILABLE';
};
class LocalActivityError extends Error { constructor(readonly code: string) { super(code); } }
function record(value: unknown, keys: readonly string[], required = keys): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LocalActivityError('ACTIVITY_RECEIPT_INVALID');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !keys.includes(key)) || required.some((key) => !Object.hasOwn(data, key))) throw new LocalActivityError('ACTIVITY_RECEIPT_INVALID');
  return data;
}
function scope(value: unknown): CliActivityScope {
  const data = record(value, ['baseUrl', 'principalId', 'sourceId', 'instanceId']);
  if (Object.values(data).some((value) => typeof value !== 'string' || !value.trim() || value.length > 2048)) throw new LocalActivityError('ACTIVITY_RECEIPT_INVALID');
  return { baseUrl: data.baseUrl as string, principalId: data.principalId as string, sourceId: data.sourceId as string, instanceId: data.instanceId as string };
}
const sameScope = (left: CliActivityScope, right: CliActivityScope) => left.baseUrl === right.baseUrl && left.principalId === right.principalId && left.sourceId === right.sourceId && left.instanceId === right.instanceId;
function parseReceipt(value: unknown): Receipt {
  const initial = record(value, ['format', 'version', 'scope', 'operationId', 'epoch', 'state', 'command', 'workflow', 'requests', 'acknowledged', 'eventId', 'occurredAt'], ['format', 'version', 'scope', 'operationId', 'epoch', 'state', 'command']);
  if (initial.format !== FORMAT || initial.version !== 1 || typeof initial.operationId !== 'string' || !initial.operationId.trim() || initial.operationId.length > 200
    || !Number.isSafeInteger(initial.epoch) || Number(initial.epoch) < 0) throw new LocalActivityError('ACTIVITY_RECEIPT_INVALID');
  const base: ReceiptBase = { format: FORMAT, version: 1, scope: scope(initial.scope), operationId: initial.operationId, epoch: Number(initial.epoch) };
  const workflow = initial.workflow;
  if (initial.command === 'after' && !['query', 'ingest', 'consolidate'].includes(String(workflow))) throw new LocalActivityError('ACTIVITY_RECEIPT_INVALID');
  if (initial.state === 'completed' || initial.state === 'discarded') {
    record(value, ['format', 'version', 'scope', 'operationId', 'epoch', 'state', 'command', 'workflow', 'eventId', 'occurredAt']);
    if (initial.command !== 'after' || typeof initial.eventId !== 'string' || !initial.eventId.trim() || initial.eventId.length > 200
      || typeof initial.occurredAt !== 'string' || !isValidInstant(initial.occurredAt)) throw new LocalActivityError('ACTIVITY_RECEIPT_INVALID');
    return { ...base, command: 'after', state: initial.state, workflow: workflow as Workflow, eventId: initial.eventId, occurredAt: initial.occurredAt };
  }
  record(value, ['format', 'version', 'scope', 'operationId', 'epoch', 'state', 'command', 'workflow', 'requests', 'acknowledged'],
    ['format', 'version', 'scope', 'operationId', 'epoch', 'state', 'command', 'requests', 'acknowledged']);
  if ((initial.state !== 'pending' && initial.state !== 'quarantined') || !['query', 'show', 'after'].includes(String(initial.command))
    || (initial.command !== 'after' && Object.hasOwn(initial, 'workflow')) || !Array.isArray(initial.requests) || !initial.requests.length || initial.requests.length > 2
    || !Array.isArray(initial.acknowledged)) throw new LocalActivityError('ACTIVITY_RECEIPT_INVALID');
  const requests = initial.requests.map(parseActivityAppendRequest);
  if (requests.some((request) => request.event.operationId !== base.operationId || request.epoch !== base.epoch || request.delivery.channel !== 'cli')
    || new Set(requests.map((request) => request.event.eventId)).size !== requests.length
    || initial.acknowledged.some((id) => typeof id !== 'string' || !requests.some((request) => request.event.eventId === id))
    || new Set(initial.acknowledged).size !== initial.acknowledged.length) throw new LocalActivityError('ACTIVITY_RECEIPT_INVALID');
  const expectedKinds = initial.command === 'after' ? ['workflow.reported'] : initial.command === 'query' ? ['query.submitted', 'content.delivery'] : ['query.selected', 'content.delivery'];
  if (requests.length !== expectedKinds.length || requests.some((request, index) => request.event.kind !== expectedKinds[index]
    || request.event.channel !== (initial.command === 'after' ? 'progressive-kg' : 'cli'))
    || (initial.command === 'after' && requests[0].event.kind === 'workflow.reported' && requests[0].event.payload.workflow !== workflow)) throw new LocalActivityError('ACTIVITY_RECEIPT_INVALID');
  return { ...base, command: initial.command as PendingReceipt['command'], state: initial.state,
    ...(initial.command === 'after' ? { workflow: workflow as Workflow } : {}), requests, acknowledged: [...initial.acknowledged] as string[] };
}
function directory(options: CliActivityOptions): string {
  const path = join(options.stateDir, 'activity');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new LocalActivityError('ACTIVITY_LOCAL_UNSAFE');
  chmodSync(path, 0o700); return path;
}
function pathFor(directory: string, scope: CliActivityScope, operationId: string): string {
  return join(directory, `${createHash('sha256').update(JSON.stringify([scope.baseUrl, scope.principalId, scope.sourceId, scope.instanceId, operationId])).digest('hex')}.json`);
}
function privateRead(path: string): unknown {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PENDING_BYTES || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())))) throw new LocalActivityError('ACTIVITY_LOCAL_UNSAFE');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function read(path: string): Receipt | null {
  try { return parseReceipt(privateRead(path)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function reservedReceiptBytes(receipt: Receipt): number {
  // Admission reserves later acknowledgements and quarantine state as well, so
  // successful deliveries can always settle without exceeding the pending cap.
  return Buffer.byteLength(JSON.stringify('requests' in receipt ? { ...receipt, state: 'quarantined',
    acknowledged: receipt.requests.map((request) => request.event.eventId) } : receipt), 'utf8');
}
function stats(directory: string, excluding?: string) {
  let pending = 0; let pendingBytes = 0; let markers = 0; let hookSlots = 0; let bytes = 0;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name); if (path === excluding || /^\.lease\.sqlite(?:-(?:journal|wal|shm))?$/.test(name)) continue;
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new LocalActivityError('ACTIVITY_LOCAL_UNSAFE');
    bytes += info.size;
    if (!name.endsWith('.json')) continue;
    let receipt: Receipt;
    try { receipt = parseReceipt(privateRead(path)); } catch { pending += 1; pendingBytes += info.size; continue; }
    if (receipt.state === 'pending' || receipt.state === 'quarantined') { pending += 1; pendingBytes += Math.max(info.size, reservedReceiptBytes(receipt)); if (receipt.command === 'after') hookSlots += 1; }
    else { markers += 1; hookSlots += 1; }
  }
  return { pending, pendingBytes, markers, hookSlots, bytes };
}
function save(directory: string, path: string, receipt: Receipt) {
  const data = JSON.stringify(receipt); const size = Buffer.byteLength(data, 'utf8'); const state = stats(directory, path);
  const pending = receipt.state === 'pending' || receipt.state === 'quarantined';
  if (state.bytes + Math.max(size, reservedReceiptBytes(receipt)) + LEASE_OVERHEAD > MAX_DIRECTORY_BYTES
    || (pending && (state.pending + 1 > MAX_PENDING || state.pendingBytes + Math.max(size, reservedReceiptBytes(receipt)) > MAX_PENDING_BYTES))
    || (!pending && state.markers + 1 > MAX_MARKERS) || (receipt.command === 'after' && state.hookSlots + 1 > MAX_MARKERS)) throw new LocalActivityError('ACTIVITY_LOCAL_CAPACITY');
  const temporary = `${path}.${randomUUID()}.tmp`; let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, data, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path); chmodSync(path, 0o600);
  } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch { /* already renamed */ } }
}
function settings(value: ActivitySettings): ActivitySettings {
  if (!value || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new LocalActivityError('ACTIVITY_SETTINGS_INVALID');
  return value;
}
function marker(receipt: PendingReceipt, state: HookMarker['state']): HookMarker {
  return { format: FORMAT, version: 1, scope: receipt.scope, operationId: receipt.operationId, epoch: receipt.epoch,
    command: 'after', workflow: receipt.workflow!, state, eventId: receipt.requests[0].event.eventId, occurredAt: receipt.requests[0].event.occurredAt };
}
function discard(directory: string, path: string, receipt: Receipt): CliActivityResult {
  if (receipt.command === 'after') save(directory, path, 'requests' in receipt ? marker(receipt, 'discarded') : { ...receipt, state: 'discarded' });
  else unlinkSync(path);
  return { status: 'discarded', operationId: receipt.operationId, pending: 0 };
}
async function withLock<T>(options: CliActivityOptions, action: (directory: string, remaining: () => number) => Promise<T>): Promise<T | CliActivityResult> {
  let lease: DatabaseSync | undefined; let acquired = false;
  try {
    scope(options.transport.scope);
    const dir = directory(options); const lockPath = join(dir, '.lease.sqlite');
    try {
      const info = lstatSync(lockPath);
      if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new LocalActivityError('ACTIVITY_LOCAL_UNSAFE');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    lease = new DatabaseSync(lockPath); chmodSync(lockPath, 0o600);
    try { lease.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); acquired = true; }
    catch (error) { if ((error as { errcode?: number }).errcode === 5 || (error as { errcode?: number }).errcode === 6) throw new LocalActivityError('ACTIVITY_LOCAL_BUSY'); throw error; }
    const deadline = Date.now() + (options.timeoutMs ?? 1000);
    const remaining = () => { const value = deadline - Date.now(); if (value < 1) throw new LocalActivityError('ACTIVITY_TIMEOUT'); return value; };
    return await action(dir, remaining);
  } catch (error) { return { status: 'unavailable', code: fixedCode(error) }; }
  finally { if (lease) { if (acquired) try { lease.exec('ROLLBACK'); } catch { /* preserve original result */ }
    try { lease.close(); } catch { /* cleanup cannot replace a successful primary result */ } } }
}
function frozen(options: CliActivityOptions, input: CliActivityInput, epoch: number, operationId: string): PendingReceipt {
  const occurredAt = (options.now ?? (() => new Date()))().toISOString();
  const ref = (concept: Concept, scope: ActivityReference['scope']): ActivityReference => ({ conceptId: concept.id, sourceRevision: concept.source.revision,
    path: concept.source.path, ...(concept.title.length <= 500 ? { title: concept.title } : {}), scope });
  const refs = input.kind === 'query' ? input.concepts.slice(0, 50).map((concept) => ref(concept, 'result')) : input.kind === 'show' ? [ref(input.concept, 'result')] : [];
  const requests: ActivityAppendRequest[] = [];
  const add = (stepKey: string, kind: ActivityAppendRequest['event']['kind'], eventRefs: ActivityReference[], payload: object) => requests.push(parseActivityAppendRequest({ epoch,
    event: { schemaVersion: 1, eventId: randomUUID(), operationId, stepKey, occurredAt,
      actor: { kind: input.kind === 'after' ? 'agent' : 'unknown' }, channel: input.kind === 'after' ? 'progressive-kg' : 'cli', kind, refs: eventRefs, payload },
    delivery: { deliveryId: randomUUID(), channel: 'cli' } }));
  if (input.kind === 'after') add('workflow-reported', 'workflow.reported', [], { workflow: input.workflow, outcome: 'reported-success' });
  else {
    if (input.kind === 'query') add('query-submitted', 'query.submitted', refs, { resultCount: input.resultCount,
      ...(input.queryText !== undefined ? { queryText: input.queryText, queryTextSavedByUser: true } : {}) });
    else add('query-selected', 'query.selected', refs, {});
    add('result-prepared', 'content.delivery', input.kind === 'show' ? [ref(input.concept, 'body')] : refs,
      { medium: 'cli-result', outcome: 'prepared', coverage: input.kind === 'show' ? 'body' : 'results' });
  }
  return { format: FORMAT, version: 1, scope: scope(options.transport.scope), operationId, epoch, state: 'pending', command: input.kind,
    ...(input.kind === 'after' ? { workflow: input.workflow } : {}), requests, acknowledged: [] };
}
async function flush(options: CliActivityOptions, dir: string, path: string, receipt: PendingReceipt, remaining: () => number): Promise<CliActivityResult> {
  if (receipt.state === 'quarantined') return { status: 'quarantined', operationId: receipt.operationId, code: 'ACTIVITY_QUARANTINED' };
  for (const request of receipt.requests) {
    if (receipt.acknowledged.includes(request.event.eventId)) continue;
    try {
      const result = await options.transport.append(request, remaining());
      if (!result || !['accepted', 'duplicate'].includes(result.status) || result.epoch !== receipt.epoch || result.eventId !== request.event.eventId || !isValidInstant(result.receivedAt)) throw new LocalActivityError('ACTIVITY_ACK_INVALID');
      receipt = { ...receipt, acknowledged: [...receipt.acknowledged, request.event.eventId] }; save(dir, path, receipt);
    } catch (error) {
      const code = fixedCode(error);
      if (['ACTIVITY_DISABLED', 'ACTIVITY_EPOCH_CHANGED', 'ACTIVITY_DELETED'].includes(code)) return discard(dir, path, receipt);
      if (['ACTIVITY_CONFLICT', 'INVALID_ACTIVITY', 'INVALID_ACTIVITY_REFERENCE', 'ACTIVITY_CHANNEL_FORBIDDEN'].includes(code)) {
        save(dir, path, { ...receipt, state: 'quarantined' }); return { status: 'quarantined', operationId: receipt.operationId, code };
      }
      return { status: 'pending', operationId: receipt.operationId, pending: receipt.requests.length - receipt.acknowledged.length, code };
    }
  }
  if (receipt.command === 'after') save(dir, path, marker(receipt, 'completed')); else unlinkSync(path);
  return { status: 'recorded', operationId: receipt.operationId, pending: 0 };
}

/** Tracking failures never replace the successful primary query/show/refresh result. */
export async function recordCliActivity(options: CliActivityOptions, input: CliActivityInput): Promise<CliActivityResult> {
  const deadline = Date.now() + (options.timeoutMs ?? 1000);
  let current: ActivitySettings;
  try { scope(options.transport.scope); current = settings(await options.transport.getSettings(Math.max(1, deadline - Date.now()))); }
  catch (error) { return { status: 'unavailable', code: fixedCode(error) }; }
  if (!current.enabled) return { status: 'disabled' };
  if (Date.now() >= deadline) return { status: 'unavailable', code: 'ACTIVITY_TIMEOUT' };
  return withLock<CliActivityResult>({ ...options, timeoutMs: deadline - Date.now() }, async (dir, remaining) => {
    const operationId = input.kind === 'after' ? `hook:${input.operationId}` : randomUUID();
    const path = pathFor(dir, options.transport.scope, operationId);
    let receipt = input.kind === 'after' ? read(path) : null;
    if (receipt) {
      if (!sameScope(receipt.scope, options.transport.scope) || receipt.command !== 'after' || input.kind !== 'after' || receipt.workflow !== input.workflow) return { status: 'quarantined', operationId, code: 'ACTIVITY_CONFLICT' };
      if (receipt.epoch !== current.epoch || receipt.state === 'discarded') return discard(dir, path, receipt);
      if (receipt.state === 'completed') return { status: 'recorded', operationId, pending: 0 };
    } else { receipt = frozen(options, input, current.epoch, operationId); save(dir, path, receipt); }
    return flush(options, dir, path, receipt as PendingReceipt, remaining);
  });
}

export async function retryCliActivity(options: CliActivityOptions, operationId: string): Promise<CliActivityResult> {
  const deadline = Date.now() + (options.timeoutMs ?? 1000);
  let current: ActivitySettings;
  try { scope(options.transport.scope); current = settings(await options.transport.getSettings(Math.max(1, deadline - Date.now()))); }
  catch (error) { return { status: 'unavailable', code: fixedCode(error) }; }
  if (Date.now() >= deadline) return { status: 'unavailable', code: 'ACTIVITY_TIMEOUT' };
  return withLock<CliActivityResult>({ ...options, timeoutMs: deadline - Date.now() }, async (dir, remaining) => {
    const path = pathFor(dir, options.transport.scope, operationId); const receipt = read(path);
    if (!receipt || !sameScope(receipt.scope, options.transport.scope)) return { status: 'unavailable', code: 'ACTIVITY_RECEIPT_NOT_FOUND' };
    if (!current.enabled || receipt.epoch !== current.epoch || receipt.state === 'discarded') return discard(dir, path, receipt);
    if (!('requests' in receipt)) return { status: 'recorded', operationId, pending: 0 };
    return flush(options, dir, path, receipt, remaining);
  });
}

export async function clearLocalCliActivity(options: CliActivityOptions): Promise<CliActivityResult> {
  return withLock<CliActivityResult>(options, async dir => {
    let cleared = 0;
    for (const name of readdirSync(dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      const path = join(dir, name); const raw = privateRead(path);
      if (raw && typeof raw === 'object' && 'scope' in raw && sameScope(scope((raw as { scope: unknown }).scope), options.transport.scope)) { unlinkSync(path); cleared += 1; }
    }
    return { status: 'cleared', cleared };
  });
}
