import type { ActivitySettings } from '../shared/activity';

/** Server settings move only forward; unknown controls keep capture suspended. */
export function createActivitySettingsGate() {
  let scope = '';
  let settings: ActivitySettings | null = null;
  let pending = false;
  let uncertain = false;
  return {
    setScope(next: string) { if (next !== scope) { scope = next; settings = null; pending = false; uncertain = false; } },
    beginControl() { pending = true; uncertain = true; },
    endControl() { pending = false; },
    markUncertain() { uncertain = true; },
    accept(next: ActivitySettings, verified = false): boolean {
      if (!Number.isSafeInteger(next.epoch) || !Number.isSafeInteger(next.revision) || next.epoch < 0 || next.revision < 0
        || typeof next.enabled !== 'boolean') return false;
      if (settings && (next.epoch < settings.epoch || next.revision < settings.revision
        || (next.revision === settings.revision && (next.epoch !== settings.epoch || next.enabled !== settings.enabled)))) return false;
      settings = { ...next };
      if (verified && !pending) uncertain = false;
      return true;
    },
    snapshot() { return { settings: settings ? { ...settings } : null, suspended: pending || uncertain }; },
  };
}
