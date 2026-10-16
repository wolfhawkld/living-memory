import type { BodyRange } from './knowledge-references.js';
import { isValidInstant } from '../core/time-model.js';

/** Activity records describe interaction facts, never learning performance. */
export interface ActivitySettings {
  enabled: boolean;
  epoch: number;
  revision: number;
}

export type ActivityKind = 'query.submitted' | 'query.selected' | 'reader.opened' | 'content.visible' | 'content.delivery' | 'workflow.reported';
export type ActivityChannel = 'web' | 'cli' | 'progressive-kg' | 'feishu';
export interface ActivityActor { kind: 'user' | 'agent' | 'unknown' }
export interface ActivityDelivery { deliveryId: string; channel: ActivityChannel }

interface ActivityEventBase {
  schemaVersion: 1;
  eventId: string;
  operationId: string;
  stepKey: string;
  occurredAt: string;
  actor: ActivityActor;
  channel: ActivityChannel;
  refs: ActivityReference[];
}

type SavedQuery = { queryText?: never; queryTextSavedByUser?: never }
  | { queryText: string; queryTextSavedByUser: true };
export type ActivityEvent = ActivityEventBase & (
  | { kind: 'query.submitted'; payload: { resultCount: number } & SavedQuery }
  | { kind: 'query.selected'; payload: SavedQuery }
  | { kind: 'reader.opened'; payload: { section: 'summary' | 'body'; requestedSectionId?: string } }
  | { kind: 'content.visible'; payload: Record<string, never> }
  | { kind: 'content.delivery'; payload: { medium: 'cli-result' | 'feishu-text' | 'feishu-card'; outcome: 'prepared' | 'platform-accepted' | 'failed-or-unknown';
      coverage: 'results' | 'body' | 'body-page' | 'prompt'; page?: number; pageCount?: number } }
  | { kind: 'workflow.reported'; payload: { workflow: 'query' | 'ingest' | 'consolidate'; outcome: 'reported-success' } }
);
export interface ActivityAppendRequest { epoch: number; event: ActivityEvent; delivery: ActivityDelivery }
export interface ActivityAppendResult { status: 'accepted' | 'duplicate'; epoch: number; eventId: string; receivedAt: string }
export interface ActivityReference {
  conceptId: string;
  sourceRevision: string;
  path: string;
  title?: string;
  scope: 'result' | 'summary' | 'body' | 'section' | 'block';
  sectionId?: string;
  blockId?: string;
  contentPart?: 'summary' | 'body';
  bodyRange?: BodyRange;
}
export interface ActivityReferenceInspection { status: 'current' | 'historical-or-unresolved' }
export interface ActivityRecordedBy { principalId: string; sessionKind: string }
export interface ActivityRecord {
  event: ActivityEvent;
  epoch: number;
  receivedAt: string;
  recordedBy: ActivityRecordedBy;
  referenceInspections: ActivityReferenceInspection[];
}
export interface ActivityDeliveryRecord extends ActivityDelivery {
  eventId: string;
  receivedAt: string;
  recordedBy: ActivityRecordedBy;
}
export interface ActivityListOptions {
  conceptId?: string; operationId?: string; kind?: ActivityKind; channel?: ActivityChannel;
  from?: string; to?: string; limit?: number; cursor?: string;
}
export interface ActivityPage { items: ActivityRecord[]; nextCursor: string | null }
export interface ActivityExport {
  format: 'living-memory-activity'; version: 1; exportedAt: string; sourceId: string;
  settings: ActivitySettings; events: ActivityRecord[]; deliveries: ActivityDeliveryRecord[];
}

export interface ActivitySettingsUpdate {
  enabled: boolean;
  expectedRevision: number;
}

export interface ActivityClearRequest { expectedEpoch: number }
export interface ActivityClearOperationRequest extends ActivityClearRequest { operationId: string }

export class ActivityValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ActivityValidationError'; }
}

function object(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ActivityValidationError('活动记录必须是对象。');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(record, key))) {
    throw new ActivityValidationError('活动记录包含未知字段或缺少必要字段。');
  }
  return record;
}
function text(value: unknown, limit: number, empty = false): string {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())) throw new ActivityValidationError('活动文本字段无效。');
  return value;
}
function id(value: unknown, limit = 200): string {
  const result = text(value, limit);
  if (/[\u0000-\u001f\u007f]/.test(result)) throw new ActivityValidationError('活动标识符无效。');
  return result;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ActivityValidationError('活动数值字段无效。');
  return value as number;
}
function channel(value: unknown): ActivityChannel {
  if (value !== 'web' && value !== 'cli' && value !== 'progressive-kg' && value !== 'feishu') throw new ActivityValidationError('活动通道无效。');
  return value;
}
function queryPayload(value: unknown, submitted: boolean): Record<string, unknown> {
  const payload = object(value, ['queryText', 'queryTextSavedByUser', ...(submitted ? ['resultCount'] : [])], submitted ? ['resultCount'] : []);
  const result: Record<string, unknown> = submitted ? { resultCount: integer(payload.resultCount) } : {};
  if (submitted && Number(result.resultCount) > 1_000_000) throw new ActivityValidationError('查询结果计数超过上限。');
  const hasText = Object.hasOwn(payload, 'queryText');
  const hasConsent = Object.hasOwn(payload, 'queryTextSavedByUser');
  if (hasText !== hasConsent || (hasConsent && payload.queryTextSavedByUser !== true)) throw new ActivityValidationError('查询原文仅可经用户主动确认后保存。');
  if (hasText) { result.queryText = text(payload.queryText, 1000, true); result.queryTextSavedByUser = true; }
  return result;
}

