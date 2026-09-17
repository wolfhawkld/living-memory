import type { FocusPoint } from './graph-focus';

export const ROTATION_IDLE_MS = 120_000;
export const ROTATION_TURN_MS = 180_000;

export interface IdleRotationClock {
  interact: (now: number) => void;
  hold: (pointerId: number, now: number) => void;
  release: (pointerId: number, now: number) => void;
  resetPointers: (now: number) => void;
  step: (now: number, enabled: boolean) => number;
}

/** Shared across graph remounts, so changing domains cannot bypass the idle wait. */
export function createIdleRotationClock(): IdleRotationClock {
  let lastInteraction: number | null = null;
  let previousFrame: number | null = null;
  const pointers = new Set<number>();
  const interact = (now: number) => {
    lastInteraction = now;
    previousFrame = null;
  };
  return {
    interact,
    hold: (pointerId, now) => { pointers.add(pointerId); interact(now); },
    release: (pointerId, now) => { pointers.delete(pointerId); interact(now); },
    resetPointers: (now) => { pointers.clear(); interact(now); },
    step: (now, enabled) => {
      if (!enabled || pointers.size > 0) {
        previousFrame = null;
        return 0;
      }
      const elapsed = Math.max(0, Math.min(100, now - (previousFrame ?? now)));
      previousFrame = now;
      const activeElapsed = lastInteraction === null ? elapsed
        : Math.min(elapsed, Math.max(0, now - lastInteraction - ROTATION_IDLE_MS));
      return activeElapsed * 2 * Math.PI / ROTATION_TURN_MS;
    },
  };
}

/** Page-wide input includes searches and side panels, not just canvas gestures. */
export function trackRotationActivity(
  page: EventTarget,
  viewport: EventTarget,
  clock: IdleRotationClock,
  now: () => number,
): () => void {
  const activity = () => clock.interact(now());
  const pointerDown = (event: Event) => clock.hold((event as PointerEvent).pointerId, now());
  const pointerUp = (event: Event) => clock.release((event as PointerEvent).pointerId, now());
  const reset = () => clock.resetPointers(now());
  const events = ['pointermove', 'wheel', 'keydown', 'keyup', 'input', 'click', 'contextmenu'];
  const options = { capture: true, passive: true };
  for (const event of events) page.addEventListener(event, activity, options);
  page.addEventListener('pointerdown', pointerDown, options);
  viewport.addEventListener('pointerup', pointerUp, options);
  viewport.addEventListener('pointercancel', pointerUp, options);
  viewport.addEventListener('blur', reset);
  viewport.addEventListener('focus', activity);
  page.addEventListener('visibilitychange', reset);
  return () => {
    for (const event of events) page.removeEventListener(event, activity, options);
    page.removeEventListener('pointerdown', pointerDown, options);
    viewport.removeEventListener('pointerup', pointerUp, options);
    viewport.removeEventListener('pointercancel', pointerUp, options);
    viewport.removeEventListener('blur', reset);
    viewport.removeEventListener('focus', activity);
    page.removeEventListener('visibilitychange', reset);
  };
}

/**
 * Orbit the camera around its existing target; the graph appears to turn
 * clockwise around its vertical axis. Target, radius and elevation stay fixed.
 * Only the camera moves: concept coordinates and learning data stay untouched.
 */
export function rotateCameraClockwise(position: FocusPoint, target: FocusPoint, angle: number): FocusPoint {
  const x = position.x - target.x;
  const z = position.z - target.z;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: target.x + x * cos + z * sin,
    y: position.y,
    z: target.z - x * sin + z * cos,
  };
}
