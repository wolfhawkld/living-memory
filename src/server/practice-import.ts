import type { PracticeAttempt, PracticeCardEvent, PracticeData } from '../shared/practice.js';
import { isValidInstant } from '../core/time-model.js';
import { StoreError } from './store.js';
import { parsePracticeAttemptRequest, parsePracticeCardRequest } from './practice-validation.js';

/** The import planner's small issue surface, kept independent of store state. */
export interface PracticeImportIssueSink {
  add(
    code: string,
    message: string,
    options?: { severity?: 'error' | 'warning'; eventId?: string; cardId?: string },
  ): void;
}

export interface ParsedPracticeData {
  cards: PracticeCardEvent[];
  attempts: PracticeAttempt[];
}

const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message: string, code = 'INVALID_IMPORT'): never {
  throw new StoreError(code, message, 400);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${label} 必须是 JSON 对象。`);
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${label} 必须是数组。`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${label} 必须是非空字符串。`);
  return value.trim();
}

function eventId(value: unknown, label: string): string {
  const id = requireString(value, label);
  if (!EVENT_ID_PATTERN.test(id)) invalid(`${label} 格式无效。`, 'INVALID_EVENT_ID');
  return id;
}

function instant(value: unknown, label: string): { value: string; ms: number } {
  const raw = requireString(value, label);
  if (!isValidInstant(raw)) invalid(`${label} 必须是带时区的 ISO 8601 时间。`, 'INVALID_IMPORT_DATE');
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) invalid(`${label} 不是有效时间。`, 'INVALID_IMPORT_DATE');
  return { value: new Date(ms).toISOString(), ms };
}

function issueDateBounds(
  event: { eventId: string; occurredAt: string; recordedAt: string },
  nowMs: number,
  sink: PracticeImportIssueSink,
): void {
  const occurredMs = Date.parse(event.occurredAt);
  const recordedMs = Date.parse(event.recordedAt);
  if (occurredMs > nowMs || recordedMs > nowMs) {
    sink.add('FUTURE_EVENT_DATE', `${event.eventId} 含有晚于当前时间的练习事件日期。`, { eventId: event.eventId });
  }
  if (recordedMs < occurredMs) {
    sink.add('RECORDED_BEFORE_EVENT', `${event.eventId} 的 recordedAt 早于练习事件发生时间。`, { eventId: event.eventId });
  }
}

function parseCard(value: unknown, index: number, nowMs: number, sink: PracticeImportIssueSink): PracticeCardEvent {
  const record = requireRecord(value, `practice.cards[${index}]`);
  // The shared request parser owns the card's field bounds, source count,
  // literal sourceChecked check, kind, and date normalization.
  const parsed = parsePracticeCardRequest(value);
  const eventIdValue = eventId(parsed.eventId, `practice.cards[${index}].eventId`);
  const cardId = eventId(parsed.cardId, `practice.cards[${index}].cardId`);
  const previousEventId = parsed.previousEventId === null
    ? null
    : eventId(parsed.previousEventId, `practice.cards[${index}].previousEventId`);
  const occurredAt = instant(parsed.occurredAt, `practice.cards[${index}].occurredAt`);
  const recordedAt = instant(record.recordedAt, `practice.cards[${index}].recordedAt`);
  const result: PracticeCardEvent = {
    ...parsed,
    eventId: eventIdValue,
    cardId,
    previousEventId,
    occurredAt: occurredAt.value,
    recordedAt: recordedAt.value,
  };
  issueDateBounds(result, nowMs, sink);
  return result;
}

function parseAttempt(value: unknown, index: number, nowMs: number, sink: PracticeImportIssueSink): PracticeAttempt {
  const record = requireRecord(value, `practice.attempts[${index}]`);
  // The shared request parser owns answer/confidence/exposure/cue/outcome and
  // their text/value bounds. Import adds only persistence and relationship
  // checks around the normalized request.
  const parsed = parsePracticeAttemptRequest(value);
  const eventIdValue = eventId(parsed.eventId, `practice.attempts[${index}].eventId`);
  const cardId = eventId(parsed.cardId, `practice.attempts[${index}].cardId`);
  const cardEventId = eventId(parsed.cardEventId, `practice.attempts[${index}].cardEventId`);
  const answeredAt = instant(parsed.answeredAt, `practice.attempts[${index}].answeredAt`);
  const recordedAt = instant(record.recordedAt, `practice.attempts[${index}].recordedAt`);
  if (parsed.confidenceAt !== null) instant(parsed.confidenceAt, `practice.attempts[${index}].confidenceAt`);
  const result: PracticeAttempt = {
    ...parsed,
    eventId: eventIdValue,
    cardId,
    cardEventId,
    answeredAt: answeredAt.value,
    recordedAt: recordedAt.value,
  };
  issueDateBounds({ eventId: result.eventId, occurredAt: result.answeredAt, recordedAt: result.recordedAt }, nowMs, sink);
  if (result.confidenceAt !== null && Date.parse(result.confidenceAt) > Date.parse(result.answeredAt)) {
    sink.add('CONFIDENCE_AFTER_ANSWER', `${result.eventId} 的 confidenceAt 晚于 answeredAt。`, { eventId: result.eventId, cardId: result.cardId });
  }
  return result;
}

/**
 * Parse the additive practice section. An absent section is a supported old
 * backup; a present section must be complete and is never silently ignored.
 */
export function parsePracticeData(value: unknown, nowMs: number, sink: PracticeImportIssueSink): ParsedPracticeData | null {
  if (value === undefined) return null;
  const record = requireRecord(value, 'practice');
  const rawCards = requireArray(record.cards, 'practice.cards');
  const rawAttempts = requireArray(record.attempts, 'practice.attempts');
  return {
    cards: rawCards.map((item, index) => parseCard(item, index, nowMs, sink)),
    attempts: rawAttempts.map((item, index) => parseAttempt(item, index, nowMs, sink)),
  };
}

function addOnce(
  seen: Set<string>,
  sink: PracticeImportIssueSink,
  code: string,
  message: string,
  options: { severity?: 'error' | 'warning'; eventId?: string; cardId?: string },
): void {
  const key = `${code}\u0000${options.eventId ?? ''}\u0000${options.cardId ?? ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  sink.add(code, message, options);
}

function orderCards(cards: PracticeCardEvent[]): PracticeCardEvent[] {
  const byId = new Map(cards.map((card) => [card.eventId, card]));
  const indegree = new Map(cards.map((card) => [card.eventId, 0]));
  const children = new Map<string, PracticeCardEvent[]>();
  for (const card of cards) {
    if (card.previousEventId === null || !byId.has(card.previousEventId)) continue;
    indegree.set(card.eventId, (indegree.get(card.eventId) ?? 0) + 1);
    const list = children.get(card.previousEventId) ?? [];
    list.push(card);
    children.set(card.previousEventId, list);
  }
  const compare = (left: PracticeCardEvent, right: PracticeCardEvent): number => {
    const byCard = left.cardId.localeCompare(right.cardId);
    if (byCard !== 0) return byCard;
    const byTime = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
    if (byTime !== 0) return byTime;
    return left.eventId.localeCompare(right.eventId);
  };
  const ready = cards.filter((card) => indegree.get(card.eventId) === 0).sort(compare);
  const ordered: PracticeCardEvent[] = [];
  for (let index = 0; index < ready.length; index += 1) {
    const card = ready[index];
    ordered.push(card);
    for (const child of (children.get(card.eventId) ?? []).sort(compare)) {
      const next = (indegree.get(child.eventId) ?? 0) - 1;
      indegree.set(child.eventId, next);
      if (next === 0) ready.push(child);
    }
  }
  if (ordered.length !== cards.length) {
    const seen = new Set(ordered.map((card) => card.eventId));
    ordered.push(...cards.filter((card) => !seen.has(card.eventId)).sort(compare));
  }
  return ordered;
}

/**
 * Validate the append-only card graph and return new cards in dependency
 * order. Existing exact duplicates are represented by the current graph and
 * therefore do not create a second parent or child.
 */
export function validatePracticeCardChain(
  incoming: PracticeCardEvent[],
  currentCards: PracticeCardEvent[],
  newCards: PracticeCardEvent[],
  sink: PracticeImportIssueSink,
): PracticeCardEvent[] {
  const issues = new Set<string>();
  const allById = new Map<string, PracticeCardEvent>();
  for (const card of currentCards) allById.set(card.eventId, card);
  for (const card of incoming) if (!allById.has(card.eventId)) allById.set(card.eventId, card);

  const byCard = new Map<string, PracticeCardEvent[]>();
  for (const card of allById.values()) {
    const list = byCard.get(card.cardId) ?? [];
    list.push(card);
    byCard.set(card.cardId, list);
  }
  const children = new Map<string, PracticeCardEvent[]>();
  for (const card of allById.values()) {
    if (card.previousEventId === null) continue;
    const previous = allById.get(card.previousEventId);
    if (!previous) {
      addOnce(issues, sink, 'PRACTICE_CARD_PREVIOUS_NOT_FOUND', `练习卡 ${card.eventId} 引用的 previousEventId ${card.previousEventId} 不存在。`, { eventId: card.eventId, cardId: card.cardId });
      continue;
    }
    if (previous.cardId !== card.cardId) {
      addOnce(issues, sink, 'PRACTICE_CARD_ID_MISMATCH', `练习卡 ${card.eventId} 的 previousEventId 属于另一张卡。`, { eventId: card.eventId, cardId: card.cardId });
    } else if (Date.parse(card.occurredAt) < Date.parse(previous.occurredAt)) {
      addOnce(issues, sink, 'PRACTICE_CARD_BEFORE_PREVIOUS', `练习卡 ${card.eventId} 的 occurredAt 早于前一版本 ${previous.eventId}。`, { eventId: card.eventId, cardId: card.cardId });
    }
    const list = children.get(previous.eventId) ?? [];
    list.push(card);
    children.set(previous.eventId, list);
  }
  for (const [parentId, list] of children) {
    if (list.length > 1) {
      for (const child of list) {
        addOnce(issues, sink, 'PRACTICE_CARD_FORK', `练习卡版本 ${parentId} 出现多个后继，导入会形成分叉。`, { eventId: child.eventId, cardId: child.cardId });
      }
    }
  }
  for (const [cardId, cards] of byCard) {
    const roots = cards.filter((card) => card.previousEventId === null);
    if (roots.length !== 1) {
      for (const card of roots.length ? roots : cards.slice(0, 1)) {
        addOnce(issues, sink, 'PRACTICE_CARD_ROOT_INVALID', `练习卡 ${cardId} 的版本链必须只有一个 root。`, { eventId: card.eventId, cardId });
      }
    }
  }
  // A missing root can also be hidden by a cycle. Walk every predecessor path
  // so cycles receive a concrete issue rather than merely a root count.
  for (const card of allById.values()) {
    const path = new Set<string>();
    let cursor: PracticeCardEvent | undefined = card;
    while (cursor?.previousEventId !== null && cursor?.previousEventId !== undefined) {
      if (path.has(cursor.eventId)) {
        addOnce(issues, sink, 'PRACTICE_CARD_CYCLE', `练习卡 ${card.eventId} 的 previousEventId 形成循环。`, { eventId: card.eventId, cardId: card.cardId });
        break;
      }
      path.add(cursor.eventId);
      const previous = allById.get(cursor.previousEventId);
      if (!previous) break;
      cursor = previous;
    }
  }

  const newByCard = new Map<string, PracticeCardEvent[]>();
  for (const card of newCards) {
    const list = newByCard.get(card.cardId) ?? [];
    list.push(card);
    newByCard.set(card.cardId, list);
  }
  const currentByCard = new Map<string, PracticeCardEvent[]>();
  for (const card of currentCards) {
    const list = currentByCard.get(card.cardId) ?? [];
    list.push(card);
    currentByCard.set(card.cardId, list);
  }
  for (const [cardId, added] of newByCard) {
    const current = currentByCard.get(cardId) ?? [];
    const addedIds = new Set(added.map((card) => card.eventId));
    const roots = added.filter((card) => card.previousEventId === null || !addedIds.has(card.previousEventId));
    if (current.length === 0) {
      if (roots.length !== 1 || roots[0]?.previousEventId !== null) {
        addOnce(issues, sink, 'PRACTICE_CARD_APPEND_INVALID', `练习卡 ${cardId} 的新增版本必须从唯一 root 开始。`, { eventId: roots[0]?.eventId ?? added[0]?.eventId, cardId });
      }
      continue;
    }
    const currentChildren = new Set<string>();
    for (const card of current) {
      if (card.previousEventId !== null) currentChildren.add(card.previousEventId);
    }
    const tails = current.filter((card) => !currentChildren.has(card.eventId));
    if (tails.length !== 1 || roots.length !== 1 || roots[0]?.previousEventId !== tails[0]?.eventId) {
      addOnce(issues, sink, 'PRACTICE_CARD_APPEND_INVALID', `练习卡 ${cardId} 的新增版本必须接在当前唯一尾部，不能从旧父版本分叉。`, { eventId: roots[0]?.eventId ?? added[0]?.eventId, cardId });
    }
  }
  return orderCards(newCards);
}

/** Validate attempt-to-revision relationships after card conflict classification. */
export function validatePracticeAttempts(
  incoming: PracticeAttempt[],
  newAttempts: PracticeAttempt[],
  currentCards: PracticeCardEvent[],
  incomingCards: PracticeCardEvent[],
  sink: PracticeImportIssueSink,
): void {
  const cardsByEventId = new Map<string, PracticeCardEvent>();
  for (const card of currentCards) cardsByEventId.set(card.eventId, card);
  for (const card of incomingCards) if (!cardsByEventId.has(card.eventId)) cardsByEventId.set(card.eventId, card);
  const newIds = new Set(newAttempts.map((attempt) => attempt.eventId));
  for (const attempt of incoming) {
    const card = cardsByEventId.get(attempt.cardEventId);
    if (!card) {
      sink.add('PRACTICE_ATTEMPT_CARD_NOT_FOUND', `练习回答 ${attempt.eventId} 引用了不存在的卡版本 ${attempt.cardEventId}。`, { eventId: attempt.eventId, cardId: attempt.cardId });
      continue;
    }
    if (card.cardId !== attempt.cardId) {
      sink.add('PRACTICE_ATTEMPT_CARD_ID_MISMATCH', `练习回答 ${attempt.eventId} 的 cardId 与所引用卡版本不一致。`, { eventId: attempt.eventId, cardId: attempt.cardId });
    }
    if (Date.parse(attempt.answeredAt) < Date.parse(card.occurredAt)) {
      sink.add('PRACTICE_ATTEMPT_BEFORE_CARD', `练习回答 ${attempt.eventId} 早于所引用卡版本 ${attempt.cardEventId}。`, { eventId: attempt.eventId, cardId: attempt.cardId });
    }
    if (newIds.has(attempt.eventId) && card.paused) {
      sink.add('PRACTICE_ATTEMPT_PAUSED_CARD', `练习回答 ${attempt.eventId} 不能新增在当时已暂停的卡版本上。`, { eventId: attempt.eventId, cardId: attempt.cardId });
    }
  }
}

export type PracticeEvents = PracticeData;
