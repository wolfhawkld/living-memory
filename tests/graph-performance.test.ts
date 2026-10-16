import assert from 'node:assert/strict';
import test from 'node:test';
import { createGraphPerformanceProbe, performancePercentiles, type GraphPerformanceClock, type GraphPerformanceContext, type GraphPerformanceRenderer } from '../src/web/graph-performance';

class Clock implements GraphPerformanceClock {
  time = 0; next = 0; timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout = (callback: () => void, ms: number) => { const id = ++this.next; this.timers.set(id, { at: this.time + ms, callback }); return id; };
  clearTimeout = (handle: unknown) => { this.timers.delete(handle as number); };
  consume(ms: number) { this.time += ms; }
  advance(ms: number) {
    const until = this.time + ms;
    for (;;) {
      const due = [...this.timers].filter(([, timer]) => timer.at <= until).sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.time = Math.max(this.time, due[1].at); this.timers.delete(due[0]); due[1].callback();
    }
    this.time = Math.max(this.time, until);
  }
}
function fixture() {
  const clock = new Clock();
  const context: GraphPerformanceContext = { hidden: false, paused: false, contextLost: false, quality: 'standard', theme: 'dark', viewMode: '3d', glowEnabled: true,
    dpr: 2, viewport: { width: 800, height: 600 }, canvas: { width: 1600, height: 1200 }, canvasCount: 1 };
  const renderer: GraphPerformanceRenderer = { info: { autoReset: true, memory: { geometries: 10, textures: 3 }, programs: [{}, {}],
    render: { calls: 0, triangles: 0, points: 0, lines: 0 }, reset() { this.render = { calls: 0, triangles: 0, points: 0, lines: 0 }; } } };
  const returned = {};
  const composer = { render: function(this: unknown, value?: unknown) {
    clock.consume(2); renderer.info.render.calls += 4; renderer.info.render.triangles += 100;
    return { returned, receiver: this, value };
  } };
  const original = composer.render;
  const probe = createGraphPerformanceProbe({ composer, renderer, readContext: () => context, clock });
  return { clock, context, renderer, composer, original, returned, probe };
}

test('probe counts only actual completed composer calls, excludes warmup, preserves this/arguments/return and restores multi-pass reset mode', async () => {
  const f = fixture();
  const receiver = {};
  assert.deepEqual(f.composer.render.call(receiver, 'outside'), { returned: f.returned, receiver, value: 'outside' });
  const pending = f.probe.sample({ warmupMs: 20, durationMs: 100 });
  assert.equal(f.renderer.info.autoReset, false);
  f.composer.render('warmup'); f.clock.advance(18);
  f.composer.render('one'); f.clock.advance(8); f.composer.render('two');
  f.clock.advance(88);
  const report = await pending;
  assert.equal(report.status, 'complete'); assert.equal(report.submissions.count, 2);
  assert.equal(report.timing.actualMeasurementMs, 100); assert.equal(report.submissions.perSecond, 20);
  assert.deepEqual(report.submissions.cpuMs, { p50: 2, p95: 2 });
  assert.deepEqual(report.submissions.intervalMs, { p50: 10, p95: 10 });
  assert.deepEqual(report.drawCalls, { p50: 4, p95: 4 });
  assert.deepEqual(report.after.resources, { geometries: 10, textures: 3, programs: 2 });
  assert.equal(f.renderer.info.autoReset, true);
  f.probe.dispose(); assert.equal(f.composer.render, f.original);
});

test('percentiles use deterministic nearest ranks without mutating caller arrays', () => {
  const values = Array.from({ length: 100 }, (_, index) => 100 - index);
  assert.deepEqual(performancePercentiles(values), { p50: 50, p95: 95 });
  assert.equal(values[0], 100); assert.deepEqual(performancePercentiles([]), { p50: null, p95: null });
});

test('original render exceptions retain their identity and never count as completed frames', async () => {
  const clock = new Clock(); const error = new Error('synthetic original error');
  const f = fixture(); f.probe.dispose();
  const composer = { render() { throw error; } }; const original = composer.render;
  const probe = createGraphPerformanceProbe({ composer, renderer: f.renderer, readContext: () => f.context, clock });
  const pending = probe.sample({ warmupMs: 0, durationMs: 100 });
  assert.throws(() => composer.render(), (caught) => caught === error);
  const report = await pending;
  assert.equal(report.status, 'incomplete'); assert.equal(report.reason, 'render-error');
  assert.equal(report.submissions.count, 0); assert.equal(report.submissions.perSecond, null);
  assert.equal(f.renderer.info.autoReset, true); probe.dispose(); assert.equal(composer.render, original);
});

test('hidden, paused or lost contexts interrupt without manufacturing a zero submission rate', async () => {
  for (const [field, reason] of [['hidden', 'hidden'], ['paused', 'paused'], ['contextLost', 'context-lost']] as const) {
    const f = fixture(); const pending = f.probe.sample({ warmupMs: 0, durationMs: 1000 });
    f.composer.render(); f.context[field] = true; f.clock.advance(100);
    const result = await pending;
    assert.equal(result.status, 'incomplete'); assert.equal(result.reason, reason); assert.equal(result.submissions.perSecond, null);
    assert.equal(f.renderer.info.autoReset, true); f.probe.dispose();
  }
});

test('abort and repeated cycle cancellation release timers, preserve original autoReset and disposal is idempotent', async () => {
  const f = fixture(); f.renderer.info.autoReset = false;
  for (let index = 0; index < 3; index += 1) {
    const controller = new AbortController(); const pending = f.probe.sample({ warmupMs: 0, durationMs: 100, signal: controller.signal });
    f.composer.render(); controller.abort();
    assert.equal((await pending).reason, 'aborted'); assert.equal(f.clock.timers.size, 0); assert.equal(f.renderer.info.autoReset, false);
  }
  const last = f.probe.sample({ warmupMs: 0, durationMs: 100 });
  f.probe.dispose(); f.probe.dispose();
  assert.equal((await last).reason, 'disposed'); assert.equal(f.clock.timers.size, 0);
  assert.equal(f.composer.render, f.original); assert.equal((await f.probe.sample({ warmupMs: 0, durationMs: 100 })).reason, 'disposed');
});

test('a concurrent sample cannot reset or take ownership of the active sample', async () => {
  const f = fixture(); const first = f.probe.sample({ warmupMs: 0, durationMs: 100 });
  assert.equal((await f.probe.sample({ warmupMs: 0, durationMs: 100 })).reason, 'busy');
  f.composer.render(); f.clock.advance(98);
  assert.equal((await first).submissions.count, 1); f.probe.dispose();
});

test('probe failures do not replace original rendering and snapshots whitelist diagnostic metadata', async () => {
  const f = fixture(); (f.context as unknown as { privateKnowledge: string }).privateKnowledge = 'secret KG';
  f.renderer.info.reset = () => { throw new Error('instrumentation failure'); };
  const pending = f.probe.sample({ warmupMs: 0, durationMs: 100 });
  assert.equal(f.composer.render('still rendered').value, 'still rendered');
  const result = await pending; assert.equal(result.reason, 'probe-error');
  assert.doesNotMatch(JSON.stringify(result), /secret KG|privateKnowledge|userAgent|credential/);
  f.probe.dispose();
});
