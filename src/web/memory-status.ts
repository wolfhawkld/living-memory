import type { MemoryStatus } from '../shared/types.js';

export const STATUS_LABELS: Record<MemoryStatus, string> = {
  unknown: '尚未评估',
  recent: '近期重温',
  revisit: '建议再看',
  stale: '较久未重温',
  pending: '待确认',
  retained: '长期保持（本人确认）',
};
