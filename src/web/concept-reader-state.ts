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

/** Metadata may never locate a chapter in a different revision of the material. */
export function referencesMatchConcept(references: { conceptId: string; sourceRevision: string } | null,
  concept: Concept): boolean {
  return Boolean(references && references.conceptId === concept.id && references.sourceRevision === concept.source.revision);
}

export function sectionNavigationMessage(status: string): string {
  const messages: Record<string, string> = {
    'missing-concept': '引用的知识暂未找到，可以继续阅读当前全文。',
    ambiguous: '引用存在多个匹配项，暂不能确定目标。可以继续阅读全文。',
    'missing-section': '引用章节已变化或不存在，已保留全文阅读入口。',
    'unsupported-block': '暂不支持 ^ 块引用定位，可以阅读全文。',
    unsafe: '此引用不属于允许的知识路径，未打开本地文件。',
  };
  return messages[status] ?? '章节暂时无法定位，可以继续阅读全文。';
}
