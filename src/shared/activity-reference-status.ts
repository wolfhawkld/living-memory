/** Current navigation status, independent of the frozen event's original facts. */
import type { ActivityPage, ActivityRecord } from './activity';

export interface ActivityReferenceCurrentStatus {
  refIndex: number;
  status: 'current' | 'source-changed' | 'source-moved' | 'missing-concept' | 'location-unresolved';
  revisionChanged: boolean;
  pathChanged: boolean;
  current?: { conceptId: string; title: string; path: string; sourceRevision: string };
}

export interface ActivityViewRecord extends ActivityRecord { currentReferenceStatuses: ActivityReferenceCurrentStatus[] }
export interface ActivityViewPage extends Omit<ActivityPage, 'items'> { items: ActivityViewRecord[] }
