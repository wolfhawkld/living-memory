import type { ApplicationRecordRequest, Concept, GraphLink, RelationSuggestion, RelationSuggestionValue } from '../shared/types';
import { parseRelationSuggestion } from '../shared/relation-suggestions.js';

export const APPLICATION_CONTENT_MAX_LENGTH = 12_000;
export const APPLICATION_TEXT_MAX_LENGTH = 4_000;

export const APPLICATION_KINDS = ['application', 'summary'] as const;
export type ApplicationRecordKind = (typeof APPLICATION_KINDS)[number];

export const APPLICATION_OUTCOMES = ['success', 'partial', 'failure', 'unverified'] as const;
export type ApplicationRecordOutcome = (typeof APPLICATION_OUTCOMES)[number];

export const APPLICATION_ASSISTANCE = ['independent', 'resources', 'people-or-ai', 'mixed', 'unknown'] as const;
export type ApplicationRecordAssistance = (typeof APPLICATION_ASSISTANCE)[number];

/** Fields that may be deliberately copied into material for the external KG workflow. */
export const APPLICATION_MATERIAL_FIELDS = [
  'context',
  'content',
  'result',
  'limitations',
  'insight',
  'correction',
  'references',
  'relationSuggestion',
] as const;
export type ApplicationMaterialField = (typeof APPLICATION_MATERIAL_FIELDS)[number];

export const APPLICATION_MATERIAL_LABELS: Record<ApplicationMaterialField, string> = {
  context: '应用场景 / 主题',
  content: '自己的解释 / 总结',
  result: '结果',
  limitations: '限制与未解决问题',
  insight: '新的 insight',
  correction: '需要修正的理解',
  references: '参考资料与线索',
  relationSuggestion: '关系建议（待核对）',
};

export const APPLICATION_KIND_LABELS: Record<ApplicationRecordKind, string> = {
  application: '实际应用',
  summary: '学习总结',
};

export const APPLICATION_OUTCOME_LABELS: Record<ApplicationRecordOutcome, string> = {
  success: '达到预期',
  partial: '部分达到',
  failure: '没有达到',
  unverified: '暂不判断',
};

export const APPLICATION_ASSISTANCE_LABELS: Record<ApplicationRecordAssistance, string> = {
  independent: '独立完成',
  resources: '查阅资料后完成',
  'people-or-ai': '借助他人或 AI',
  mixed: '多种方式共同完成',
  unknown: '不确定',
};

export interface ApplicationRecordDraft {
  kind: ApplicationRecordKind;
  context: string;
  content: string;
  outcome: ApplicationRecordOutcome;
  assistance: ApplicationRecordAssistance;
  result: string;
  limitations: string;
  insight: string;
  correction: string;
  references: string;
  relationSuggestion?: RelationSuggestionDraft;
}

export interface RelationSuggestionDraft {
  enabled: boolean;
  operation: 'add' | 'change' | 'remove';
  direction: 'outgoing' | 'incoming';
  otherConceptId: string;
  before: RelationSuggestionValue | null;
  after: RelationSuggestionValue;
}

export const RELATION_OPERATION_LABELS = { add: '新增关系', change: '修改关系', remove: '移除关系' } as const;

export function createRelationSuggestionDraft(): RelationSuggestionDraft {
  return { enabled: false, operation: 'add', direction: 'outgoing', otherConceptId: '', before: null, after: { type: '', description: '' } };
}

export function directedSuggestionLinks(conceptId: string, draft: RelationSuggestionDraft, links: readonly GraphLink[]): GraphLink[] {
  const source = draft.direction === 'outgoing' ? conceptId : draft.otherConceptId;
  const target = draft.direction === 'outgoing' ? draft.otherConceptId : conceptId;
  return links.filter((link) => link.source === source && link.target === target);
}

