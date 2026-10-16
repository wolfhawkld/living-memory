import type { ActivityRecord } from '../shared/activity.js';
import type { ActivityReferenceCurrentStatus } from '../shared/activity-reference-status.js';
import type { BodyRange } from '../shared/knowledge-references.js';
import type { KnowledgeSource } from './kg.js';
import { getKnowledgeReferences } from './knowledge-references.js';

function sameRange(left: BodyRange | undefined, right: BodyRange | undefined): boolean {
  return Boolean(left && right && left.coordinateSpace === right.coordinateSpace
    && left.startOffset === right.startOffset && left.endOffset === right.endOffset
    && left.startLine === right.startLine && left.endLine === right.endLine);
}

/** Reinspect against an already-authorized index; never rewrite frozen evidence. */
export function inspectRecordedActivityReferences(record: ActivityRecord, source: KnowledgeSource): ActivityReferenceCurrentStatus[] {
  const concepts = new Map(source.index.concepts.map((concept) => [concept.id, concept]));
  return record.event.refs.map((reference, refIndex): ActivityReferenceCurrentStatus => {
    const concept = concepts.get(reference.conceptId);
    if (!concept) return { refIndex, status: 'missing-concept', revisionChanged: false, pathChanged: false };
    const revisionChanged = reference.sourceRevision !== concept.source.revision;
    const pathChanged = reference.path !== concept.source.path;
    const base = { refIndex, revisionChanged, pathChanged, current: {
      conceptId: concept.id, title: concept.title, path: concept.source.path, sourceRevision: concept.source.revision,
    } };
    if (revisionChanged) return { ...base, status: 'source-changed' };
    if (pathChanged) return { ...base, status: 'source-moved' };
    if (reference.scope === 'result' || reference.scope === 'summary' || reference.scope === 'body') return { ...base, status: 'current' };
    // Parsing failures intentionally propagate: unavailable inspection must not
    // masquerade as a known missing location or silently relocate old content.
    const catalog = getKnowledgeReferences(source, concept.id, concept.source.revision);
    if (reference.scope === 'section') {
      const section = catalog.sections.find((entry) => entry.sectionId === reference.sectionId);
      const matches = section && (!reference.bodyRange || sameRange(reference.bodyRange, section.bodyRange));
      return { ...base, status: matches ? 'current' : 'location-unresolved' };
    }
    const block = catalog.blocks?.find((entry) => entry.blockId === reference.blockId && entry.contentPart === reference.contentPart);
    const matches = block && block.sectionId === reference.sectionId && sameRange(reference.bodyRange, block.bodyRange);
    return { ...base, status: matches ? 'current' : 'location-unresolved' };
  });
}