function parseActivityReference(value: unknown): ActivityReference {
  const input = object(value, ['conceptId', 'sourceRevision', 'path', 'title', 'scope', 'sectionId', 'blockId', 'contentPart', 'bodyRange'], ['conceptId', 'sourceRevision', 'path', 'scope']);
  const path = text(input.path, 2048);
  if (/^(?:\/|[a-z]:)/i.test(path) || /[\\\u0000-\u001f\u007f]/.test(path) || path.split('/').includes('..')) throw new ActivityValidationError('活动引用路径必须是安全的相对路径。');
  const scope = input.scope;
  if (!['result', 'summary', 'body', 'section', 'block'].includes(String(scope))) throw new ActivityValidationError('活动引用范围无效。');
  const result: ActivityReference = { conceptId: id(input.conceptId), sourceRevision: id(input.sourceRevision), path, scope: scope as ActivityReference['scope'] };
  if (Object.hasOwn(input, 'title')) result.title = text(input.title, 500, true);
  const has = (key: string) => Object.hasOwn(input, key);
  if (scope === 'result' || scope === 'summary' || scope === 'body') {
    if (['sectionId', 'blockId', 'contentPart', 'bodyRange'].some(has)) throw new ActivityValidationError('文档引用不能携带章节或块定位字段。');
  } else {
    if (has('sectionId')) result.sectionId = id(input.sectionId);
    if (scope === 'section' && (!has('sectionId') || has('blockId') || has('contentPart'))) throw new ActivityValidationError('章节引用必须指定章节且不能携带块字段。');
    if (scope === 'block') {
      result.blockId = id(input.blockId);
      if (input.contentPart !== 'summary' && input.contentPart !== 'body') throw new ActivityValidationError('正文块必须指定正文类别。');
      result.contentPart = input.contentPart;
      if (!has('bodyRange') || (has('sectionId') && input.contentPart !== 'body')) throw new ActivityValidationError('正文块必须具有对应正文范围。');
    }
    if (has('bodyRange')) {
      const body = object(input.bodyRange, ['coordinateSpace', 'startOffset', 'endOffset', 'startLine', 'endLine']);
      if (body.coordinateSpace !== 'render-markdown-v1') throw new ActivityValidationError('正文坐标空间无效。');
      const startOffset = integer(body.startOffset); const endOffset = integer(body.endOffset);
      const startLine = integer(body.startLine); const endLine = integer(body.endLine);
      if (endOffset <= startOffset || startLine < 1 || endLine < startLine) throw new ActivityValidationError('正文引用范围无效。');
      result.bodyRange = { coordinateSpace: 'render-markdown-v1', startOffset, endOffset, startLine, endLine };
    }
  }
  return result;
}