export function buildRelationSuggestion(
  concept: Pick<Concept, 'id' | 'source'> & Partial<Pick<Concept, 'title'>>,
  draft: RelationSuggestionDraft | undefined,
  concepts: readonly Concept[],
  links: readonly GraphLink[],
): RelationSuggestion | undefined {
  if (!draft?.enabled) return undefined;
  const other = concepts.find((candidate) => candidate.id === draft.otherConceptId && candidate.id !== concept.id);
  if (!other) throw new Error('关系建议需要选择第二个概念。');
  if (draft.direction !== 'outgoing' && draft.direction !== 'incoming') throw new Error('关系建议方向无效。');
  const current = { conceptId: concept.id, sourceRevision: concept.source.revision, title: concept.title, path: concept.source.path };
  const counterpart = { conceptId: other.id, sourceRevision: other.source.revision, title: other.title, path: other.source.path };
  const source = draft.direction === 'outgoing' ? current : counterpart;
  const target = draft.direction === 'outgoing' ? counterpart : current;
  const existing = directedSuggestionLinks(concept.id, draft, links);
  if (draft.operation !== 'add' && !existing.some((link) => (
    draft.before && link.type === draft.before.type && link.description === draft.before.description
  ))) throw new Error('请为关系建议选择该方向现有的原关系。');
  const value = draft.operation === 'add'
    ? { operation: draft.operation, source, target, after: draft.after }
    : draft.operation === 'change'
      ? { operation: draft.operation, source, target, before: draft.before, after: draft.after }
      : { operation: draft.operation, source, target, before: draft.before };
  const suggestion = parseRelationSuggestion(value, { conceptId: concept.id, sourceRevision: concept.source.revision });
  if (suggestion.operation !== 'remove' && existing.some((link) => (
    link.type === suggestion.after.type && link.description === suggestion.after.description
  ))) throw new Error('该方向已有相同类型和描述的关系，请核对关系建议。');
  return suggestion;
}

export function relationSuggestionMaterial(suggestion: RelationSuggestion): string {
  const endpoint = (name: string, value: RelationSuggestion['source']) => [
    `- ${name}：${value.title}`, `  - ID：${value.conceptId}`, `  - 路径：${value.path}`, `  - 版本：${value.sourceRevision}`,
  ];
  const lines = [
    '待核对建议，尚未验证采纳。',
    '记录时快照，整理前核对当前知识源。',
    `- 操作：${RELATION_OPERATION_LABELS[suggestion.operation]}`,
    `- 方向：${suggestion.source.title} → ${suggestion.target.title}`,
    ...endpoint('源概念', suggestion.source), ...endpoint('目标概念', suggestion.target),
  ];
  if (suggestion.operation !== 'add') lines.push(`- 原关系类型：${suggestion.before.type}`, `- 原关系描述：${suggestion.before.description || '（无描述）'}`);
  if (suggestion.operation !== 'remove') lines.push(`- 建议关系类型：${suggestion.after.type}`, `- 建议关系描述：${suggestion.after.description || '（无描述）'}`);
  return lines.join('\n');
}

export function createApplicationRecordDraft(kind: ApplicationRecordKind = 'application'): ApplicationRecordDraft {
  return {
    kind,
    context: '',
    content: '',
    outcome: 'unverified',
    assistance: 'unknown',
    result: '',
    limitations: '',
    insight: '',
    correction: '',
    references: '',
  };
}

function isOneOf<T extends readonly string[]>(value: string, options: T): value is T[number] {
  return options.includes(value);
}

function isValidInstant(value: string): boolean {
  return Boolean(value.trim()) && Number.isFinite(new Date(value).getTime());
}

function textLengthError(label: string, value: string, maxLength: number): string | null {
  return value.length > maxLength ? `${label}不能超过 ${maxLength} 个字符。` : null;
}

/**
 * Validate the complete immutable request that will be sent to the server.
 * This helper is intentionally independent from React and does not trim or mutate input.
 */
