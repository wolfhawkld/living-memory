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

export type MemoryStatus = 'unknown' | 'recent' | 'revisit' | 'stale' | 'pending';

export interface MemoryState {
  conceptId: string;
  status: MemoryStatus;
  decay: number | null;
  elapsedDays: number | null;
  anchor: AnchorEvent | null;
  reason: string | null;
  asOf: string;
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
}

export interface WriteReceipt {
  status: 'accepted' | 'duplicate';
  eventId: string;
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
  layout: Layout;
}
