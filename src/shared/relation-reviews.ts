import type { Concept, GraphLink, RelationSuggestion, RelationSuggestionEndpoint } from './types.js';
export type RelationReviewStatus = 'open' | 'resolved' | 'dismissed';
export interface RelationReviewEndpoint { conceptId: string; current: RelationSuggestionEndpoint | null }
export interface RelationReviewBasis { source: RelationReviewEndpoint; target: RelationReviewEndpoint; beforePresent: boolean | null; afterPresent: boolean | null }
export interface RelationReviewRequest { eventId: string; applicationEventId: string; conceptId: string; occurredAt: string; previousEventId: string | null; status: RelationReviewStatus; note: string; basis: RelationReviewBasis }
export interface RelationReviewEvent extends RelationReviewRequest { recordedAt: string }
export interface RelationReviewHistory { latest: RelationReviewEvent | null; events: RelationReviewEvent[]; total: number }
export interface RelationReviewResponse { sourceId: string; applicationEventId: string; conceptId: string; asOf: string; basis: RelationReviewBasis; history: RelationReviewHistory }

/** Compare inspected identities, revisions and exact-relation presence without exposing relation text. */
export function relationReviewBasisEqual(left: RelationReviewBasis, right: RelationReviewBasis): boolean {
  const endpoint = (value: RelationReviewBasis['source']) => [value.conceptId, value.current?.conceptId ?? null, value.current?.sourceRevision ?? null, value.current?.title ?? null, value.current?.path ?? null];
  return JSON.stringify([endpoint(left.source), endpoint(left.target), left.beforePresent, left.afterPresent])
    === JSON.stringify([endpoint(right.source), endpoint(right.target), right.beforePresent, right.afterPresent]);
}

import { isValidInstant } from '../core/time-model.js';

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('关系复核必须是对象。');
  const record = value as Record<string, unknown>;
  if (keys.some((key) => !Object.hasOwn(record, key)) || Object.keys(record).some((key) => !keys.includes(key))) throw new Error('关系复核字段不完整或包含额外字段。');
  return record;
}
function text(record: Record<string, unknown>, key: string, max: number, empty = false): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new Error(`关系复核 ${key} 无效。`);
  return value;
}
function endpoint(value: unknown): RelationSuggestionEndpoint {
  const record = object(value, ['conceptId', 'sourceRevision', 'title', 'path']);
  return Object.freeze({ conceptId: text(record, 'conceptId', 512), sourceRevision: text(record, 'sourceRevision', 512), title: text(record, 'title', 1000), path: text(record, 'path', 4096) });
}
export function parseRelationReviewBasis(value: unknown): RelationReviewBasis {
  const record = object(value, ['source', 'target', 'beforePresent', 'afterPresent']);
  const read = (value: unknown) => {
    const item = object(value, ['conceptId', 'current']);
    const conceptId = text(item, 'conceptId', 512);
    const current = item.current === null ? null : endpoint(item.current);
    if (current && current.conceptId !== conceptId) throw new Error('关系复核当前端点 ID 不一致。');
    return Object.freeze({ conceptId, current });
  };
  const source = read(record.source); const target = read(record.target);
  if (source.conceptId === target.conceptId) throw new Error('关系复核两端必须不同。');
  if (![true, false, null].includes(record.beforePresent as boolean | null) || ![true, false, null].includes(record.afterPresent as boolean | null)) throw new Error('关系复核存在性必须是布尔值或 null。');
  if ((!source.current || !target.current) && (record.beforePresent !== null || record.afterPresent !== null)) throw new Error('缺失端点时关系存在性必须为 null。');
  return Object.freeze({ source, target, beforePresent: record.beforePresent as boolean | null, afterPresent: record.afterPresent as boolean | null });
}
export function parseRelationReviewRequest(value: unknown): RelationReviewRequest {
  const record = object(value, ['eventId', 'applicationEventId', 'conceptId', 'occurredAt', 'previousEventId', 'status', 'note', 'basis']);
  const id = (key: string) => {
    const value = text(record, key, 128).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`关系复核 ${key} 格式无效。`);
    return value;
  };
  const occurredAt = text(record, 'occurredAt', 128);
  if (!isValidInstant(occurredAt)) throw new Error('关系复核 occurredAt 无效。');
  const status = record.status;
  if (status !== 'open' && status !== 'resolved' && status !== 'dismissed') throw new Error('关系复核 status 无效。');
  return Object.freeze({ eventId: id('eventId'), applicationEventId: id('applicationEventId'), conceptId: text(record, 'conceptId', 512).trim(), occurredAt: new Date(occurredAt).toISOString(), previousEventId: record.previousEventId === null ? null : id('previousEventId'), status, note: text(record, 'note', 4000, true), basis: parseRelationReviewBasis(record.basis) });
}
/** Verify historical shape and identities without consulting a live graph. */
export function validateRelationReviewBasis(suggestion: RelationSuggestion, input: RelationReviewBasis): void {
  const basis = parseRelationReviewBasis(input);
  if (basis.source.conceptId !== suggestion.source.conceptId || basis.target.conceptId !== suggestion.target.conceptId) throw new Error('关系复核双端点与原建议不一致。');
  if (!basis.source.current || !basis.target.current) return;
  if (suggestion.operation === 'add' ? basis.beforePresent !== null || basis.afterPresent === null : suggestion.operation === 'remove' ? basis.afterPresent !== null || basis.beforePresent === null : basis.beforePresent === null || basis.afterPresent === null) throw new Error('关系复核存在性与建议操作不一致。');
}
/** Full index exact tuple comparison; revisions describe the inspected snapshot only. */
export function buildRelationReviewBasis(suggestion: RelationSuggestion, concepts: readonly Concept[], links: readonly GraphLink[]): RelationReviewBasis {
  const read = (conceptId: string) => {
    const concept = concepts.find((entry) => entry.id === conceptId);
    return { conceptId, current: concept ? { conceptId, sourceRevision: concept.source.revision, title: concept.title, path: concept.source.path } : null };
  };
  const source = read(suggestion.source.conceptId); const target = read(suggestion.target.conceptId);
  const exists = (tuple: { type: string; description: string }) => links.some((link) => link.source === source.conceptId && link.target === target.conceptId && link.type === tuple.type && link.description === tuple.description);
  const available = source.current !== null && target.current !== null;
  return parseRelationReviewBasis({ source, target, beforePresent: available && 'before' in suggestion ? exists(suggestion.before) : null, afterPresent: available && 'after' in suggestion ? exists(suggestion.after) : null });
}
export function relationReviewMatches(suggestion: RelationSuggestion, basis: RelationReviewBasis): boolean {
  validateRelationReviewBasis(suggestion, basis);
  if (!basis.source.current || !basis.target.current) return false;
  return suggestion.operation === 'add' ? basis.afterPresent === true : suggestion.operation === 'remove' ? basis.beforePresent === false : basis.beforePresent === false && basis.afterPresent === true;
}