export function validateApplicationRecordRequest(request: ApplicationRecordRequest): string | null {
  if (!request.eventId.trim()) return '没有冻结这条记录的事件编号。';
  if (!request.conceptId.trim()) return '缺少知识概念编号。';
  if (!request.sourceRevision.trim()) return '缺少知识版本编号。';
  if (!isValidInstant(request.occurredAt)) return '没有冻结有效的记录时间。';
  if (!isOneOf(request.kind, APPLICATION_KINDS)) return '记录类型无效。';

  if (!request.content.trim()) return request.kind === 'summary' ? '请写下这次总结。' : '请写下你如何使用或解释这个概念。';
  const contentError = textLengthError('自己的解释 / 总结', request.content, APPLICATION_CONTENT_MAX_LENGTH);
  if (contentError) return contentError;

  if (request.kind === 'application' && !request.context.trim()) return '实际应用记录需要填写应用场景。';
  const contextError = textLengthError('应用场景 / 主题', request.context, APPLICATION_TEXT_MAX_LENGTH);
  if (contextError) return contextError;

  for (const [field, label] of [
    ['result', '结果'],
    ['limitations', '限制与未解决问题'],
    ['insight', '新的 insight'],
    ['correction', '需要修正的理解'],
    ['references', '参考资料与线索'],
  ] as const) {
    const error = textLengthError(label, request[field], APPLICATION_TEXT_MAX_LENGTH);
    if (error) return error;
  }

  if (!isOneOf(request.outcome, APPLICATION_OUTCOMES)) return '结果判断无效。';
  if (!isOneOf(request.assistance, APPLICATION_ASSISTANCE)) return '辅助方式无效。';
  if (request.relationSuggestion !== undefined) {
    try { parseRelationSuggestion(request.relationSuggestion, request); }
    catch (error) { return error instanceof Error ? error.message : '关系建议无效。'; }
  }
  return null;
}

/** Generate a stable-enough client event ID without making SSR depend on Node crypto. */
export function newApplicationRecordEventId(): string {
  const randomUuid = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID.bind(globalThis.crypto) : null;
  return randomUuid ? randomUuid() : `lm-application-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Freeze the metadata together with the draft at the first save attempt. Retries must
 * pass this exact object back to the caller, even if the clock/source changes meanwhile.
 */
export function buildApplicationRecordRequest(
  concept: Pick<Concept, 'id' | 'source'> & Partial<Pick<Concept, 'title'>>,
  draft: ApplicationRecordDraft,
  occurredAt = new Date().toISOString(),
  eventId = newApplicationRecordEventId(),
  graph: { concepts?: readonly Concept[]; links?: readonly GraphLink[] } = {},
): ApplicationRecordRequest {
  const relationSuggestion = buildRelationSuggestion(concept, draft.relationSuggestion, graph.concepts ?? [], graph.links ?? []);
  const request: ApplicationRecordRequest = {
    eventId,
    conceptId: concept.id,
    sourceRevision: concept.source.revision,
    occurredAt,
    kind: draft.kind,
    context: draft.context,
    content: draft.content,
    outcome: draft.outcome,
    assistance: draft.assistance,
    result: draft.result,
    limitations: draft.limitations,
    insight: draft.insight,
    correction: draft.correction,
    references: draft.references,
    ...(relationSuggestion ? { relationSuggestion } : {}),
  };
  const error = validateApplicationRecordRequest(request);
  if (error) throw new Error(error);
  return Object.freeze(request);
}

export function defaultApplicationMaterialFields(record: Pick<ApplicationRecordRequest, ApplicationMaterialField>): ApplicationMaterialField[] {
  const fields: ApplicationMaterialField[] = (['insight', 'correction', 'references'] as const).filter((field) => Boolean(record[field].trim()));
  if (record.relationSuggestion) fields.push('relationSuggestion');
  return fields;
}

/**
 * Build explicitly selected Markdown material for the existing progressive-kg workflow.
 * Only fields in `fields` are read from the record; context/content/result remain absent
 * unless the user deliberately selects them.
 */
export function buildApplicationMaterial(
  concept: Pick<Concept, 'id' | 'title' | 'source'>,
  record: ApplicationRecordRequest,
  fields: readonly ApplicationMaterialField[],
): string {
  const selected = APPLICATION_MATERIAL_FIELDS.filter((field) => fields.includes(field)).flatMap((field) => {
    const content = field === 'relationSuggestion'
      ? record.relationSuggestion ? relationSuggestionMaterial(record.relationSuggestion) : ''
      : record[field];
    return content.trim() ? [{ field, content }] : [];
  });
  const lines = [
    `# ${concept.title}`,
    '',
    `- 知识节点：${concept.id}`,
    `- 知识源：${concept.source.path}`,
    `- 知识版本：${record.sourceRevision}`,
    `- 记录类型：${APPLICATION_KIND_LABELS[record.kind]}`,
    '',
  ];
  for (const { field, content } of selected) {
    lines.push(`## ${APPLICATION_MATERIAL_LABELS[field]}`, '', content, '');
  }
  if (selected.length === 0) lines.push('（尚未选择可导出的内容。）', '');
  return lines.join('\n').trimEnd() + '\n';
}
