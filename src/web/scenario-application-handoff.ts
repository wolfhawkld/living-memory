import type { Concept, ObservationRequest, Snapshot } from '../shared/types';
import { createApplicationRecordDraft, type ApplicationRecordDraft } from './application-record';

/** A recall check is a summary draft, never proof of a real application. */
export function buildScenarioApplicationDraft(request: ObservationRequest): ApplicationRecordDraft {
  if (request.learning?.task !== 'scenario' || !request.learning.scenario?.trim()) {
    throw new Error('这条记录不是完整的场景观察。');
  }
  return {
    ...createApplicationRecordDraft('summary'),
    context: request.learning.scenario,
    // The frozen original answer may contain mistakes. Keep it in the observation.
    content: request.learning.applicability ?? '',
  };
}

/** Never carry a draft into another account or silently attach it to newer content. */
export function resolveScenarioApplicationConcept(
  request: ObservationRequest,
  sourceAtPractice: string,
  currentSource: string,
  snapshot: Snapshot,
): Concept {
  if (!sourceAtPractice || sourceAtPractice !== currentSource) {
    throw new Error('场景观察已保留，但知识空间已变化，应用 / 总结草稿未打开。请回到原知识空间继续。');
  }
  const concept = snapshot.concepts.find((candidate) => candidate.id === request.conceptId);
  if (!concept || concept.source.revision !== request.sourceRevision) {
    throw new Error('场景观察已保留，但概念资料已变化，应用 / 总结草稿未打开。请保留核对内容，刷新后从节点入口继续。');
  }
  return structuredClone(concept);
}
