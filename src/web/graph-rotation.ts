import type { FocusPoint } from './graph-focus';

export const ROTATION_IDLE_MS = 120_000;
export const ROTATION_TURN_MS = 180_000;

export interface IdleRotationClock {
  interact: (now: number) => void;
  hold: (pointerId: number, now: number) => void;
  release: (pointerId: number, now: number) => void;
  suspend: () => void;
  resume: () => void;
  inspect: (now: number) => { holding: boolean; remainingMs: number };
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
    // Focus/visibility changes are lifecycle notifications, not fresh input.
    suspend: () => { pointers.clear(); previousFrame = null; },
    // An explicit start action overrides the idle wait, never a held gesture.
    resume: () => { lastInteraction = null; previousFrame = null; },
    inspect: (now) => ({
      holding: pointers.size > 0,
      remainingMs: lastInteraction === null ? 0 : Math.max(0, lastInteraction + ROTATION_IDLE_MS - now),
    }),
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
  const pointerPositions = new Map<number, string>();
  const coordinates = (pointer: PointerEvent) => `${pointer.clientX}:${pointer.clientY}:${pointer.screenX}:${pointer.screenY}`;
  const activity = () => clock.interact(now());
  const pointerDown = (event: Event) => {
    const pointer = event as PointerEvent;
    pointerPositions.set(pointer.pointerId, coordinates(pointer));
    clock.hold(pointer.pointerId, now());
  };
  const pointerUp = (event: Event) => {
    const pointer = event as PointerEvent;
    if (pointer.pointerType === 'touch') pointerPositions.delete(pointer.pointerId);
    else pointerPositions.set(pointer.pointerId, coordinates(pointer));
    clock.release(pointer.pointerId, now());
  };
  const reset = () => clock.suspend();
  const pointerMove = (event: Event) => {
    const pointer = event as PointerEvent;
    const position = coordinates(pointer);
    const previous = pointerPositions.get(pointer.pointerId);
    pointerPositions.set(pointer.pointerId, position);
    // Browsers may notify pointer boundaries after DOM/cursor changes. Repeated
    // coordinates alone are not evidence that the person moved the pointer.
    if (previous !== position) activity();
  };
  const events = ['wheel', 'keydown', 'keyup', 'input', 'click', 'contextmenu'];
  const options = { capture: true, passive: true };
  for (const event of events) page.addEventListener(event, activity, options);
  page.addEventListener('pointermove', pointerMove, options);
  page.addEventListener('pointerdown', pointerDown, options);
  viewport.addEventListener('pointerup', pointerUp, options);
  viewport.addEventListener('pointercancel', pointerUp, options);
  viewport.addEventListener('blur', reset);
  viewport.addEventListener('focus', reset);
  page.addEventListener('visibilitychange', reset);
  return () => {
    for (const event of events) page.removeEventListener(event, activity, options);
    page.removeEventListener('pointermove', pointerMove, options);
    page.removeEventListener('pointerdown', pointerDown, options);
    viewport.removeEventListener('pointerup', pointerUp, options);
    viewport.removeEventListener('pointercancel', pointerUp, options);
    viewport.removeEventListener('blur', reset);
    viewport.removeEventListener('focus', reset);
    page.removeEventListener('visibilitychange', reset);
  };
}

export interface RotationStatus {
  kind: 'disabled' | 'flat' | 'hidden' | 'paused' | 'preparing' | 'holding' | 'waiting' | 'rotating';
  text: string;
}

export function readRotationStatus(
  clock: IdleRotationClock,
  now: number,
  view: { enabled: boolean; ready: boolean; twoDimensional: boolean; hidden: boolean; paused: boolean },
): RotationStatus {
  if (!view.enabled) return { kind: 'disabled', text: '自动旋转已关闭' };
  if (view.twoDimensional) return { kind: 'flat', text: '2D 阅读 · 旋转暂停' };
  if (view.hidden) return { kind: 'hidden', text: '页面隐藏 · 旋转暂停' };
  if (view.paused) return { kind: 'paused', text: '正在操作 · 旋转暂停' };
  if (!view.ready) return { kind: 'preparing', text: '等待图谱定位完成' };
  const idle = clock.inspect(now);
  if (idle.holding) return { kind: 'holding', text: '操作中 · 松开后开始计时' };
  if (idle.remainingMs > 0) {
    const seconds = Math.ceil(idle.remainingMs / 1_000);
    return { kind: 'waiting', text: `旋转暂停 · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} 后恢复` };
  }
  return { kind: 'rotating', text: '顺时针旋转中' };
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