/** Browser-safe strict parser used both before queue persistence and on receipt. */
export function parseActivityAppendRequest(value: unknown): ActivityAppendRequest {
  const request = object(value, ['epoch', 'event', 'delivery']);
  const event = object(request.event, ['schemaVersion', 'eventId', 'operationId', 'stepKey', 'occurredAt', 'actor', 'channel', 'kind', 'refs', 'payload']);
  if (event.schemaVersion !== 1) throw new ActivityValidationError('活动记录版本无效。');
  const actor = object(event.actor, ['kind']);
  if (actor.kind !== 'user' && actor.kind !== 'agent' && actor.kind !== 'unknown') throw new ActivityValidationError('活动主体类别无效。');
  const occurredAt = text(event.occurredAt, 64);
  if (!isValidInstant(occurredAt)) {
    throw new ActivityValidationError('活动时间必须包含明确时区。');
  }
  let payload: Record<string, unknown>;
  switch (event.kind) {
    case 'query.submitted': payload = queryPayload(event.payload, true); break;
    case 'query.selected': payload = queryPayload(event.payload, false); break;
    case 'reader.opened': {
      const input = object(event.payload, ['section', 'requestedSectionId'], ['section']);
      if (input.section !== 'summary' && input.section !== 'body') throw new ActivityValidationError('阅读区段无效。');
      payload = { section: input.section };
      if (Object.hasOwn(input, 'requestedSectionId')) {
        if (input.section !== 'body') throw new ActivityValidationError('摘要不能携带请求章节。');
        payload.requestedSectionId = id(input.requestedSectionId);
      }
      break;
    }
    case 'content.visible': object(event.payload, []); payload = {}; break;
    case 'content.delivery': {
      const input = object(event.payload, ['medium', 'outcome', 'coverage', 'page', 'pageCount'], ['medium', 'outcome', 'coverage']);
      const cli = input.medium === 'cli-result';
      if (!cli && input.medium !== 'feishu-text' && input.medium !== 'feishu-card') throw new ActivityValidationError('内容传递媒介无效。');
      if ((cli && (input.outcome !== 'prepared' || !['results', 'body'].includes(String(input.coverage))))
        || (!cli && (!['platform-accepted', 'failed-or-unknown'].includes(String(input.outcome)) || !['results', 'body-page', 'prompt'].includes(String(input.coverage))))) {
        throw new ActivityValidationError('内容传递结果与媒介不一致。');
      }
      payload = { medium: input.medium, outcome: input.outcome, coverage: input.coverage };
      if (input.coverage === 'body-page') {
        const page = integer(input.page); const pageCount = integer(input.pageCount);
        if (page < 1 || pageCount < page || pageCount > 100_000) throw new ActivityValidationError('传递页码无效。');
        payload.page = page; payload.pageCount = pageCount;
      } else if (Object.hasOwn(input, 'page') || Object.hasOwn(input, 'pageCount')) throw new ActivityValidationError('该传递范围不能携带页码。');
      break;
    }
    case 'workflow.reported': {
      const input = object(event.payload, ['workflow', 'outcome']);
      if (!['query', 'ingest', 'consolidate'].includes(String(input.workflow)) || input.outcome !== 'reported-success') throw new ActivityValidationError('工作流报告无效。');
      payload = { workflow: input.workflow, outcome: input.outcome }; break;
    }
    default: throw new ActivityValidationError('活动类型无效。');
  }
  if (!Array.isArray(event.refs) || event.refs.length > 50) throw new ActivityValidationError('活动引用数量无效。');
  const delivery = object(request.delivery, ['deliveryId', 'channel']);
  const refs = event.refs.map(parseActivityReference);
  const origin = channel(event.channel);
  if ((origin === 'web' && !['query.submitted', 'query.selected', 'reader.opened', 'content.visible'].includes(String(event.kind)))
    || (origin === 'cli' && !['query.submitted', 'query.selected', 'content.delivery'].includes(String(event.kind)))
    || (origin === 'progressive-kg' && event.kind !== 'workflow.reported')
    || (origin === 'feishu' && !['query.submitted', 'query.selected', 'content.delivery'].includes(String(event.kind)))
    || (event.kind === 'content.delivery' && ((origin === 'cli' && payload.medium !== 'cli-result') || (origin === 'feishu' && payload.medium === 'cli-result')))) {
    throw new ActivityValidationError('活动种类与来源渠道不一致。');
  }
  if ((event.kind === 'query.submitted' && (refs.some((ref) => ref.scope !== 'result') || refs.length > Number(payload.resultCount)))
    || (event.kind === 'query.selected' && (refs.length !== 1 || refs[0].scope !== 'result'))
    || (event.kind === 'reader.opened' && (refs.length !== 1 || refs[0].scope !== payload.section))
    || (event.kind === 'content.visible' && (refs.length < 1 || refs.length > 50 || refs.some((ref) => ref.scope !== 'block')))
    || (event.kind === 'workflow.reported' && refs.length !== 0)
    || (event.kind === 'content.delivery' && (
      (payload.coverage === 'results' && refs.some((ref) => ref.scope !== 'result'))
      || (payload.coverage === 'prompt' && (refs.length !== 1 || refs[0].scope !== 'result'))
      || (['body', 'body-page'].includes(String(payload.coverage)) && (refs.length !== 1 || refs[0].scope !== 'body'))))) {
    throw new ActivityValidationError('活动种类与引用范围不一致。');
  }
  const result: ActivityAppendRequest = { epoch: integer(request.epoch), event: {
    schemaVersion: 1, eventId: id(event.eventId), operationId: id(event.operationId), stepKey: id(event.stepKey, 128),
    occurredAt, actor: { kind: actor.kind }, channel: origin,
    kind: event.kind, refs, payload,
  } as ActivityEvent, delivery: { deliveryId: id(delivery.deliveryId), channel: channel(delivery.channel) } };
  if (new TextEncoder().encode(JSON.stringify(result.event)).length > 65_536) throw new ActivityValidationError('活动事件超过大小上限。');
  return result;
}
