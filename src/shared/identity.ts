import type { ConceptReviewPreference } from './review-plan';

export interface IdentityCounts {
  anchors: number;
  observations: number;
  retentions: number;
  applications: number;
  /** Optional for backward-compatible status payloads with no private practice history. */
  practiceCards?: number;
  practiceAttempts?: number;
}
export interface IdentityConcept {
  conceptId: string;
  title: string;
  path: string | null;
  sourceRevision: string | null;
  counts: IdentityCounts;
  hasLayout: boolean;
  preference: ConceptReviewPreference | null;
}
/** A person-confirmed path association. Learning event payloads remain immutable. */
export interface IdentityBinding {
  operationId: string;
  rawConceptId: string;
  conceptId: string;
  fromPath: string | null;
  toPath: string;
  sourceRevision: string;
  confirmedAt: string;
  backupId: string;
}
export interface IdentityStatus {
  sourceId: string;
  orphans: IdentityConcept[];
  targets: IdentityConcept[];
  bindings: IdentityBinding[];
}
export interface IdentityLinkRequest { fromConceptId: string; toConceptId: string }
export interface IdentityLinkPreview {
  sourceId: string;
  token: string;
  canLink: boolean;
  from: IdentityConcept;
  to: IdentityConcept;
  revisionMatches: boolean;
  issues: Array<{ severity: 'warning' | 'error'; code: string; message: string }>;
  layoutAction: 'keep-original' | 'adopt-target' | 'none';
}
export interface IdentityLinkCommit extends IdentityLinkRequest { operationId: string; previewToken: string; confirmed: true }
export interface IdentityLinkReceipt {
  status: 'accepted' | 'duplicate';
  operationId: string;
  sourceId: string;
  conceptId: string;
  linkedPath: string;
  confirmedAt: string;
  backupId: string;
}
