export const MODEL_VERSION = 'time-only-v0' as const;
export const DAY_MS = 86_400_000;

export interface ModelConfig {
  modelVersion: typeof MODEL_VERSION;
  halfLifeDays: number;
  revision: number;
}

export interface Concept {
  id: string;
  title: string;
  aliases: string[];
  domain: string;
  summary: string;
  body: string;
  source: { path: string; revision: string };
}

export interface GraphLink {
  id: string;
  source: string;
  target: string;
  type: string;
  description: string;
}

export interface AnchorEvent {
  eventId: string;
  conceptId: string;
  sourceRevision: string;
  occurredAt: string;
  recordedAt: string;
  kind: 'review' | 'estimated';
}

export type MemoryStatus = 'unknown' | 'recent' | 'revisit' | 'stale' | 'pending' | 'retained';

export interface RetentionRequest {
  eventId: string;
  conceptId: string;
  sourceRevision: string;
  occurredAt: string;
  active: boolean;
  previousEventId: string | null;
}

export interface RetentionEvent extends RetentionRequest { recordedAt: string }

/** User-reported evidence; confidence is captured before the answer is submitted. */
export interface LearningEvidence {
  task: 'concept' | 'scenario';
  scenario?: string;
  applicability?: string;
  /** Percentage, integer 0..100; null means no prospective prediction. */
  confidence: number | null;
  confidenceAt: string | null;
  cue: 'independent' | 'hinted' | 'lookup' | 'unknown';
  outcome: 'success' | 'partial' | 'failure' | 'unverified';
  basis: 'self-check' | 'application' | 'unknown';
}

export interface CalibrationSummary {
  count: number;
  meanConfidence: number | null;
  successRate: number | null;
  gap: number | null;
  brier: number | null;
}

export interface LearningSummary {
  scenario: { total: number; independentSuccess: number; assisted: number; partial: number; failure: number; unverified: number };
  calibration: { concept: CalibrationSummary; scenario: CalibrationSummary };
}

export interface MemoryState {
  conceptId: string;
  status: MemoryStatus;
  decay: number | null;
  elapsedDays: number | null;
  anchor: AnchorEvent | null;
  reason: string | null;
  asOf: string;
  retention?: RetentionEvent | null;
}

export type RecallRating = 'clear' | 'partial' | 'blank';
export type Exposure = 'unexposed' | 'exposed' | 'unknown';

export interface Observation {
  eventId: string;
  conceptId: string;
  sourceRevision: string;
  observedAt: string;
  recordedAt: string;
  configRevision: number;
  halfLifeDays: number;
  anchorEventId: string | null;
  elapsedDays: number | null;
  decay: number | null;
  answer: string;
  rating: RecallRating;
  exposure: Exposure;
  observedExposure: boolean;
  learning?: LearningEvidence;
}

export type ConceptHistoryEntry =
  | { type: 'anchor'; event: AnchorEvent }
  | { type: 'retention'; event: RetentionEvent }
  | { type: 'observation'; event: Observation };

/** Real persisted history, ordered by event time, recorded time, then event ID descending. */
export interface ConceptHistory {
  sourceId: string;
  conceptId: string;
  sourceRevision: string;
  asOf: string;
  state: MemoryState;
  entries: ConceptHistoryEntry[];
  total: number;
  nextCursor: string | null;
  learning?: LearningSummary;
}

export interface KnowledgeGraph {
  concepts: Concept[];
  links: GraphLink[];
  source: {
    name: string;
    mode: 'demo' | 'local';
    conceptCount: number;
    limit: number;
    diagnostics: string[];
    /** The first directory selected by the configured source prefix, if any. */
    initialDomainId?: string;
  };
}

export interface Snapshot extends KnowledgeGraph {
  config: ModelConfig;
  states: Record<string, MemoryState>;
  asOf: string;
  observationsCount: number;
}

export interface ReviewRequest {
  eventId: string;
  conceptId: string;
  sourceRevision: string;
  kind: 'review' | 'estimated';
  occurredAt?: string; // Freeze on confirmation for retries; server validates, or uses now if omitted.
}

export interface ObservationRequest {
  eventId: string;
  conceptId: string;
  sourceRevision: string;
  observedAt: string; // Freeze on answer submission, before showing source.
  configRevision: number;
  anchorEventId: string | null;
  answer: string;
  rating: RecallRating;
  exposure: Exposure;
  observedExposure: boolean;
  learning?: LearningEvidence;
}

export interface WriteReceipt {
  status: 'accepted' | 'duplicate';
  eventId: string;
}

/** Invalidation only: clients re-read the shared projection, never apply deltas. */
export interface ChangeNotification {
  sourceId: string;
  revision: number;
  reason: 'connected' | 'source' | 'review' | 'observation' | 'config' | 'retention';
}

export interface LayoutPosition { x: number; y: number; z: number }
export type Layout = Record<string, LayoutPosition>;

export interface ExportData {
  schemaVersion: 1;
  exportedAt: string;
  source: KnowledgeGraph['source'];
  concepts: Array<Pick<Concept, 'id' | 'title' | 'source'>>;
  config: ModelConfig;
  configHistory: ModelConfig[];
  anchors: AnchorEvent[];
  observations: Observation[];
  retentions?: RetentionEvent[];
  layout: Layout;
}
