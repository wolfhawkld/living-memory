import { createHash } from 'node:crypto';
import { parseActivityAppendRequest, type ActivityAppendRequest, type ActivityAppendResult, type ActivityReference, type ActivitySettings } from '../shared/activity.js';
import type { FeishuDeliveryResult } from '../shared/feishu-reading.js';
import type { Concept } from '../shared/types.js';

export interface FeishuActivityCoverage {
  coverage: 'results' | 'body-page' | 'prompt';
  refs: ActivityReference[];
  page?: number;
  pageCount?: number;
  request?: { kind: 'query'; resultCount: number } | { kind: 'selected' };
}
export interface FeishuActivityDiagnostic {
  status: 'recorded' | 'skipped' | 'failed';
  code: 'ACTIVITY_RECORDED' | 'ACTIVITY_NO_REQUEST_FACT' | 'ACTIVITY_NOT_ENABLED' | 'ACTIVITY_NOT_AUTHORIZED' | 'ACTIVITY_UNAVAILABLE';
}
export function feishuActivityReference(concept: Concept, scope: 'result' | 'body'): ActivityReference {
  return { conceptId: concept.id, sourceRevision: concept.source.revision, path: concept.source.path,
    title: concept.title.slice(0, 500), scope };
}
function fixedId(operationId: string, stage: string): string {
  return `feishu_activity_${createHash('sha256').update(JSON.stringify([operationId, stage])).digest('hex')}`;
}

/** Request facts and transport acceptance are distinct; neither asserts reading. */
export function prepareFeishuActivity(options: {
  operationId: string;
  occurredAt: string;
  settings: ActivitySettings;
  medium: 'feishu-text' | 'feishu-card';
  coverage: FeishuActivityCoverage | null | undefined;
  append: (request: ActivityAppendRequest) => ActivityAppendResult | void;
  now?: () => string | Date;
  stillAuthorized: () => boolean;
}): { settle: (outcome: FeishuDeliveryResult) => FeishuActivityDiagnostic; diagnostic: FeishuActivityDiagnostic } {
  const settings = { ...options.settings };
  const { operationId, occurredAt, medium, append: appendRequest, stillAuthorized } = options;
  const now = options.now ?? (() => new Date());
  const diagnostic: FeishuActivityDiagnostic = { status: 'skipped', code: 'ACTIVITY_NOT_ENABLED' };
  let coverage: FeishuActivityCoverage | null = null;
  let settled: ActivityAppendRequest | null = null;
  const authorized = () => { try { return stillAuthorized(); } catch { return false; } };
  function envelope(stage: string, event: Pick<ActivityAppendRequest['event'], 'kind' | 'refs' | 'payload'>, at = occurredAt): ActivityAppendRequest {
    return parseActivityAppendRequest({ epoch: settings.epoch, event: {
      schemaVersion: 1, eventId: fixedId(operationId, stage), operationId, stepKey: stage,
      occurredAt: at, actor: { kind: 'user' }, channel: 'feishu', ...event,
    }, delivery: { deliveryId: fixedId(operationId, `${stage}:delivery`), channel: 'feishu' } });
  }
  function append(request: ActivityAppendRequest): FeishuActivityDiagnostic {
    try { appendRequest(parseActivityAppendRequest(request)); return { status: 'recorded', code: 'ACTIVITY_RECORDED' }; }
    catch { return { status: 'failed', code: 'ACTIVITY_UNAVAILABLE' }; }
  }
  if (settings.enabled && options.coverage) {
    try {
      if (!authorized()) Object.assign(diagnostic, { status: 'skipped', code: 'ACTIVITY_NOT_AUTHORIZED' });
      else {
        coverage = structuredClone(options.coverage);
        // Validate delivery shape now, before any request fact can be appended.
        envelope('delivery', { kind: 'content.delivery', refs: coverage.refs,
          payload: { medium, outcome: 'failed-or-unknown', coverage: coverage.coverage,
            ...(coverage.page !== undefined ? { page: coverage.page } : {}), ...(coverage.pageCount !== undefined ? { pageCount: coverage.pageCount } : {}) } });
        Object.assign(diagnostic, { status: 'skipped', code: 'ACTIVITY_NO_REQUEST_FACT' });
        if (coverage.request?.kind === 'query') Object.assign(diagnostic, append(envelope('query', {
          kind: 'query.submitted', refs: coverage.refs, payload: { resultCount: coverage.request.resultCount },
        })));
        else if (coverage.request?.kind === 'selected') Object.assign(diagnostic, append(envelope('selected', {
          kind: 'query.selected', refs: coverage.refs.map((ref) => ({ conceptId: ref.conceptId, sourceRevision: ref.sourceRevision,
            path: ref.path, ...(ref.title !== undefined ? { title: ref.title } : {}), scope: 'result' })), payload: {},
        })));
      }
    } catch { coverage = null; Object.assign(diagnostic, { status: 'failed', code: 'ACTIVITY_UNAVAILABLE' }); }
  }
  return { diagnostic, settle(outcome) {
    if (!coverage || !settings.enabled) return diagnostic;
    if (!authorized()) return { status: 'skipped', code: 'ACTIVITY_NOT_AUTHORIZED' };
    try {
      if (!settled) {
        const instant = now();
        settled = envelope('delivery', { kind: 'content.delivery', refs: coverage.refs, payload: {
        medium, outcome, coverage: coverage.coverage,
        ...(coverage.page !== undefined ? { page: coverage.page } : {}), ...(coverage.pageCount !== undefined ? { pageCount: coverage.pageCount } : {}),
      } }, instant instanceof Date ? instant.toISOString() : instant);
      }
      return append(settled);
    } catch { return { status: 'failed', code: 'ACTIVITY_UNAVAILABLE' }; }
  } };
}
