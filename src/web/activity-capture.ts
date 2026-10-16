import type { ActivityAppendRequest, ActivityEvent, ActivityReference } from '../shared/activity';
import type { KnowledgeContentBlock } from '../shared/knowledge-references';
import type { Concept } from '../shared/types';

type SourceConcept = Pick<Concept, 'id' | 'title' | 'source'>;
export interface QueryActivityInput { query: string; results: readonly SourceConcept[]; resultCount: number; saveQueryText: boolean }
export interface ReaderOpenedFact { conceptId: string; sourceRevision: string; contentPart: 'summary' | 'body'; requestedSectionId?: string }
export interface ContentVisibleFact extends Omit<ReaderOpenedFact, 'requestedSectionId'> { blocks: KnowledgeContentBlock[] }
export interface CaptureContext { scopeKey: string; epoch: number; enabled: boolean }

/** Turns explicit gestures and verified viewport facts into immutable requests. */
export function createActivityCapture(options: {
  emit: (request: ActivityAppendRequest, context: CaptureContext) => void;
  now?: () => string; id?: () => string;
  schedule?: (callback: () => void) => unknown; cancel?: (handle: unknown) => void;
}) {
  const now = options.now ?? (() => new Date().toISOString());
  const id = options.id ?? (() => `activity_${crypto.randomUUID()}`);
  const schedule = options.schedule ?? ((callback) => setTimeout(callback, 250));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let context: CaptureContext | null = null;
  const queries = new Set<string>();
  let reading: { operationId: string; seen: Set<string>; opened: Set<string>; sequence: number } | null = null;
  let batch: { refs: ActivityReference[]; occurredAt: string; handle?: unknown } | null = null;
  const reference = (concept: SourceConcept, scope: ActivityReference['scope']): ActivityReference => ({
    conceptId: concept.id, title: concept.title, sourceRevision: concept.source.revision, path: concept.source.path, scope,
  });
  function emit(event: ActivityEvent) {
    if (!context?.enabled) return;
    options.emit({ epoch: context.epoch, event, delivery: { deliveryId: id(), channel: 'web' } }, { ...context });
  }
  function base(operationId: string, stepKey: string, occurredAt = now()) {
    return { schemaVersion: 1 as const, eventId: id(), operationId, stepKey, occurredAt,
      actor: { kind: 'user' as const }, channel: 'web' as const };
  }
  function flushVisible() {
    const pending = batch; batch = null;
    if (pending?.handle !== undefined) cancel(pending.handle);
    if (pending && reading && context?.enabled) emit({ ...base(reading.operationId, `visible:${++reading.sequence}`, pending.occurredAt),
      kind: 'content.visible', refs: pending.refs, payload: {} });
  }
  function stop(discard: boolean) {
    if (discard) { if (batch?.handle !== undefined) cancel(batch.handle); batch = null; }
    else flushVisible();
    reading = null;
  }
  return {
    setContext(next: CaptureContext | null) {
      if (JSON.stringify(next) !== JSON.stringify(context)) { stop(true); queries.clear(); }
      context = next ? { ...next } : null;
    },
    cancel() { stop(true); queries.clear(); },
    beginReading() { stop(false); reading = context?.enabled ? { operationId: id(), seen: new Set(), opened: new Set(), sequence: 0 } : null; },
    endReading() { stop(false); },
    query(input: QueryActivityInput, selected?: SourceConcept, submittedOperationId?: string) {
      if (!context?.enabled) return;
      const prior = submittedOperationId && queries.has(submittedOperationId);
      const operationId = prior ? submittedOperationId : id();
      const query = input.saveQueryText && input.query.length <= 1000 ? { queryText: input.query, queryTextSavedByUser: true as const } : {};
      if (!prior) emit({ ...base(operationId, 'submitted'), kind: 'query.submitted', refs: input.results.slice(0, 50).map((item) => reference(item, 'result')),
        payload: { resultCount: input.resultCount, ...query } });
      if (selected) emit({ ...base(operationId, 'selected'), kind: 'query.selected', refs: [reference(selected, 'result')], payload: query });
      queries.add(operationId);
      if (queries.size > 20) queries.delete(queries.values().next().value!);
      return operationId;
    },
    opened(fact: ReaderOpenedFact, concept: SourceConcept) {
      if (!reading || !context?.enabled || concept.id !== fact.conceptId || concept.source.revision !== fact.sourceRevision) return;
      const key = JSON.stringify([fact.conceptId, fact.sourceRevision, fact.contentPart]);
      if (reading.opened.has(key)) return;
      reading.opened.add(key);
      emit({ ...base(reading.operationId, `opened:${++reading.sequence}`), kind: 'reader.opened', refs: [reference(concept, fact.contentPart)],
        payload: { section: fact.contentPart, ...(fact.requestedSectionId ? { requestedSectionId: fact.requestedSectionId } : {}) } });
    },
    visible(fact: ContentVisibleFact, concept: SourceConcept) {
      if (!reading || !context?.enabled || concept.id !== fact.conceptId || concept.source.revision !== fact.sourceRevision) return;
      for (const block of fact.blocks) {
        if (block.contentPart !== fact.contentPart) continue;
        const key = JSON.stringify([concept.id, concept.source.revision, block.contentPart, block.blockId]);
        if (reading.seen.has(key)) continue;
        reading.seen.add(key);
        if (!batch) { batch = { refs: [], occurredAt: now() }; batch.handle = schedule(flushVisible); }
        batch.refs.push({ ...reference(concept, 'block'), blockId: block.blockId, contentPart: block.contentPart,
          bodyRange: { ...block.bodyRange }, ...(block.sectionId ? { sectionId: block.sectionId } : {}) });
        if (batch.refs.length === 50) flushVisible();
      }
    },
  };
}
