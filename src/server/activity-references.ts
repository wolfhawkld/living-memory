import type { ActivityReference, ActivityReferenceInspection } from '../shared/activity.js';
import type { KnowledgeSource } from './kg.js';
import { ActivityError } from './activity-store.js';
import { getKnowledgeReferences } from './knowledge-references.js';

/** Inspect only the authorized in-memory index; client paths never open files. */
export function inspectActivityReference(source: KnowledgeSource, reference: ActivityReference): ActivityReferenceInspection {
  const concept = source.index.concepts.find((item) => item.id === reference.conceptId);
  if (!concept || concept.source.revision !== reference.sourceRevision || concept.source.path !== reference.path) {
    return { status: 'historical-or-unresolved' };
  }
  if (reference.scope === 'section') {
    const section = getKnowledgeReferences(source, concept.id, concept.source.revision).sections
      .find((item) => item.sectionId === reference.sectionId);
    if (!section || (reference.bodyRange && JSON.stringify(reference.bodyRange) !== JSON.stringify(section.bodyRange))) {
      throw new ActivityError('INVALID_ACTIVITY_REFERENCE', '章节引用与当前资料不一致。');
    }
  }
  if (reference.scope === 'block') {
    const block = getKnowledgeReferences(source, concept.id, concept.source.revision).blocks?.find((item) =>
      item.blockId === reference.blockId && item.contentPart === reference.contentPart);
    if (!block || block.sectionId !== reference.sectionId || !reference.bodyRange
      || Object.entries(block.bodyRange).some(([key, value]) => reference.bodyRange![key as keyof typeof reference.bodyRange] !== value)) {
      throw new ActivityError('INVALID_ACTIVITY_REFERENCE', '正文块引用与当前资料不一致。');
    }
  }
  return { status: 'current' };
}
