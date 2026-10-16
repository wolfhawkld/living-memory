export interface GraphPerformanceContext {
  hidden: boolean; paused: boolean; contextLost: boolean;
  quality: 'standard' | 'low'; theme: 'dark' | 'light'; viewMode: '2d' | '3d'; glowEnabled: boolean;
  dpr: number; viewport: { width: number; height: number }; canvas: { width: number; height: number }; canvasCount: number;
}
export interface GraphPerformanceRenderer {
  info: { autoReset: boolean; reset: () => void; render: { calls: number; triangles: number; points: number; lines: number };
    memory: { geometries: number; textures: number }; programs?: readonly unknown[] | null };
}
export interface GraphPerformanceSnapshot {
  capturedAtMs: number;
  resources: { geometries: number | null; textures: number | null; programs: number | null };
  context: GraphPerformanceContext | null;
}
export interface PerformancePercentiles { p50: number | null; p95: number | null }
export type GraphPerformanceInterruption = 'hidden' | 'paused' | 'context-lost' | 'aborted' | 'disposed' | 'busy' | 'render-error' | 'probe-error' | 'sample-limit' | 'clock-error';
export interface GraphPerformanceReport {
  format: 'living-memory-graph-performance'; version: 1; status: 'complete' | 'incomplete'; reason?: GraphPerformanceInterruption;
  timing: { requestedWarmupMs: number; requestedDurationMs: number; startedAtMs: number; measurementStartedAtMs: number | null; endedAtMs: number; actualMeasurementMs: number };
  submissions: { count: number; perSecond: number | null; intervalMs: PerformancePercentiles; cpuMs: PerformancePercentiles };
  drawCalls: PerformancePercentiles; triangles: PerformancePercentiles; points: PerformancePercentiles; lines: PerformancePercentiles;
  before: GraphPerformanceSnapshot; after: GraphPerformanceSnapshot;
}
export interface GraphPerformanceClock { now: () => number; setTimeout: (callback: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void }
export interface GraphPerformanceSampleOptions { warmupMs: number; durationMs: number; signal?: AbortSignal }
export interface GraphPerformanceProbe {
  sample: (options: GraphPerformanceSampleOptions) => Promise<GraphPerformanceReport>;
  snapshot: () => GraphPerformanceSnapshot;
  dispose: () => void;
}
export function performancePercentiles(values: readonly number[]): PerformancePercentiles {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  const percentile = (fraction: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
  return { p50: percentile(.5), p95: percentile(.95) };
}
const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Counts completed composer submissions, not browser rAF callbacks or GPU FPS. */
export function createGraphPerformanceProbe(options: {
  composer: { render: (...args: any[]) => any }; renderer: GraphPerformanceRenderer;
  readContext: () => GraphPerformanceContext; clock?: GraphPerformanceClock;
}): GraphPerformanceProbe {
  const { composer, renderer } = options;
  const clock: GraphPerformanceClock = options.clock ?? { now: () => performance.now(),
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms), clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>) };
  const original = composer.render;
  let disposed = false;
  interface Sampling {
    options: GraphPerformanceSampleOptions; before: GraphPerformanceSnapshot; started: number; measured: number | null;
    priorAutoReset: boolean; resolve: (report: GraphPerformanceReport) => void; timer?: unknown; abort: () => void;
    previousFrame: number | null; cpu: number[]; intervals: number[]; calls: number[]; triangles: number[]; points: number[]; lines: number[];
  }
  let active: Sampling | null = null;
  const snapshot = (): GraphPerformanceSnapshot => {
    let context: GraphPerformanceContext | null = null;
    try {
      const value = options.readContext();
      // Explicitly copy only the benchmark contract: no document/user metadata.
      context = { hidden: Boolean(value.hidden), paused: Boolean(value.paused), contextLost: Boolean(value.contextLost),
        quality: value.quality === 'low' ? 'low' : 'standard', theme: value.theme === 'light' ? 'light' : 'dark', viewMode: value.viewMode === '2d' ? '2d' : '3d',
        glowEnabled: Boolean(value.glowEnabled), dpr: value.dpr, viewport: { width: value.viewport.width, height: value.viewport.height },
        canvas: { width: value.canvas.width, height: value.canvas.height }, canvasCount: value.canvasCount };
    } catch { /* A failed context read is an incomplete sample, not invented metadata. */ }
    return { capturedAtMs: clock.now(), resources: { geometries: count(renderer.info.memory.geometries), textures: count(renderer.info.memory.textures),
      programs: Array.isArray(renderer.info.programs) ? renderer.info.programs.length : null }, context };
  };
  const blocked = (context: GraphPerformanceContext | null): GraphPerformanceInterruption | undefined => !context ? 'probe-error'
    : context.hidden ? 'hidden' : context.paused ? 'paused' : context.contextLost ? 'context-lost' : undefined;
  const report = (state: Sampling, reason?: GraphPerformanceInterruption): GraphPerformanceReport => {
    const ended = clock.now(); const duration = state.measured === null ? 0 : Math.max(0, ended - state.measured);
    return { format: 'living-memory-graph-performance', version: 1, status: reason ? 'incomplete' : 'complete', ...(reason ? { reason } : {}),
      timing: { requestedWarmupMs: state.options.warmupMs, requestedDurationMs: state.options.durationMs, startedAtMs: state.started,
        measurementStartedAtMs: state.measured, endedAtMs: ended, actualMeasurementMs: duration },
      submissions: { count: state.cpu.length, perSecond: reason || duration <= 0 ? null : state.cpu.length * 1000 / duration,
        intervalMs: performancePercentiles(state.intervals), cpuMs: performancePercentiles(state.cpu) },
      drawCalls: performancePercentiles(state.calls), triangles: performancePercentiles(state.triangles), points: performancePercentiles(state.points), lines: performancePercentiles(state.lines),
      before: state.before, after: snapshot() };
  };
  const finish = (reason?: GraphPerformanceInterruption) => {
    const state = active; if (!state) return;
    active = null;
    if (state.timer !== undefined) clock.clearTimeout(state.timer);
    state.options.signal?.removeEventListener('abort', state.abort);
    reason ??= blocked(snapshot().context);
    try { renderer.info.autoReset = state.priorAutoReset; } catch { reason ??= 'probe-error'; }
    state.resolve(report(state, reason));
  };
  const tick = () => {
    const state = active; if (!state) return;
    const now = clock.now();
    if (now < state.started || (state.measured !== null && now < state.measured)) { finish('clock-error'); return; }
    const interruption = blocked(snapshot().context); if (interruption) { finish(interruption); return; }
    if (state.measured === null && now - state.started >= state.options.warmupMs) state.measured = now;
    if (state.measured !== null && now - state.measured >= state.options.durationMs) { finish(); return; }
    const remaining = state.measured === null ? state.options.warmupMs - (now - state.started) : state.options.durationMs - (now - state.measured);
    state.timer = clock.setTimeout(tick, Math.min(100, remaining));
  };
  const wrapper = function(this: unknown, ...args: any[]) {
    let state = active;
    if (state) {
      const interruption = blocked(snapshot().context);
      if (interruption) { finish(interruption); state = null; }
      else try { renderer.info.reset(); } catch { finish('probe-error'); state = null; }
    }
    const began = state ? clock.now() : 0;
    let value: unknown;
    try { value = Reflect.apply(original, this, args); }
    catch (error) { if (active) finish('render-error'); throw error; }
    if (state && state === active && state.measured !== null) {
      const ended = clock.now();
      if (ended < began || (state.previousFrame !== null && ended < state.previousFrame)) finish('clock-error');
      else if (state.cpu.length >= 100_000) finish('sample-limit');
      else {
        state.cpu.push(ended - began);
        if (state.previousFrame !== null) state.intervals.push(ended - state.previousFrame);
        state.previousFrame = ended;
        for (const [values, raw] of [[state.calls, renderer.info.render.calls], [state.triangles, renderer.info.render.triangles],
          [state.points, renderer.info.render.points], [state.lines, renderer.info.render.lines]] as const) {
          const number = count(raw); if (number !== null) values.push(number);
        }
        if (ended - state.measured >= state.options.durationMs) finish();
      }
    }
    return value;
  };
  composer.render = wrapper;
  return {
    snapshot,
    sample(sampleOptions) {
      if (!Number.isFinite(sampleOptions.warmupMs) || sampleOptions.warmupMs < 0 || sampleOptions.warmupMs > 30_000
        || !Number.isFinite(sampleOptions.durationMs) || sampleOptions.durationMs <= 0 || sampleOptions.durationMs > 60_000) return Promise.reject(new Error('无效的图谱采样时间。'));
      return new Promise((resolve) => {
        const before = snapshot(); const started = clock.now();
        const state: Sampling = { options: sampleOptions, before, started, measured: sampleOptions.warmupMs === 0 ? started : null,
          priorAutoReset: renderer.info.autoReset, resolve, abort: () => finish('aborted'), previousFrame: null,
          cpu: [], intervals: [], calls: [], triangles: [], points: [], lines: [] };
        const reason = disposed ? 'disposed' : active ? 'busy' : sampleOptions.signal?.aborted ? 'aborted' : blocked(before.context);
        if (reason) { resolve(report(state, reason)); return; }
        active = state;
        try { renderer.info.autoReset = false; } catch { finish('probe-error'); return; }
        sampleOptions.signal?.addEventListener('abort', state.abort, { once: true });
        tick();
      });
    },
    dispose() {
      if (disposed) return; disposed = true;
      finish('disposed');
      if (composer.render === wrapper) composer.render = original;
    },
  };
}
