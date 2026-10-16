import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Layout, Snapshot } from '../shared/types';
import type { GraphRenderQuality } from './graph-render-quality';
import type { GraphPerformanceProbe, GraphPerformanceReport, GraphPerformanceSnapshot } from './graph-performance';
import { createPerformanceFixture, PERFORMANCE_FIXTURE_ID, PERFORMANCE_NODE_COUNT, PERFORMANCE_EDGE_COUNT } from './performance-fixture';

export interface PerformanceGraphProps {
  snapshot: Snapshot; layout: Layout; selectedId: string | null; twoDimensional: boolean; glowEnabled: boolean;
  renderQuality: GraphRenderQuality; theme: 'dark' | 'light'; paused: boolean;
  onSelect: (id: string) => void; onLayoutChange: (layout: Layout) => void; onProbeReady: (probe: GraphPerformanceProbe | null) => void;
}
export interface PerformanceBenchmarkProps { renderGraph: (props: PerformanceGraphProps) => ReactNode }
interface RoundResult { round: number; report: GraphPerformanceReport; beforeUnmount: GraphPerformanceSnapshot; afterUnmount: GraphPerformanceSnapshot | null; afterRemount: GraphPerformanceSnapshot | null }
interface ProbeWaiter { generation: number; resolve: (probe: GraphPerformanceProbe) => void; reject: (error: Error) => void }
const number = (value: number | null) => value === null ? '—' : value.toFixed(2);
const resources = (value: GraphPerformanceSnapshot | null) => value
  ? `G ${value.resources.geometries ?? '—'} · T ${value.resources.textures ?? '—'} · P ${value.resources.programs ?? '—'}` : '—';

