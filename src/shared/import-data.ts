import type { ModelConfig } from './types';

export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
export interface ImportOptions { restoreLayout: boolean; restoreReviewPlan: boolean }
export const DEFAULT_IMPORT_OPTIONS: ImportOptions = { restoreLayout: false, restoreReviewPlan: false };
export type ImportEventKind = 'anchors' | 'observations' | 'retentions' | 'applications' | 'corrections';
export interface ImportIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  eventId?: string;
  conceptId?: string;
}
export interface ImportConceptMatch {
  fromId: string;
  toId: string | null;
  title: string;
  path: string;
  backupRevision: string | null;
  currentRevision: string | null;
  match: 'id' | 'path-revision' | 'unresolved';
}
export interface ImportCounts {
  added: Record<ImportEventKind, number>;
  duplicates: number;
  configurations: number;
  matchedConcepts: number;
  remappedConcepts: number;
  unresolvedConcepts: number;
  /** Present only when the backup contains the additive practice section. */
  practiceCards?: number;
  practiceAttempts?: number;
}
export interface ImportPreview {
  sourceId: string;
  token: string;
  canImport: boolean;
  exportedAt: string;
  counts: ImportCounts;
  matches: ImportConceptMatch[];
  issues: ImportIssue[];
  issueCount: number;
  config: { before: ModelConfig; after: ModelConfig };
  layoutChanged: boolean;
  reviewPlanChanged: boolean;
  options: ImportOptions;
}
export interface ImportPreviewRequest { data: unknown; options: ImportOptions }
export interface ImportCommitRequest extends ImportPreviewRequest {
  importId: string;
  previewToken: string;
  /** The person has reviewed the preview, including mapping and orphan warnings. */
  confirmed: true;
}
export interface ImportReceipt {
  status: 'accepted' | 'duplicate';
  importId: string;
  sourceId: string;
  importedAt: string;
  counts: ImportCounts;
  backupId: string;
}
