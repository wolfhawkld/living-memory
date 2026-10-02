import type { Observation } from '../shared/types.js';
import type { ScenarioPrompt } from '../shared/scenario-prompts.js';

/** Internal row used to preserve the stable keyset ordering without exposing private fields. */
export interface ScenarioPromptCandidate extends ScenarioPrompt {
  conceptId: string;
  recordedAt: string;
}

export interface ScenarioPromptCursor {
  observedAt: string;
  recordedAt: string;
  eventId: string;
}

export interface ScenarioPromptPage {
  items: ScenarioPrompt[];
  total: number;
  hasMore: boolean;
  last: ScenarioPromptCursor | null;
}

function compareDescending(left: ScenarioPromptCandidate, right: ScenarioPromptCandidate): number {
  const observed = Date.parse(right.observedAt) - Date.parse(left.observedAt);
  if (observed !== 0) return observed;
  const recorded = Date.parse(right.recordedAt) - Date.parse(left.recordedAt);
  if (recorded !== 0) return recorded;
  return right.eventId < left.eventId ? -1 : right.eventId > left.eventId ? 1 : 0;
}

function isAfterCursor(item: ScenarioPromptCandidate, cursor: ScenarioPromptCursor): boolean {
  const observed = Date.parse(item.observedAt) - Date.parse(cursor.observedAt);
  if (observed !== 0) return observed < 0;
  const recorded = Date.parse(item.recordedAt) - Date.parse(cursor.recordedAt);
  if (recorded !== 0) return recorded < 0;
  return item.eventId < cursor.eventId;
}

/**
 * Select previously saved scenario observations for the current source index.
 * Historical source revisions remain eligible so a learner can revisit the
 * current material after a note changes. The function is pure and never
 * changes learning state or exposes answer/checking fields.
 */
export function buildScenarioPromptPage(
  observations: readonly Observation[],
  conceptIds: ReadonlySet<string>,
  limit: number,
  cursor?: ScenarioPromptCursor,
): ScenarioPromptPage {
  const candidates: ScenarioPromptCandidate[] = observations
    .filter((observation) => conceptIds.has(observation.conceptId))
    .flatMap((observation) => {
      const learning = observation.learning;
      if (learning?.task !== 'scenario' || !learning.scenario) return [];
      return [{
        eventId: observation.eventId,
        conceptId: observation.conceptId,
        scenario: learning.scenario,
        observedAt: observation.observedAt,
        recordedAt: observation.recordedAt,
      }];
    })
    .sort(compareDescending);
  const eligible = cursor ? candidates.filter((candidate) => isAfterCursor(candidate, cursor)) : candidates;
  const page = eligible.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(({ eventId, scenario, observedAt }) => ({ eventId, scenario, observedAt })),
    total: candidates.length,
    hasMore: eligible.length > page.length,
    last: last ? { observedAt: last.observedAt, recordedAt: last.recordedAt, eventId: last.eventId } : null,
  };
}
