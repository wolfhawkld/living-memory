import type { ApplicationRecordRequest, RelationSuggestion, RelationSuggestionEndpoint, RelationSuggestionValue } from './types.js';

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('关系建议必须是对象。');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new Error('关系建议字段不完整或包含额外字段。');
  }
  return record;
}

function string(record: Record<string, unknown>, key: string, max: number, empty = false): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new Error(`关系建议 ${key} 无效。`);
  return value;
}

function endpoint(value: unknown): RelationSuggestionEndpoint {
  const record = object(value, ['conceptId', 'sourceRevision', 'title', 'path']);
  return Object.freeze({ conceptId: string(record, 'conceptId', 512), sourceRevision: string(record, 'sourceRevision', 512), title: string(record, 'title', 1000), path: string(record, 'path', 4096) });
}

function relation(value: unknown): RelationSuggestionValue {
  const record = object(value, ['type', 'description']);
  return Object.freeze({ type: string(record, 'type', 256), description: string(record, 'description', 4000, true) });
}

/** Validate frozen historical context without consulting the current graph. */
export function parseRelationSuggestion(value: unknown, parent: Pick<ApplicationRecordRequest, 'conceptId' | 'sourceRevision'>): RelationSuggestion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('关系建议必须是对象。');
  const operation = (value as Record<string, unknown>).operation;
  if (operation !== 'add' && operation !== 'change' && operation !== 'remove') throw new Error('关系建议 operation 无效。');
  const record = object(value, ['operation', 'source', 'target', ...(operation !== 'add' ? ['before'] : []), ...(operation !== 'remove' ? ['after'] : [])]);
  const source = endpoint(record.source);
  const target = endpoint(record.target);
  if (source.conceptId === target.conceptId) throw new Error('关系建议两端必须不同。');
  const owner = source.conceptId === parent.conceptId ? source : target.conceptId === parent.conceptId ? target : undefined;
  if (!owner || owner.sourceRevision !== parent.sourceRevision) throw new Error('关系建议必须包含父记录的概念和版本。');
  if (operation === 'add') return Object.freeze({ operation, source, target, after: relation(record.after) });
  if (operation === 'remove') return Object.freeze({ operation, source, target, before: relation(record.before) });
  const before = relation(record.before);
  const after = relation(record.after);
  if (before.type === after.type && before.description === after.description) throw new Error('关系建议 change 前后必须不同。');
  return Object.freeze({ operation, source, target, before, after });
}
