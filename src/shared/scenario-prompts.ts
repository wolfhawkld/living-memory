/** A previously recorded scenario that can be offered as a read-only prompt. */
export interface ScenarioPrompt {
  eventId: string;
  scenario: string;
  observedAt: string;
}

export interface ScenarioPromptsResponse {
  sourceId: string;
  asOf: string;
  items: ScenarioPrompt[];
  total: number;
  nextCursor: string | null;
}

/** Client-facing compatibility name used by the scenario practice panel. */
export type ScenarioPrompts = ScenarioPromptsResponse;
