import type {
  AnchorEvent,
  Concept,
  MemoryState,
  ModelConfig,
} from '../shared/types.js';

const DAY_MS = 86_400_000;
const MAX_HALF_LIFE_DAYS = 3650;

/**
 * The model only accepts an unambiguous ISO-8601 instant.  In particular,
 * date-only and local date-time strings are rejected because their meaning
 * depends on the machine's local timezone.
 */
const INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

function parseInstant(value: string): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = INSTANT_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8];

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      return null;
    }
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Return whether `value` is an unambiguous ISO-8601 instant. */
export function isValidInstant(value: string): boolean {
  return parseInstant(value) !== null;
}

function requireInstant(value: string, fieldName: string): number {
  const timestamp = parseInstant(value);
  if (timestamp === null) {
    throw new RangeError(
      `Invalid ${fieldName}: expected an ISO-8601 timestamp with a timezone (Z or ±HH:MM).`,
    );
  }
  return timestamp;
}

function validateHalfLife(halfLifeDays: number): void {
  if (
    !Number.isFinite(halfLifeDays) ||
    halfLifeDays <= 0 ||
    halfLifeDays > MAX_HALF_LIFE_DAYS
  ) {
    throw new RangeError(
      `Invalid halfLifeDays: expected a finite number greater than 0 and at most ${MAX_HALF_LIFE_DAYS}.`,
    );
  }
}

/**
 * Exponential time-only decay baseline: D(t) = 2^(-t / H).
 *
 * This is a deterministic time indicator, not a calibrated probability of
 * recall.  Inputs are deliberately bounded so a bad persisted configuration
 * cannot silently produce an unusable projection.
 */
export function decayAt(elapsedDays: number, halfLifeDays: number): number {
  validateHalfLife(halfLifeDays);
  if (!Number.isFinite(elapsedDays)) {
    throw new RangeError('Invalid elapsedDays: expected a finite number.');
  }
  if (elapsedDays < 0) {
    throw new RangeError('Invalid elapsedDays: expected a non-negative number.');
  }

  return 2 ** (-elapsedDays / halfLifeDays);
}

function pendingState(
  concept: Concept,
  anchor: AnchorEvent,
  asOf: string,
  reason: string,
): MemoryState {
  return {
    conceptId: concept.id,
    status: 'pending',
    decay: null,
    elapsedDays: null,
    anchor: { ...anchor },
    reason,
    asOf,
  };
}

/**
 * Project one concept's time-only memory state at a supplied instant.
 * The function is pure: it does not update the concept, anchor, or config.
 */
export function projectMemory(
  concept: Concept,
  anchor: AnchorEvent | null,
  config: ModelConfig,
  asOf: string,
): MemoryState {
  const asOfTimestamp = requireInstant(asOf, 'asOf');
  validateHalfLife(config.halfLifeDays);

  if (anchor === null) {
    return {
      conceptId: concept.id,
      status: 'unknown',
      decay: null,
      elapsedDays: null,
      anchor: null,
      reason: null,
      asOf,
    };
  }

  const occurredAtTimestamp = requireInstant(anchor.occurredAt, 'anchor.occurredAt');

  if (anchor.conceptId !== concept.id) {
    return pendingState(
      concept,
      anchor,
      asOf,
      '锚点事件的概念 ID 与当前概念不匹配，待重新确认。',
    );
  }

  if (anchor.sourceRevision !== concept.source.revision) {
    return pendingState(
      concept,
      anchor,
      asOf,
      '概念内容版本已变化，旧锚点待重新确认。',
    );
  }

  if (occurredAtTimestamp > asOfTimestamp) {
    return pendingState(
      concept,
      anchor,
      asOf,
      '锚点时间晚于投影时间，待确认。',
    );
  }

  const elapsedDays = (asOfTimestamp - occurredAtTimestamp) / DAY_MS;
  const decay = decayAt(elapsedDays, config.halfLifeDays);
  const status = decay > 0.5 ? 'recent' : decay > 0.25 ? 'revisit' : 'stale';

  return {
    conceptId: concept.id,
    status,
    decay,
    elapsedDays,
    anchor: { ...anchor },
    reason: null,
    asOf,
  };
}
