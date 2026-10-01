import type { Concept } from '../shared/types';

export type ReaderSection = 'summary' | 'body';
export interface ReaderRequest {
  sourceId: string;
  conceptId: string;
  sourceRevision: string;
  section: ReaderSection;
}

export function canShowConceptReader(request: ReaderRequest | null, sourceId: string, concept: Concept | null,
  recallStage: 'prediction' | 'answer' | 'feedback' | null, sourceReloadPending: boolean): boolean {
  return Boolean(request && concept && !sourceReloadPending && (recallStage === null || recallStage === 'feedback')
    && request.sourceId === sourceId && request.conceptId === concept.id && request.sourceRevision === concept.source.revision);
}

export function relativeSource(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const marker = normalized.toLowerCase().lastIndexOf('progressive-kg/');
  if (marker >= 0) return normalized.slice(marker + 'progressive-kg/'.length);
  const segments = normalized.split('/').filter(Boolean);
  return segments.slice(-3).join(' / ') || '来源路径未知';
}
