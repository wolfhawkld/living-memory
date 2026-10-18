import type { ActivitySettings } from '../shared/activity';

/** Server settings move only forward; unknown controls keep capture suspended. */
export function createActivitySettingsGate() {
  let scope = '';
  let settings: ActivitySettings | null = null;
  let pending = false;
  let uncertain = false;
  let commitGeneration = 0;
  function accept(next: ActivitySettings, verified = false): boolean {
    if (!Number.isSafeInteger(next.epoch) || !Number.isSafeInteger(next.revision) || next.epoch < 0 || next.revision < 0
      || typeof next.enabled !== 'boolean') return false;
    if (settings && (next.epoch < settings.epoch || next.revision < settings.revision
      || (next.revision === settings.revision && (next.epoch !== settings.epoch || next.enabled !== settings.enabled)))) return false;
    settings = { ...next };
    commitGeneration += 1;
    if (verified && !pending) uncertain = false;
    return true;
  }
  return {
    setScope(next: string) { if (next !== scope) { commitGeneration += 1; scope = next; settings = null; pending = false; uncertain = false; } },
    beginControl() { commitGeneration += 1; pending = true; uncertain = true; },
    endControl() { pending = false; },
    markUncertain() { commitGeneration += 1; uncertain = true; },
    accept,
    /** Invalid or obsolete responses cannot cancel an already accepted commit. */
    beginCommit(next: ActivitySettings, verified = false): { isCurrent(): boolean } | null {
      if (!accept(next, verified)) return null;
      const captured = commitGeneration;
      return { isCurrent: () => captured === commitGeneration };
    },
    snapshot() { return { settings: settings ? { ...settings } : null, suspended: pending || uncertain }; },
  };
}
