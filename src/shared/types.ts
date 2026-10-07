export const MODEL_VERSION = 'time-only-v0' as const;
export const DAY_MS = 86_400_000;

export interface ModelConfig {
  modelVersion: typeof MODEL_VERSION;
  halfLifeDays: number;
  revision: number;
}

/** The acknowledged transition can be older than the currently active config. */
export interface ConfigWriteReceipt extends ModelConfig {
  status: 'accepted' | 'duplicate';
  currentConfig: ModelConfig;
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
  /** True when this scenario deliberately reuses a previously recorded prompt. */
  scenarioRevisit?: true;
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
  scenario: { total: number; independentSuccess: number; assisted: number; partial: number; failure: number; unverified: number; revisited?: number };
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
export type ObservationEvidenceMode = 'mental' | 'written';

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
  /** Explicit answer medium; absent on legacy observations. */
  evidenceMode?: ObservationEvidenceMode;
  rating: RecallRating;
  exposure: Exposure;
  observedExposure: boolean;
  learning?: LearningEvidence;
}

/** Private work/summary evidence, independent of recall scores and memory anchors. */
export interface RelationSuggestionEndpoint {
  conceptId: string;
  sourceRevision: string;
  title: string;
  path: string;
}

export interface RelationSuggestionValue { type: string; description: string }

export type RelationSuggestion = {
  source: RelationSuggestionEndpoint;
  target: RelationSuggestionEndpoint;
} & (
  | { operation: 'add'; after: RelationSuggestionValue }
  | { operation: 'change'; before: RelationSuggestionValue; after: RelationSuggestionValue }
  | { operation: 'remove'; before: RelationSuggestionValue }
);

export interface ApplicationRecordRequest {
  relationSuggestion?: RelationSuggestion;
  eventId: string;
  conceptId: string;
  sourceRevision: string;
  occurredAt: string;
  kind: 'application' | 'summary';
  context: string;
  content: string;
  outcome: 'success' | 'partial' | 'failure' | 'unverified';
  assistance: 'independent' | 'resources' | 'people-or-ai' | 'mixed' | 'unknown';
  result: string;
  limitations: string;
  insight: string;
  correction: string;
  references: string;
}

export interface ApplicationRecord extends ApplicationRecordRequest { recordedAt: string }

export type ConceptHistoryEntry =
  | { type: 'anchor'; event: AnchorEvent }
  | { type: 'retention'; event: RetentionEvent }
  | { type: 'application'; event: ApplicationRecord }
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
  /** Latest two observations per task across the concept's complete history. */
  progress?: import('./learning-progress.js').LearningProgress;
  /** Decisions for application entries on this page. Each list is bounded. */
  corrections?: Record<string, import('./corrections.js').CorrectionHistory>;
  /** When present, entries contains only the requested application/summary. */
  focusedApplicationEventId?: string;
  /** Append-only decision watermark across all pages of this concept. */
  correctionCount?: number;
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
  /** Explicit answer medium; absent on legacy observations. */
  evidenceMode?: ObservationEvidenceMode;
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
  reason: 'connected' | 'source' | 'review' | 'observation' | 'config' | 'retention' | 'application' | 'correction' | 'review-plan' | 'import' | 'identity' | 'practice';
}

export interface LayoutPosition { x: number; y: number; z: number }
export type Layout = Record<string, LayoutPosition>;

export interface ExportData {
  /** Audit only; JSON restore maps current paths/versions rather than trusting uploaded bindings. */
  identityBindings?: import('./identity.js').IdentityBinding[];
  schemaVersion: 1;
  exportedAt: string;
  source: KnowledgeGraph['source'];
  concepts: Array<Pick<Concept, 'id' | 'title' | 'source'>>;
  config: ModelConfig;
  configHistory: ModelConfig[];
  anchors: AnchorEvent[];
  observations: Observation[];
  retentions?: RetentionEvent[];
  applications?: ApplicationRecord[];
  corrections?: import('./corrections.js').CorrectionEvent[];
  /** Versioned private questions and answers; independent of concept recall scores. */
  practice?: import('./practice.js').PracticeData;
  reviewPlan?: import('./review-plan.js').ReviewPlan;
  layout: Layout;
  /** Optional v1 additions for portable recovery; no account credentials or absolute root paths. */
  restoreMetadata?: {
    sourceId: string;
    anchorRequests: ReviewRequest[];
    configRecordedAt: Record<string, string>;
  };
}