/** A manual synthetic harness; its graph adapter never receives API callbacks. */
export function PerformanceBenchmark({ renderGraph }: PerformanceBenchmarkProps) {
  const [fixture] = useState(createPerformanceFixture);
  const [layout, setLayout] = useState(fixture.layout);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [twoDimensional, setTwoDimensional] = useState(false);
  const [glowEnabled, setGlowEnabled] = useState(true);
  const [renderQuality, setRenderQuality] = useState<GraphRenderQuality>('standard');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [generation, setGeneration] = useState(0);
  const generationRef = useRef(0);
  const currentProbe = useRef<{ generation: number; probe: GraphPerformanceProbe } | null>(null);
  const waiters = useRef<ProbeWaiter[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const mounted = useRef(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('尚未开始。请选择配置后手动采样。');
  const [results, setResults] = useState<RoundResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const ready = useMemo(() => (probe: GraphPerformanceProbe | null) => {
    if (generation !== generationRef.current) return;
    currentProbe.current = probe ? { generation, probe } : null;
    if (probe) for (const waiter of [...waiters.current]) if (waiter.generation === generation) waiter.resolve(probe);
  }, [generation]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; controllerRef.current?.abort();
      for (const waiter of [...waiters.current]) waiter.reject(new Error('采样页面已关闭。'));
    };
  }, []);

  const waitForProbe = (expected: number, signal: AbortSignal): Promise<GraphPerformanceProbe> => {
    if (signal.aborted) return Promise.reject(new Error('已停止采样。'));
    if (currentProbe.current?.generation === expected) return Promise.resolve(currentProbe.current.probe);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); waiters.current = waiters.current.filter((entry) => entry !== waiter); };
      const waiter: ProbeWaiter = { generation: expected, resolve: (probe) => { cleanup(); resolve(probe); }, reject: (error) => { cleanup(); reject(error); } };
      const aborted = () => waiter.reject(new Error('已停止采样。'));
      timer = setTimeout(() => waiter.reject(new Error('渲染探针尚未就绪，请确认浏览器支持 WebGL 后重试。')), 10_000);
      signal.addEventListener('abort', aborted, { once: true }); waiters.current.push(waiter);
    });
  };
  const recreate = async (signal: AbortSignal) => {
    const next = ++generationRef.current; currentProbe.current = null;
    setLayout(createPerformanceFixture().layout); setGeneration(next);
    return waitForProbe(next, signal);
  };
  const run = async (mode: 'quick' | 'full') => {
    if (runningRef.current) return;
    runningRef.current = true; setRunning(true); setResults([]); setError(null); setSelectedId(null);
    const controller = new AbortController(); controllerRef.current = controller;
    const durationMs = mode === 'quick' ? 10_000 : 30_000;
    const rounds = mode === 'quick' ? 3 : 10;
    try {
      let probe = await recreate(controller.signal);
      for (let round = 1; round <= rounds && !controller.signal.aborted; round += 1) {
        if (mounted.current) setProgress(`第 ${round}/${rounds} 轮：预热 2 秒，再采样 ${durationMs / 1000} 秒。`);
        const report = await probe.sample({ warmupMs: 2000, durationMs, signal: controller.signal });
        const result: RoundResult = { round, report, beforeUnmount: probe.snapshot(), afterUnmount: null, afterRemount: null };
        if (mounted.current) setResults((current) => [...current, result]);
        // Changing this key destroys the old GraphView and its resources. The
        // following snapshot belongs to a newly created graph instance.
        const oldProbe = probe;
        probe = await recreate(controller.signal);
        const afterUnmount = oldProbe.snapshot();
        const afterRemount = probe.snapshot();
        if (mounted.current) setResults((current) => current.map((item) => item.round === round ? { ...item, afterUnmount, afterRemount } : item));
        if (report.status !== 'complete') {
          if (mounted.current) setProgress(`本轮未完成：${report.reason ?? 'unknown'}。已保留部分结果。`);
          return;
        }
      }
      if (mounted.current) setProgress(controller.signal.aborted ? '已停止，部分结果已保留。' : `已完成 ${rounds} 轮采样。`);
    } catch (caught) {
      if (mounted.current) {
        if (controller.signal.aborted) setProgress('已停止，部分结果已保留。');
        else setError(caught instanceof Error ? caught.message : '采样未完成，请重试。');
      }
    } finally {
      if (controller.signal.aborted && mounted.current) { currentProbe.current = null; setGeneration(++generationRef.current); setLayout(createPerformanceFixture().layout); }
      runningRef.current = false;
      if (mounted.current) setRunning(false);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  };
  const download = () => {
    const blob = new Blob([JSON.stringify({ format: 'living-memory-performance-benchmark', version: 1,
      fixture: { id: PERFORMANCE_FIXTURE_ID, nodes: PERFORMANCE_NODE_COUNT, edges: PERFORMANCE_EDGE_COUNT }, results }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'living-memory-performance.json'; anchor.click();
    URL.revokeObjectURL(url);
  };

  return <main className="performance-benchmark">
    <header><div><span className="eyebrow">固定合成数据 · 独立性能检查</span><h1>图谱渲染采样</h1>
      <p>{PERFORMANCE_NODE_COUNT} 个节点 · {PERFORMANCE_EDGE_COUNT} 条边 · 每轮重建图谱实例</p></div><a href="/">返回知识库</a></header>
    <section className="performance-controls" aria-label="性能采样配置">
      <label>视图<select value={twoDimensional ? '2d' : '3d'} disabled={running} onChange={(event) => setTwoDimensional(event.currentTarget.value === '2d')}><option value="3d">3D 纵深</option><option value="2d">2D 阅读</option></select></label>
      <label>光效<select value={glowEnabled ? 'on' : 'off'} disabled={running} onChange={(event) => setGlowEnabled(event.currentTarget.value === 'on')}><option value="on">开启发光</option><option value="off">关闭发光</option></select></label>
      <label>渲染档位<select value={renderQuality} disabled={running} onChange={(event) => setRenderQuality(event.currentTarget.value === 'low' ? 'low' : 'standard')}><option value="standard">标准</option><option value="low">节能</option></select></label>
      <label>主题<select value={theme} disabled={running} onChange={(event) => setTheme(event.currentTarget.value === 'light' ? 'light' : 'dark')}><option value="dark">深色</option><option value="light">浅色</option></select></label>
      <button type="button" disabled={running} onClick={() => void run('quick')}>快速采样：10 秒 × 3 轮</button>
      <button type="button" disabled={running} onClick={() => void run('full')}>完整采样：30 秒 × 10 轮</button>
      <button type="button" disabled={!running} onClick={() => controllerRef.current?.abort()}>停止采样</button>
      <button type="button" disabled={!results.length || running} onClick={download}>导出采样 JSON</button>
    </section>
    <p className="performance-progress" role="status">{progress}</p>
    {error ? <p role="alert">{error}</p> : null}
    <div className="performance-viewport" data-running={running ? 'true' : 'false'} key={generation}>
      {renderGraph({ snapshot: fixture.snapshot, layout, selectedId, twoDimensional, glowEnabled, renderQuality, theme, paused: false,
        onSelect: setSelectedId, onLayoutChange: (value) => { if (mounted.current) setLayout(value); }, onProbeReady: ready })}
    </div>
    <p className="performance-method">采样时可手动旋转、缩放和点击节点，工具不判断操作次数。提交频率来自实际 composer.render 正常完成次数；CPU 时间包含主线程提交耗时。对象数量分别为几何体、纹理和程序数量，不能据此计算显存或断言没有 GPU 泄漏。页面隐藏、暂停、WebGL 上下文丢失或手动停止会标记为未完成。</p>
    <section aria-label="采样结果"><h2>采样结果</h2>
      {!results.length ? <p>尚无结果。这里仅使用固定合成图谱，不读取私人知识或保存学习／布局记录。</p>
        : <div className="performance-table-scroll"><table><thead><tr><th>轮次</th><th>状态</th><th>提交/秒</th><th>间隔 p95 / ms</th><th>CPU p95 / ms</th><th>draw calls p95</th><th>销毁前对象数 G/T/P</th><th>销毁后对象数 G/T/P</th><th>重建后对象数 G/T/P</th><th>Canvas 前/销毁后/重建后</th></tr></thead>
          <tbody>{results.map((item) => <tr key={item.round}><td>{item.round}</td><td>{item.report.status === 'complete' ? '完成' : `未完成：${item.report.reason}`}</td>
            <td>{number(item.report.submissions.perSecond)}</td><td>{number(item.report.submissions.intervalMs.p95)}</td><td>{number(item.report.submissions.cpuMs.p95)}</td><td>{number(item.report.drawCalls.p95)}</td>
            <td>{resources(item.beforeUnmount)}</td><td>{resources(item.afterUnmount)}</td><td>{resources(item.afterRemount)}</td><td>{item.beforeUnmount.context?.canvasCount ?? '—'} / {item.afterUnmount?.context?.canvasCount ?? '—'} / {item.afterRemount?.context?.canvasCount ?? '—'}</td></tr>)}</tbody></table></div>}
    </section>
  </main>;
}
