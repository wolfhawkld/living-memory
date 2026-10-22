import type { ExportDataV2 } from './types.js';
import type { PrivacyObservation } from './answer-clearing.js';

/** Portable JSON only; deliberately not part of the product's v1/v2 ExportData union yet. */
export type ExportDataV3 = Omit<ExportDataV2, 'schemaVersion' | 'observations'> & {
  schemaVersion: 3;
  observations: PrivacyObservation[];
};
export type AnswerClearingImportErrorCode = 'INVALID_IMPORT_DATA' | 'INVALID_IMPORT_CURRENT' | 'ANSWER_CLEARED'
  | 'LOCAL_CLEARING_REQUIRED' | 'CLEARING_CONFLICT' | 'IMPORT_STALE' | 'IMPORT_REJECTED';
export class AnswerClearingImportError extends Error {
  constructor(readonly code: AnswerClearingImportErrorCode) { super(code); this.name = 'AnswerClearingImportError'; }
}
