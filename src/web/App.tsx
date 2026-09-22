import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Concept,
  Exposure,
  Layout,
  MemoryState,
  RecallRating,
  Snapshot,
  ObservationRequest,
  ReviewRequest,
} from '../shared/types';
import {
  ApiRequestError,
  api,
  flushPendingWrites,
  getPendingWrites,
  queuePendingWrite,
  subscribeToSessionRecovery,
  type PendingWrite,
  type PendingSyncResult,
} from './api';
import { GraphFallbackList, GraphView, STATUS_COLORS } from './GraphView';
import { createDemoRecord, extendDemoRecord, isDemoRecord, projectDemoSnapshot, type DemoRecord } from '../core/demo-snapshot';
import { DemoPanel } from './DemoPanel';
import { createDeferredChangeController, subscribeToChanges } from './change-sync';
import { chooseDomain, domainIdOf, domainLabel, getCrossDomainNeighbors, listDomains, mergeLayout, projectDomainView } from '../core/domain-view';
import { CrossDomainPanel, DomainPicker } from './DomainControls';
import { ConceptSearch } from './ConceptSearch';
import { PendingWritesPanel } from './PendingWritesPanel';
import { ConceptHistoryPanel } from './ConceptHistoryPanel';
import { useConceptHistory } from './useConceptHistory';
import { parseSourceExposure, sourceExposureKey, SOURCE_EXPOSURE_STORAGE_KEY } from './source-exposure';
import { createIdleRotationClock, trackRotationActivity, type RotationStatus } from './graph-rotation';
import type { ChangeNotification } from '../shared/types';
import { inspectLayout } from '../shared/layout';
import './styles.css';
import './concept-history.css';

const DAY_MS = 86_400_000;
const STATUS_LABELS: Record<MemoryState['status'], string> = {
  unknown: '尚未评估',
  recent: '近期重温',
  revisit: '建议再看',
  stale: '较久未重温',
  pending: '待确认',
};

type Notice = { tone: 'info' | 'success' | 'error'; text: string } | null;

function pendingSyncNotice(result: PendingSyncResult): Notice {
  const skipped = result.repairs?.reduce((sum, repair) => sum + repair.skippedPositions, 0) ?? 0;
  const repairNotice = skipped > 0 ? `已备份并修复旧布局，跳过 ${skipped} 个无效位置，保留这些节点的现有布局。` : '';
  const failure = result.failures[0];
  if (failure) {
    const progress = result.sent > 0 ? `已同步 ${result.sent} 条，另有 ${result.failed} 条未完成。` : '';
    return { tone: 'error', text: `${progress}${repairNotice}${failure.label}：${failure.message}` };
  }
  return result.sent > 0 ? { tone: 'success', text: `已同步 ${result.sent} 条待处理记录。${repairNotice}` } : null;
}

type RecallAttempt = {
  conceptId: string;
  eventId: string | null;
  answer: string;
  startedAt: string;
  observedAt: string | null;
  configRevision: number | null;
  anchorEventId: string | null;
  sourceRevision: string;
  sourceViewedBefore: boolean;
  stage: 'answer' | 'feedback';
  rating: RecallRating | null;
  exposure: Exposure;
};

function newEventId(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `lm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readDemoOffset(sourceId: string): number {
  try {
    const value = Number(window.localStorage.getItem(`living-memory.demo-offset.v1.${sourceId}`) ?? '0');
    return Number.isInteger(value) && value >= 0 && value <= 30 ? value : 0;
  } catch { return 0; }
}

function formatDate(value: string | null | undefined, includeTime = false): string {
  if (!value) return '暂无记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '日期未知';
  return new Intl.DateTimeFormat('zh-CN', includeTime ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function formatElapsed(days: number | null | undefined): string {
  if (days === null || days === undefined || !Number.isFinite(days)) return '尚无时间起点';
  if (days < 0) return '时间未开始';
  if (days < 1 / 24) return '刚刚';
  if (days < 1) return `${Math.max(1, Math.round(days * 24 * 60))} 分钟`;
  if (days < 30) return `${days.toFixed(days < 10 ? 1 : 0)} 天`;
  return `${(days / 30).toFixed(1)} 个月`;
}

function relativeSource(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const marker = normalized.toLowerCase().lastIndexOf('progressive-kg/');
  if (marker >= 0) return normalized.slice(marker + 'progressive-kg/'.length);
  const segments = normalized.split('/').filter(Boolean);
  return segments.slice(-3).join(' / ') || '来源路径未知';
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return '操作没有完成，请稍后重试。';
}

function Curve({ state, halfLifeDays }: { state: MemoryState; halfLifeDays: number }) {
  const width = 280;
  const height = 112;
  const padding = { top: 12, right: 12, bottom: 24, left: 28 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxDays = Math.max(1, halfLifeDays * 4);
  const points = Array.from({ length: 33 }, (_, index) => {
    const t = (maxDays * index) / 32;
    const yValue = Math.pow(2, -t / halfLifeDays);
    return `${padding.left + (t / maxDays) * plotWidth},${padding.top + (1 - yValue) * plotHeight}`;
  }).join(' ');
  const currentT = Math.min(maxDays, Math.max(0, state.elapsedDays ?? 0));
  const currentY = Math.pow(2, -currentT / halfLifeDays);
  const markerX = padding.left + (currentT / maxDays) * plotWidth;
  const markerY = padding.top + (1 - currentY) * plotHeight;
  const markerColor = STATUS_COLORS[state.status];
  return (
    <div className="curve-card">
      <div className="curve-heading">
        <span>重温时间指标</span>
        <span className="curve-h">H = {halfLifeDays} 天</span>
      </div>
      <svg className="memory-curve" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`半衰时间为 ${halfLifeDays} 天的重温时间指标曲线`}>
        <line x1={padding.left} y1={padding.top + plotHeight} x2={width - padding.right} y2={padding.top + plotHeight} className="curve-axis" />
        <line x1={padding.left} y1={padding.top} x2={padding.left} y2={padding.top + plotHeight} className="curve-axis" />
        <line x1={padding.left} y1={padding.top + plotHeight * 0.5} x2={width - padding.right} y2={padding.top + plotHeight * 0.5} className="curve-grid" />
        <polyline points={points} className="curve-line" />
        {state.elapsedDays !== null ? <line x1={markerX} y1={padding.top} x2={markerX} y2={padding.top + plotHeight} stroke={markerColor} strokeDasharray="3 4" opacity=".55" /> : null}
        {state.elapsedDays !== null ? <circle cx={markerX} cy={markerY} r="4" fill={markerColor} className="curve-marker" /> : null}
        <text x={padding.left - 7} y={padding.top + 4} className="curve-label" textAnchor="end">起点</text>
        <text x={padding.left - 7} y={padding.top + plotHeight * 0.5 + 4} className="curve-label" textAnchor="end">0.5</text>
        <text x={padding.left} y={height - 6} className="curve-label">0</text>
        <text x={width - padding.right} y={height - 6} className="curve-label" textAnchor="end">4H</text>
      </svg>
      <p className="curve-note">工程上的时间提醒，不能读作记忆百分比。</p>
    </div>
  );
}

function StatusBadge({ status }: { status: MemoryState['status'] }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span className="status-dot" />
      {STATUS_LABELS[status]}
    </span>
  );
}

function SourceBlock({ concept }: { concept: Concept }) {
  return (
    <div className="source-block">
      <div className="source-heading"><span>资料来源</span><span className="source-revision" title={concept.source.revision}>版本 {concept.source.revision.replace('sha256:', '').slice(0, 10)}</span></div>
      <div className="source-path" title="只显示相对来源，不展示本机根路径">{relativeSource(concept.source.path)}</div>
      <details className="content-details">
        <summary>展开核心摘要</summary>
        <p>{concept.summary || '此概念暂无摘要。'}</p>
      </details>
      <details className="content-details">
        <summary>展开完整资料</summary>
        <div className="source-body">{concept.body || '此概念暂无正文。'}</div>
      </details>
    </div>
  );
}

function EmptyPanel({ title, text }: { title: string; text: string }) {
  return <div className="empty-panel"><span className="empty-mark">✦</span><strong>{title}</strong><p>{text}</p></div>;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [layout, setLayout] = useState<Layout>({});
  const [writeToken, setWriteToken] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [demoEnabled, setDemoEnabled] = useState(true);
  const [demoRecord, setDemoRecord] = useState<DemoRecord | null>(null);
  const [demoSaved, setDemoSaved] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusRevision, setFocusRevision] = useState(0);
  const [simDays, setSimDays] = useState(0);
  const [twoDimensional, setTwoDimensional] = useState(false);
  const [glowEnabled, setGlowEnabled] = useState(true);
  const [autoRotateEnabled, setAutoRotateEnabled] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [rotationStatus, setRotationStatus] = useState<RotationStatus>({ kind: 'preparing', text: '等待图谱定位完成' });
  const [rotationClock] = useState(createIdleRotationClock);
  const [listMode, setListMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [pendingWrites, setPendingWrites] = useState<PendingWrite[]>([]);
  const [sourceViewedKeys, setSourceViewedKeys] = useState<string[]>([]);
  const [attempt, setAttempt] = useState<RecallAttempt | null>(null);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [estimatedDate, setEstimatedDate] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const [halfLifeDraft, setHalfLifeDraft] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [simulationLoading, setSimulationLoading] = useState(false);
  const [sourceReloadPending, setSourceReloadPending] = useState(false);
  const [activeDomainId, setActiveDomainId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const layoutRef = useRef<Layout>({});
  const activeDomainRef = useRef<string | null>(null);
  const layoutWriteTimer = useRef<number | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const snapshotRequestRef = useRef(0);
  const simulationBaseRef = useRef(Date.now());
  const reviewEventRef = useRef<{ conceptId: string; kind: 'review' | 'estimated'; occurredAt: string; eventId: string } | null>(null);
  const writeLockedRef = useRef(true);
  const sourceIdRef = useRef('');
  const writeTokenRef = useRef('');
  const pendingSourceIdRef = useRef<string | null>(null);
  const deferredChangeRef = useRef(createDeferredChangeController<ChangeNotification>());
  const sessionRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const changeUiRef = useRef({
    loading: true,
    hidden: false,
    demoEnabled: true,
    simulated: false,
    attempt: false,
    reviewDialogOpen: false,
    configOpen: false,
    busyAction: null as string | null,
    refreshing: false,
    simulationLoading: false,
    sourceReloadPending: false,
  });
  const changeHandlersRef = useRef<{
    onChange: (notification: ChangeNotification) => void;
    onConnected: (notification: ChangeNotification, reconnected: boolean) => void;
    flush: () => void;
  }>({ onChange: () => undefined, onConnected: () => undefined, flush: () => undefined });

  const realNow = new Date();
  const simulated = simDays > 0;
  const hasSession = Boolean(writeToken);
  activeDomainRef.current = activeDomainId;
  const writeLocked = demoEnabled || simulated || simulationLoading || sourceReloadPending;
  writeLockedRef.current = writeLocked;
  const asOf = simulated && !demoEnabled ? new Date(simulationBaseRef.current + simDays * DAY_MS).toISOString() : undefined;
  sourceIdRef.current = sourceId;
  writeTokenRef.current = writeToken;
  changeUiRef.current = {
    loading,
    hidden: typeof document !== 'undefined' && document.hidden,
    demoEnabled,
    simulated,
    attempt: Boolean(attempt),
    reviewDialogOpen,
    configOpen,
    busyAction,
    refreshing,
    simulationLoading,
    sourceReloadPending,
  };

  const refreshPendingState = useCallback(() => setPendingWrites(getPendingWrites(sourceId)), [sourceId]);

  const showNotice = useCallback((next: Notice) => {
    setNotice(next);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    if (next) noticeTimer.current = window.setTimeout(() => setNotice(null), 5_000);
  }, []);

  const loadSnapshot = useCallback(async (requestedAsOf?: string, expectedSourceId?: string, canApply?: () => boolean) => {
    const requestId = snapshotRequestRef.current + 1;
    snapshotRequestRef.current = requestId;
    const sourceAtRequest = expectedSourceId ?? sourceIdRef.current;
    const next = await api.getSnapshot(requestedAsOf, sourceAtRequest || undefined, 'all');
    if (requestId !== snapshotRequestRef.current) return null;
    if (sourceAtRequest && sourceIdRef.current !== sourceAtRequest) return null;
    if (canApply && !canApply()) return null;
    setSnapshot(next);
    if (!changeUiRef.current.configOpen) setHalfLifeDraft(String(next.config.halfLifeDays));
    setSelectedId((current) => (current && next.concepts.some((concept) => concept.id === current) ? current : null));
    return next;
  }, []);

  const loadInitial = useCallback(async (): Promise<Snapshot | null> => {
    const requestId = snapshotRequestRef.current + 1;
    snapshotRequestRef.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const session = await api.getSession();
      if (requestId !== snapshotRequestRef.current) return null;
      const currentSource = session.sourceId ?? 'legacy-unscoped';
      const [nextSnapshot, nextLayout] = await Promise.all([
        api.getSnapshot(undefined, currentSource, 'all'),
        api.getLayout(currentSource).catch(() => ({} as Layout)),
      ]);
      if (requestId !== snapshotRequestRef.current) return null;
      sourceIdRef.current = currentSource;
      writeTokenRef.current = session.writeToken;
      setWriteToken(session.writeToken);
      setSourceId(currentSource);
      setSnapshot(nextSnapshot);
      setLayout(nextLayout);
      layoutRef.current = nextLayout;
      let rememberedDomain: string | null = null;
      try { rememberedDomain = window.localStorage.getItem(`living-memory.domain.v1.${currentSource}`); } catch { /* In-memory selection still works. */ }
      const initialDomain = chooseDomain(nextSnapshot, rememberedDomain);
      activeDomainRef.current = initialDomain;
      setActiveDomainId(initialDomain);
      setExpandedIds([]);
      setHalfLifeDraft(String(nextSnapshot.config.halfLifeDays));
      setSelectedId(null);
      setFocusRevision(0);
      let initialDemo = createDemoRecord(nextSnapshot, currentSource);
      try {
        const storedDemo: unknown = JSON.parse(window.localStorage.getItem(`living-memory.demo-record.v1.${currentSource}`) ?? 'null');
        if (isDemoRecord(storedDemo, currentSource)) initialDemo = extendDemoRecord(nextSnapshot, storedDemo);
        window.localStorage.setItem(`living-memory.demo-record.v1.${currentSource}`, JSON.stringify(initialDemo));
        setDemoSaved(true);
        const enabled = window.localStorage.getItem(`living-memory.demo-enabled.v1.${currentSource}`) !== 'false';
        setDemoEnabled(enabled);
        setSimDays(enabled ? readDemoOffset(currentSource) : 0);
      } catch {
        setDemoSaved(false);
      }
      setDemoRecord(initialDemo);
      try {
        setSourceViewedKeys(parseSourceExposure(window.sessionStorage.getItem(SOURCE_EXPOSURE_STORAGE_KEY)));
      } catch {
        // Private browsing may deny sessionStorage; the in-memory marker still works.
      }
      setPendingWrites(getPendingWrites(currentSource));
      return nextSnapshot;
    } catch (loadError) {
      if (requestId === snapshotRequestRef.current) setError(errorMessage(loadError));
      return null;
    } finally {
      if (requestId === snapshotRequestRef.current) setLoading(false);
    }
  }, []);

  const canApplyChange = useCallback(() => {
    const ui = changeUiRef.current;
    return (
      !ui.loading &&
      !ui.hidden &&
      !ui.demoEnabled &&
      !ui.simulated &&
      !ui.attempt &&
      !ui.reviewDialogOpen &&
      !ui.configOpen &&
      !ui.busyAction &&
      !ui.refreshing &&
      !ui.simulationLoading &&
      !ui.sourceReloadPending
    );
  }, []);

  const markSourceMismatch = useCallback((nextSourceId: string) => {
    if (pendingSourceIdRef.current === nextSourceId) return;
    pendingSourceIdRef.current = nextSourceId;
    deferredChangeRef.current.clear();
    writeTokenRef.current = '';
    changeUiRef.current.sourceReloadPending = true;
    setWriteToken('');
    setSourceReloadPending(true);
  }, []);

  useEffect(() => subscribeToSessionRecovery((event) => {
    if (event.kind === 'source-mismatch') {
      markSourceMismatch(event.sourceId ?? 'changed-source');
      return;
    }
    if (pendingSourceIdRef.current) return;
    if (sourceIdRef.current !== event.session.sourceId) {
      markSourceMismatch(event.session.sourceId);
      return;
    }
    // Credential renewal must not reload the form or alter the frozen event.
    writeTokenRef.current = event.session.writeToken;
    setWriteToken(event.session.writeToken);
  }), [markSourceMismatch]);

  const flushDeferredChanges = useCallback(() => {
    if (!canApplyChange() || sourceReloadPending || pendingSourceIdRef.current) return;
    const operation = deferredChangeRef.current.begin();
    if (!operation) return;
    const pending = operation.value;

    const currentSource = sourceIdRef.current;
    if (!currentSource) {
      operation.settle(false);
      return;
    }
    if (pending.sourceId !== currentSource) {
      markSourceMismatch(pending.sourceId);
      operation.settle(false);
      return;
    }

    const task = (async (): Promise<boolean> => {
      const nextSnapshot = await loadSnapshot(undefined, currentSource, canApplyChange);
      if (!nextSnapshot || sourceIdRef.current !== currentSource) return false;
      return true;
    })();
    const finish = (succeeded: boolean) => {
      const shouldRetry = operation.settle(succeeded);
      if (shouldRetry && canApplyChange()) {
        window.setTimeout(() => changeHandlersRef.current.flush(), 0);
      }
    };
    void task.then((succeeded) => finish(succeeded), (changeError) => {
      showNotice({ tone: 'error', text: errorMessage(changeError) });
      finish(false);
    });
  }, [canApplyChange, loadSnapshot, markSourceMismatch, sourceReloadPending]);

  const handleChange = useCallback((notification: ChangeNotification) => {
    const currentSource = sourceIdRef.current;
    if (currentSource && notification.sourceId !== currentSource) {
      markSourceMismatch(notification.sourceId);
      return;
    }
    if (sourceReloadPending) return;
    deferredChangeRef.current.defer(notification);
    if (canApplyChange()) changeHandlersRef.current.flush();
  }, [canApplyChange, markSourceMismatch, sourceReloadPending]);

  const handleConnected = useCallback((notification: ChangeNotification, reconnected: boolean) => {
    if (!reconnected) {
      const currentSource = sourceIdRef.current;
      if (currentSource && notification.sourceId !== currentSource) {
        markSourceMismatch(notification.sourceId);
        return;
      }
      if (sourceReloadPending) return;
      deferredChangeRef.current.defer(notification);
      if (canApplyChange()) changeHandlersRef.current.flush();
      return;
    }
    if (sessionRefreshInFlightRef.current) return;
    const task = (async () => {
      try {
        const session = await api.getSession();
        const nextSource = session.sourceId ?? 'legacy-unscoped';
        const currentSource = sourceIdRef.current;
        const sourceChanged = Boolean(currentSource && nextSource !== currentSource);
        if (sourceChanged || pendingSourceIdRef.current) {
          if (sourceChanged) markSourceMismatch(nextSource);
          return;
        }
        pendingSourceIdRef.current = null;
        sourceIdRef.current = nextSource;
        setSourceId(nextSource);
        writeTokenRef.current = session.writeToken;
        setWriteToken(session.writeToken);
        deferredChangeRef.current.defer({ ...notification, sourceId: nextSource, reason: 'connected' as const });
        changeHandlersRef.current.flush();
      } catch (sessionError) {
        showNotice({ tone: 'error', text: errorMessage(sessionError) });
      }
    })();
    sessionRefreshInFlightRef.current = task;
    void task.then(() => {
      if (sessionRefreshInFlightRef.current === task) sessionRefreshInFlightRef.current = null;
    }, () => {
      if (sessionRefreshInFlightRef.current === task) sessionRefreshInFlightRef.current = null;
    });
  }, [canApplyChange, markSourceMismatch, showNotice, sourceReloadPending]);

  changeHandlersRef.current = {
    onChange: handleChange,
    onConnected: handleConnected,
    flush: flushDeferredChanges,
  };

  useEffect(() => {
    return subscribeToChanges({
      onChange: (notification) => changeHandlersRef.current.onChange(notification),
      onConnected: (notification, reconnected) => changeHandlersRef.current.onConnected(notification, reconnected),
    });
  }, []);

  useEffect(() => {
    const resume = () => {
      changeUiRef.current.hidden = typeof document !== 'undefined' && document.hidden;
      if (!changeUiRef.current.hidden) changeHandlersRef.current.flush();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
    };
  }, []);

  useEffect(() => {
    changeHandlersRef.current.flush();
  }, [attempt, busyAction, configOpen, demoEnabled, loading, refreshing, reviewDialogOpen, simulated, simulationLoading, sourceId, sourceReloadPending, writeToken]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => trackRotationActivity(document, window, rotationClock, () => performance.now()), [rotationClock]);

  useEffect(() => {
    const onPending = () => refreshPendingState();
    window.addEventListener('lm-pending-changed', onPending);
    window.addEventListener('online', onPending);
    return () => {
      window.removeEventListener('lm-pending-changed', onPending);
      window.removeEventListener('online', onPending);
    };
  }, [refreshPendingState]);

  useEffect(() => {
    if (!writeToken) return undefined;
    const timer = window.setInterval(() => {
      if (canApplyChange() && !pendingSourceIdRef.current) {
        const queued = deferredChangeRef.current.peek();
        const queuedRevision = queued?.sourceId === sourceIdRef.current ? queued.revision : null;
        void loadSnapshot(undefined, sourceIdRef.current, canApplyChange).then((nextSnapshot) => {
          const after = deferredChangeRef.current.peek();
          if (nextSnapshot && queuedRevision !== null && after?.sourceId === sourceIdRef.current && after.revision <= queuedRevision) deferredChangeRef.current.clear();
        }).catch((tickError) => {
          showNotice({ tone: 'error', text: errorMessage(tickError) });
        });
      }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [canApplyChange, loadSnapshot, showNotice, writeToken]);

  useEffect(() => {
    if (demoEnabled) {
      setSimulationLoading(false);
      return undefined;
    }
    if (!hasSession || !snapshot) return undefined;
    if (sourceReloadPending) return undefined;
    let cancelled = false;
    setSimulationLoading(true);
    void loadSnapshot(asOf).catch((simulationError) => {
      if (!cancelled) showNotice({ tone: 'error', text: errorMessage(simulationError) });
    }).finally(() => {
      if (!cancelled) setSimulationLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [asOf, demoEnabled, hasSession, loadSnapshot, showNotice, simDays, sourceReloadPending]);

  useEffect(() => {
    if (writeLocked && layoutWriteTimer.current !== null) {
      window.clearTimeout(layoutWriteTimer.current);
      layoutWriteTimer.current = null;
    }
  }, [writeLocked]);

  useEffect(() => {
    if (writeLocked || !writeToken || !sourceId || pendingWrites.length === 0) return undefined;
    const retry = () => {
      void flushPendingWrites(writeToken, sourceId).then(async (result) => {
        if (sourceIdRef.current !== sourceId) return;
        refreshPendingState();
        const notice = pendingSyncNotice(result);
        showNotice(notice);
        if (result.sent > 0) {
          try { await loadSnapshot(); } catch (error) {
            showNotice({ tone: 'error', text: `${notice?.text ?? ''} 页面状态刷新失败：${errorMessage(error)}` });
          }
        }
      }).catch((error) => {
        showNotice({ tone: 'error', text: `重试未完成：${errorMessage(error)}` });
      });
    };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [loadSnapshot, pendingWrites.length, refreshPendingState, showNotice, sourceId, writeLocked, writeToken]);

  useEffect(() => {
    return () => {
      if (layoutWriteTimer.current !== null) window.clearTimeout(layoutWriteTimer.current);
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    };
  }, []);

  const pendingConceptIds = useMemo(() => new Set(pendingWrites.map((item) => item.conceptId).filter((id): id is string => Boolean(id))), [pendingWrites]);
  const displaySnapshot = useMemo(() => {
    if (snapshot && demoEnabled && demoRecord) return projectDemoSnapshot(snapshot, demoRecord, simDays);
    if (!snapshot || pendingConceptIds.size === 0) return snapshot;
    const states = { ...snapshot.states };
    for (const conceptId of pendingConceptIds) {
      const current = states[conceptId];
      if (current) states[conceptId] = { ...current, status: 'pending', reason: '本地记录等待同步' };
    }
    return { ...snapshot, states };
  }, [demoEnabled, demoRecord, pendingConceptIds, simDays, snapshot]);

  const domains = useMemo(() => snapshot ? listDomains(snapshot) : [], [snapshot]);
  const domainId = useMemo(() => snapshot ? chooseDomain(snapshot, activeDomainId) : null, [activeDomainId, snapshot]);
  const viewSnapshot = useMemo(() => displaySnapshot && domainId
    ? projectDomainView(displaySnapshot, domainId, { selectedId, expandedIds })
    : displaySnapshot, [displaySnapshot, domainId, expandedIds, selectedId]);
  const visibleIds = useMemo(() => viewSnapshot?.concepts.map((concept) => concept.id) ?? [], [viewSnapshot]);
  const visibleExpandedIds = useMemo(() => viewSnapshot?.concepts.filter((concept) => domainIdOf(concept) !== domainId).map((concept) => concept.id) ?? [], [domainId, viewSnapshot]);
  const domainBusy = Boolean(attempt) || reviewDialogOpen || configOpen || Boolean(busyAction) || refreshing || loading || simulationLoading || sourceReloadPending;

  // Source refreshes may remove a domain or a relation. Reconcile only when no
  // answer/dialog is active, and never turn a view change into a learning event.
  useEffect(() => {
    if (domainBusy || !viewSnapshot) return;
    if (activeDomainId !== domainId) setActiveDomainId(domainId);
    // No selection is a valid overview state, not a request to pick the first node.
    if (selectedId && !visibleIds.includes(selectedId)) {
      setSelectedId(null);
      setFocusRevision(0);
    }
    if (expandedIds.length !== visibleExpandedIds.length || expandedIds.some((id) => !visibleExpandedIds.includes(id))) setExpandedIds(visibleExpandedIds);
  }, [activeDomainId, domainBusy, domainId, expandedIds, selectedId, viewSnapshot, visibleExpandedIds, visibleIds]);

  const selectedConcept = useMemo(() => snapshot?.concepts.find((concept) => concept.id === selectedId) ?? null, [selectedId, snapshot]);
  const selectedSourceViewed = Boolean(selectedConcept && sourceViewedKeys.includes(sourceExposureKey(sourceId, selectedConcept)));
  const historyEnabled = Boolean(selectedConcept && sourceId && !demoEnabled && !attempt && !sourceReloadPending);
  const conceptHistory = useConceptHistory({
    sourceId, conceptId: selectedConcept?.id ?? '', sourceRevision: selectedConcept?.source.revision ?? '',
  }, historyEnabled, snapshot);
  const pendingLearningCount = pendingWrites.filter((write) => write.conceptId === selectedId
    && (write.path === '/reviews' || write.path === '/observations')).length;
  const selectedState = useMemo(() => {
    if (!selectedId || !displaySnapshot) return null;
    return displaySnapshot.states[selectedId] ?? null;
  }, [displaySnapshot, selectedId]);
  const crossDomainNeighbors = useMemo(() => snapshot && selectedId ? getCrossDomainNeighbors(snapshot, selectedId) : [], [selectedId, snapshot]);

  const listedConcepts = useMemo(() => {
    if (!displaySnapshot) return [];
    const matches = displaySnapshot.concepts.filter((concept) =>
      domainIdOf(concept) === domainId || visibleExpandedIds.includes(concept.id));
    return matches.sort((left, right) => {
      const leftState = displaySnapshot.states[left.id];
      const rightState = displaySnapshot.states[right.id];
      const rank: Record<MemoryState['status'], number> = { stale: 0, revisit: 1, unknown: 2, pending: 3, recent: 4 };
      return (rank[leftState?.status ?? 'unknown'] - rank[rightState?.status ?? 'unknown']) || left.title.localeCompare(right.title, 'zh-CN');
    });
  }, [displaySnapshot, domainId, visibleExpandedIds]);

  const changeDomain = useCallback((nextDomainId: string, targetId?: string) => {
    if (domainBusy || !snapshot || !domains.some((domain) => domain.id === nextDomainId)) return;
    if (layoutWriteTimer.current !== null) {
      window.clearTimeout(layoutWriteTimer.current);
      layoutWriteTimer.current = null;
    }
    const target = targetId
      ? snapshot.concepts.find((concept) => concept.id === targetId && domainIdOf(concept) === nextDomainId)
      : undefined;
    activeDomainRef.current = nextDomainId;
    setActiveDomainId(nextDomainId);
    setExpandedIds([]);
    setSelectedId(target?.id ?? null);
    setFocusRevision((revision) => target ? revision + 1 : 0);
    reviewEventRef.current = null;
    try { window.localStorage.setItem(`living-memory.domain.v1.${sourceId}`, nextDomainId); } catch {
      showNotice({ tone: 'info', text: '已切换知识域；浏览器未允许记住这次选择。' });
    }
  }, [domainBusy, domains, showNotice, snapshot, sourceId]);

  const canExpand = !domainBusy && selectedConcept !== null && domainIdOf(selectedConcept) === domainId
    && visibleExpandedIds.length < 6 && visibleIds.length < 300;
  const toggleExpanded = useCallback((id: string) => {
    if (domainBusy) return;
    if (visibleExpandedIds.includes(id)) {
      setExpandedIds((current) => current.filter((value) => value !== id));
      return;
    }
    if (!canExpand || !crossDomainNeighbors.some((neighbor) => neighbor.concept.id === id)) return;
    setExpandedIds((current) => [...new Set([...current, id])]);
  }, [canExpand, crossDomainNeighbors, domainBusy, visibleExpandedIds]);

  const markSourceViewed = useCallback((conceptId: string) => {
    const concept = snapshot?.concepts.find((item) => item.id === conceptId);
    if (!concept || !sourceId) return;
    const key = sourceExposureKey(sourceId, concept);
    setSourceViewedKeys((current) => {
      if (current.includes(key)) return current;
      const next = [...current, key];
      try {
        window.sessionStorage.setItem(SOURCE_EXPOSURE_STORAGE_KEY, JSON.stringify(next));
      } catch {
        showNotice({ tone: 'info', text: '本次查看已在当前页面标记；浏览器未允许保存会话标记。' });
      }
      return next;
    });
  }, [showNotice, snapshot, sourceId]);

  const selectConcept = useCallback((conceptId: string) => {
    if (attempt && attempt.conceptId !== conceptId) {
      if (!window.confirm('当前回忆尚未保存，确定取消并切换概念吗？')) return;
      setAttempt(null);
    }
    setSelectedId(conceptId);
    setFocusRevision((revision) => revision + 1);
  }, [attempt]);

  const selectSearchResult = useCallback((conceptId: string) => {
    if (domainBusy) return;
    const concept = snapshot?.concepts.find((item) => item.id === conceptId);
    if (!concept) return;
    const targetDomain = domainIdOf(concept);
    if (targetDomain !== domainId) changeDomain(targetDomain, conceptId);
    else selectConcept(conceptId);
  }, [changeDomain, domainBusy, domainId, selectConcept, snapshot]);

  const clearSelection = useCallback(() => {
    if (domainBusy) return;
    setSelectedId(null);
    setFocusRevision(0);
    reviewEventRef.current = null;
  }, [domainBusy]);

  const reloadRealSnapshot = useCallback(async () => {
    if (simulated) return;
    setRefreshing(true);
    try {
      await loadSnapshot();
      setError(null);
    } catch (refreshError) {
      setError(errorMessage(refreshError));
    } finally {
      setRefreshing(false);
    }
  }, [loadSnapshot, simulated]);

  const refreshSource = useCallback(async () => {
    if (!writeToken || writeLocked || attempt) return;
    setRefreshing(true);
    try {
      await api.refresh(writeToken, sourceId);
      await loadSnapshot();
      setError(null);
      showNotice({ tone: 'success', text: '知识源与时间状态已刷新。' });
    } catch (refreshError) {
      showNotice({ tone: 'error', text: errorMessage(refreshError) });
    } finally {
      setRefreshing(false);
    }
  }, [attempt, loadSnapshot, showNotice, sourceId, writeLocked, writeToken]);

  const writeWithRetry = useCallback(async (options: {
    path: '/reviews' | '/observations' | '/config' | '/layout';
    method: 'POST' | 'PUT';
    payload: unknown;
    eventId: string | null;
    conceptId: string | null;
    label: string;
    send: () => Promise<unknown>;
  }) => {
    try {
      const result = await options.send();
      refreshPendingState();
      return { ok: true, result };
    } catch (writeError) {
      const retryable = writeError instanceof ApiRequestError && writeError.retryable;
      if (retryable) {
        const queued = queuePendingWrite(sourceId, { method: options.method, path: options.path, payload: options.payload, eventId: options.eventId, conceptId: options.conceptId, label: options.label });
        if (queued) {
          refreshPendingState();
          showNotice({ tone: 'info', text: '网络暂时不可用，原记录已保存到待同步队列。' });
          return { ok: false, queued: true };
        }
        showNotice({ tone: 'error', text: '网络暂时不可用，这条记录尚未保存；请保持当前页面并重试。' });
        return { ok: false, queued: false, unsaved: true };
      }
      showNotice({ tone: 'error', text: errorMessage(writeError) });
      return { ok: false, queued: false };
    }
  }, [refreshPendingState, showNotice, sourceId]);

  const submitReview = useCallback(async (kind: 'review' | 'estimated', requestedOccurredAt?: string) => {
    if (!snapshot || !selectedConcept || !writeToken || writeLocked) return;
    const eventId = newEventId();
    const occurredAt = kind === 'review' ? new Date().toISOString() : new Date(`${requestedOccurredAt ?? ''}T12:00:00`).toISOString();
    const existing = reviewEventRef.current;
    const stableEvent = existing && existing.conceptId === selectedConcept.id && existing.kind === kind && (kind === 'review' || existing.occurredAt === occurredAt)
      ? existing
      : { conceptId: selectedConcept.id, kind, occurredAt, eventId };
    reviewEventRef.current = stableEvent;
    const payload: ReviewRequest = {
      eventId: stableEvent.eventId,
      conceptId: selectedConcept.id,
      sourceRevision: selectedConcept.source.revision,
      kind,
      occurredAt: stableEvent.occurredAt,
    };
    setBusyAction('review');
    const result = await writeWithRetry({
      path: '/reviews',
      method: 'POST',
      payload,
      eventId: stableEvent.eventId,
      conceptId: selectedConcept.id,
      label: kind === 'estimated' ? '补记重温' : '确认重温',
      send: () => api.postReview(payload, writeToken, sourceId),
    });
    setBusyAction(null);
    if (result.ok || result.queued) setReviewDialogOpen(false);
    if (result.ok) {
      reviewEventRef.current = null;
      showNotice({ tone: 'success', text: kind === 'estimated' ? '已保存一条估计的过去重温。' : '已确认重温，时间起点已更新。' });
      await reloadRealSnapshot();
    }
  }, [reloadRealSnapshot, selectedConcept, showNotice, snapshot, sourceId, writeLocked, writeToken, writeWithRetry]);

  const startRecall = useCallback(() => {
    if (!snapshot || !selectedConcept || !selectedState || writeLocked || attempt) return;
    setAttempt({
      conceptId: selectedConcept.id,
      eventId: null,
      answer: '',
      startedAt: new Date().toISOString(),
      observedAt: null,
      configRevision: null,
      anchorEventId: selectedState.anchor?.eventId ?? null,
      sourceRevision: selectedConcept.source.revision,
      sourceViewedBefore: selectedSourceViewed,
      stage: 'answer',
      rating: null,
      exposure: selectedSourceViewed ? 'exposed' : 'unknown',
    });
  }, [attempt, selectedConcept, selectedState, selectedSourceViewed, snapshot, writeLocked]);

  const submitRecallAnswer = useCallback(() => {
    if (!attempt || !snapshot || attempt.stage !== 'answer') return;
    markSourceViewed(attempt.conceptId);
    setAttempt({
      ...attempt,
      stage: 'feedback',
      observedAt: new Date().toISOString(),
      configRevision: snapshot.config.revision,
    });
  }, [attempt, markSourceViewed, snapshot]);

  const saveObservation = useCallback(async () => {
    if (!attempt || !selectedConcept || !snapshot || !writeToken || writeLocked || attempt.stage !== 'feedback' || !attempt.rating || !attempt.observedAt) return;
    const eventId = attempt.eventId ?? newEventId();
    const payload: ObservationRequest = {
      eventId,
      conceptId: selectedConcept.id,
      sourceRevision: attempt.sourceRevision,
      observedAt: attempt.observedAt,
      configRevision: attempt.configRevision ?? snapshot.config.revision,
      anchorEventId: attempt.anchorEventId,
      answer: attempt.answer,
      rating: attempt.rating,
      exposure: attempt.exposure,
      observedExposure: attempt.sourceViewedBefore,
    };
    setBusyAction('observation');
    const result = await writeWithRetry({
      path: '/observations',
      method: 'POST',
      payload,
      eventId: payload.eventId,
      conceptId: selectedConcept.id,
      label: '回忆观察',
      send: () => api.postObservation(payload, writeToken, sourceId),
    });
    if (!result.ok) setAttempt({ ...attempt, eventId });
    setBusyAction(null);
    if (result.ok) {
      setAttempt(null);
      showNotice({ tone: 'success', text: '观察已记录；它暂时不会改变重温时间曲线。' });
      await reloadRealSnapshot();
    }
  }, [attempt, reloadRealSnapshot, selectedConcept, showNotice, snapshot, sourceId, writeLocked, writeToken, writeWithRetry]);

  const saveConfig = useCallback(async () => {
    if (!snapshot || !writeToken || writeLocked || attempt) return;
    const halfLifeDays = Number(halfLifeDraft);
    if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0 || halfLifeDays > 3650) {
      showNotice({ tone: 'error', text: '半衰时间应为 0 到 3650 天之间的正数。' });
      return;
    }
    setBusyAction('config');
    const payload = { halfLifeDays, revision: snapshot.config.revision };
    const result = await writeWithRetry({ path: '/config', method: 'PUT', payload, eventId: null, conceptId: null, label: '更新半衰时间', send: () => api.putConfig(payload, writeToken, sourceId) });
    setBusyAction(null);
    if (result.ok) {
      setConfigOpen(false);
      showNotice({ tone: 'success', text: `已更新全局 H = ${halfLifeDays} 天。` });
      await reloadRealSnapshot();
    }
  }, [attempt, halfLifeDraft, reloadRealSnapshot, showNotice, snapshot, sourceId, writeLocked, writeToken, writeWithRetry]);

  const saveLayout = useCallback((next: Layout) => {
    if (writeLockedRef.current || !writeToken || activeDomainRef.current !== domainId) return;
    const inspected = inspectLayout(next);
    if (!inspected || Object.keys(inspected.layout).length === 0) return;
    const payload = inspected.layout;
    const merged = mergeLayout(layoutRef.current, payload);
    layoutRef.current = merged;
    setLayout(merged);
    if (layoutWriteTimer.current !== null) window.clearTimeout(layoutWriteTimer.current);
    layoutWriteTimer.current = window.setTimeout(() => {
      if (writeLockedRef.current || sourceIdRef.current !== sourceId || activeDomainRef.current !== domainId || !writeTokenRef.current) return;
      const currentToken = writeTokenRef.current;
      void writeWithRetry({ path: '/layout', method: 'PUT', payload, eventId: null, conceptId: null, label: '保存图谱布局', send: () => api.putLayout(payload, currentToken, sourceId) });
    }, 1_200);
  }, [domainId, sourceId, writeLocked, writeToken, writeWithRetry]);

  const exportData = useCallback(async () => {
    if (!writeToken) return;
    setBusyAction('export');
    try {
      const blob = await api.exportData(writeToken, sourceId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `living-memory-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      showNotice({ tone: 'success', text: '导出已开始下载。' });
    } catch (exportError) {
      showNotice({ tone: 'error', text: errorMessage(exportError) });
    } finally {
      setBusyAction(null);
    }
  }, [showNotice, sourceId, writeToken]);

  const retryPending = useCallback(async () => {
    if (!writeToken || !sourceId || writeLocked || pendingWrites.length === 0) return;
    setBusyAction('pending');
    try {
      const result = await flushPendingWrites(writeToken, sourceId);
      if (sourceIdRef.current !== sourceId) return;
      refreshPendingState();
      const notice = pendingSyncNotice(result);
      showNotice(notice);
      if (result.sent > 0) {
        try { await loadSnapshot(); } catch (error) {
          showNotice({ tone: 'error', text: `${notice?.text ?? ''} 页面状态刷新失败：${errorMessage(error)}` });
        }
      }
    } catch (error) {
      showNotice({ tone: 'error', text: `重试未完成：${errorMessage(error)}` });
    } finally { setBusyAction(null); }
  }, [loadSnapshot, pendingWrites.length, refreshPendingState, showNotice, sourceId, writeLocked, writeToken]);

  const setSimulatedDays = (value: number) => {
    if (attempt || sourceReloadPending) return;
    setSimDays(value);
    if (demoEnabled) {
      try {
        window.localStorage.setItem(`living-memory.demo-offset.v1.${sourceId}`, String(value));
      } catch { /* The initial record remains exportable even without storage. */ }
    }
  };

  const changeDemoMode = (enabled: boolean) => {
    if (attempt || sourceReloadPending) return;
    writeLockedRef.current = true;
    setSimulationLoading(!enabled);
    setSimDays(enabled ? readDemoOffset(sourceId) : 0);
    simulationBaseRef.current = Date.now();
    setConfigOpen(false);
    setReviewDialogOpen(false);
    setDemoEnabled(enabled);
    try {
      window.localStorage.setItem(`living-memory.demo-enabled.v1.${sourceId}`, String(enabled));
    } catch { /* The mode can still change for this page. */ }
  };

  const exportDemo = () => {
    if (!demoRecord || !displaySnapshot) return;
    const data = { kind: 'living-memory-demo', record: demoRecord, preview: { offsetDays: simDays, asOf: displaySnapshot.asOf, states: displaySnapshot.states } };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `living-memory-demo-${demoRecord.baseAsOf.slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return <div className="loading-screen"><div className="loading-orbit"><span /></div><strong>正在唤醒你的知识图谱</strong><span>读取本地知识与时间状态…</span></div>;
  }

  if (error && !snapshot) {
    return (
      <div className="error-screen">
        <span className="error-glyph">∿</span>
        <h1>无法连接 Living Memory</h1>
        <p>{error}</p>
        <button type="button" className="primary-button" onClick={() => void loadInitial()}>重新连接</button>
        <p className="error-hint">请确认本地服务已启动；知识与学习数据仍由服务端管理。</p>
      </div>
    );
  }

  if (!snapshot || !displaySnapshot || !viewSnapshot) return null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><span /><span /><span /></div>
          <div><div className="brand-name">Living Memory</div><div className="brand-subtitle">时间图谱 · 个人知识记忆</div></div>
        </div>
        <div className="topbar-center">
          <span className={`source-pill source-${snapshot.source.mode}`}><span className="source-pulse" />{snapshot.source.mode === 'demo' ? 'Demo 知识库' : '本地知识库'}</span>
          <span className="topbar-separator">/</span>
          <span className="graph-count">{domains.length} 个知识域 · 全库 {snapshot.source.conceptCount} 个概念</span>
        </div>
        <div className="topbar-actions">
          <button type="button" className="quiet-button" onClick={() => void refreshSource()} disabled={refreshing || writeLocked || Boolean(attempt)} aria-label="刷新知识源与时间状态"><span className={refreshing ? 'spin' : ''}>↻</span><span>刷新</span></button>
          <button type="button" className="quiet-button" onClick={() => void exportData()} disabled={demoEnabled || busyAction === 'export'} aria-label="导出学习数据" title="下载已同步的学习记录、参数和布局，用于留档与分析。不含知识正文及待同步记录；暂不支持导入恢复。"><span aria-hidden="true">⇩</span><span>导出学习数据</span></button>
          <button type="button" className={`config-button${configOpen ? ' is-open' : ''}`} onClick={() => setConfigOpen((open) => !open)} disabled={Boolean(attempt) || writeLocked}>H = {displaySnapshot.config.halfLifeDays} 天 <span>⌄</span></button>
          {configOpen ? (
            <div className="config-popover">
              <div className="popover-kicker">时间模型 · {snapshot.config.modelVersion}</div>
              <label htmlFor="half-life">全局半衰时间 H（天）</label>
              <div className="config-form"><input id="half-life" type="number" min="0.1" max="3650" step="0.5" value={halfLifeDraft} onChange={(event) => setHalfLifeDraft(event.target.value)} /><button type="button" className="primary-button small" onClick={() => void saveConfig()} disabled={busyAction === 'config'}>保存</button></div>
              <p>当前只用于重温时间提示，不会自动拟合个人遗忘率。</p>
            </div>
          ) : null}
        </div>
      </header>

      {sourceReloadPending ? <div className="mode-bar source-reload-banner" role="alert"><div><strong>知识源已变化</strong><span>请完成当前输入后重新加载页面。</span></div></div> : null}

      <div className={`mode-bar${demoEnabled ? ' is-demo' : ''}`}>
        <div><strong>{demoEnabled ? '示例状态 · 非真实记忆' : '真实学习记录'}</strong><span>{demoEnabled ? '虚构重温间隔，拖动时间轴查看颜色变化' : '由你确认的学习与重温记录计算'}</span></div>
        <div className="mode-actions">{demoEnabled ? <button type="button" onClick={exportDemo}>导出模拟记录</button> : null}<button type="button" onClick={() => changeDemoMode(!demoEnabled)} disabled={Boolean(attempt) || busyAction !== null || sourceReloadPending}>{demoEnabled ? '查看真实记录' : '查看示例状态'}</button></div>
      </div>
      <div className="domain-view-bar">
        <DomainPicker domains={domains} value={domainId ?? ''} onChange={changeDomain} disabled={domainBusy} />
        <span className="domain-view-summary">当前域 {domains.find((domain) => domain.id === domainId)?.conceptCount ?? 0} 个概念 · 图中 {visibleIds.length} 个节点{visibleExpandedIds.length > 0 ? `（含 ${visibleExpandedIds.length} 个跨域节点）` : ''}</span>
        {visibleExpandedIds.length > 0 ? <button type="button" className="quiet-button" disabled={domainBusy} onClick={() => {
          setExpandedIds([]);
          if (selectedConcept && domainIdOf(selectedConcept) !== domainId) {
            clearSelection();
          }
        }}>收起跨域节点</button> : null}
      </div>
      <main className={`workspace${attempt ? ' workspace-recall-hidden' : ''}`} aria-hidden={attempt ? true : undefined} inert={attempt ? true : undefined}>
        <aside className="left-panel">
          <div className="panel-heading"><div><span className="eyebrow">知识空间</span><h1>概念索引</h1></div><span className="count-chip">{listedConcepts.length}</span></div>
          <ConceptSearch key={sourceId} concepts={snapshot.concepts} currentDomainId={domainId} disabled={domainBusy} onSelect={selectSearchResult} />
          <div className="list-meta"><span>当前领域 · 按时间状态排序</span><span className="pending-inline">{pendingWrites.length > 0 ? `待同步 ${pendingWrites.length}` : ''}</span></div>
          <div className="concept-list" aria-label="概念列表">
            {listedConcepts.map((concept) => {
              const state = displaySnapshot.states[concept.id] ?? { status: 'unknown' as const };
              return <button type="button" key={concept.id} className={`concept-row${selectedId === concept.id ? ' is-selected' : ''}`} onClick={() => selectConcept(concept.id)}><span className="row-status" style={{ '--status-color': STATUS_COLORS[state.status] } as React.CSSProperties}><span /></span><span className="row-content"><strong>{concept.title}</strong><small>{domainLabel(domainIdOf(concept))}{domainIdOf(concept) !== domainId ? ' · 跨域' : ''}</small></span><span className="row-chevron">›</span></button>;
            })}
            {listedConcepts.length === 0 ? <EmptyPanel title="当前领域暂无概念" text="切换知识域，或搜索知识库中的其他概念。" /> : null}
          </div>
          <PendingWritesPanel writes={pendingWrites} />
          <div className="left-footer"><span className={`sync-led${pendingWrites.length ? ' is-pending' : ''}`} /><span>{pendingWrites.length ? `${pendingWrites.length} 条记录等待同步` : '本地状态已同步'}</span>{pendingWrites.length ? <button type="button" className="sync-retry" onClick={() => void retryPending()} disabled={writeLocked || busyAction === 'pending'}>{busyAction === 'pending' ? '同步中…' : '重试同步'}</button> : null}</div>
        </aside>

        <section className="graph-panel">
          <div className="graph-toolbar">
            <div><span className="eyebrow">空间视图</span><h2>{twoDimensional ? '平面阅读' : '时间图谱'} <span className="live-dot" /></h2></div>
            <div className="graph-tools">
              {selectedId ? <button type="button" className="tool-button" disabled={domainBusy} onClick={clearSelection}>取消选中</button> : null}
              <button type="button" className={`tool-button${listMode ? ' active' : ''}`} onClick={() => setListMode((mode) => !mode)}>{listMode ? '返回图谱' : '文字列表'}</button>
              <button type="button" className={`tool-button${autoRotateEnabled ? ' active' : ''}`} aria-pressed={autoRotateEnabled} disabled={twoDimensional || listMode} title="手动开启后立即旋转；后续操作暂停 2 分钟。系统要求减少动态效果时默认关闭。" onClick={() => {
                if (!autoRotateEnabled) rotationClock.resume();
                setAutoRotateEnabled((value) => !value);
              }}>自动旋转</button>
              <button type="button" className={`tool-button${glowEnabled ? ' active' : ''}`} aria-pressed={glowEnabled} onClick={() => setGlowEnabled((value) => !value)}>发光效果</button>
              <div className="view-mode-toggle" role="group" aria-label="图谱维度">
                <button type="button" className={`tool-button${!twoDimensional ? ' active' : ''}`} aria-pressed={!twoDimensional} disabled={listMode} onClick={() => setTwoDimensional(false)}>3D 纵深</button>
                <button type="button" className={`tool-button${twoDimensional ? ' active' : ''}`} aria-pressed={twoDimensional} disabled={listMode} onClick={() => setTwoDimensional(true)}>2D 阅读</button>
              </div>
            </div>
            <div className="rotation-status" aria-label="自动旋转状态">
              {autoRotateEnabled && !listMode && !twoDimensional && (rotationStatus.kind === 'waiting' || rotationStatus.kind === 'holding') ? <button type="button" className="quiet-button" disabled={domainBusy} onClick={() => rotationClock.resume()}>立即旋转</button> : null}
              <span>{listMode ? '文字列表 · 旋转暂停' : rotationStatus.text}</span>
            </div>
          </div>
          {demoEnabled && demoRecord ? <DemoPanel record={demoRecord} snapshot={viewSnapshot} saved={demoSaved} labels={STATUS_LABELS} onSelect={selectConcept} /> : null}
          <div className="graph-frame">
            {/* Separate graph lifetimes prevent preview coordinates or late engine callbacks from reaching the real layout. */}
            {listMode ? <GraphFallbackList concepts={viewSnapshot.concepts} states={viewSnapshot.states} selectedId={selectedId} onSelect={selectConcept} /> : <GraphView key={`${sourceId}:${domainId}:${demoEnabled ? 'demo' : simulated ? 'forecast' : 'real'}`} snapshot={viewSnapshot} layout={layout} selectedId={selectedId} focusRevision={focusRevision} simulated={demoEnabled || simulated} paused={Boolean(attempt)} twoDimensional={twoDimensional} glowEnabled={glowEnabled} autoRotateEnabled={autoRotateEnabled} rotationPaused={domainBusy} rotationClock={rotationClock} onRotationStatusChange={setRotationStatus} onSelect={selectConcept} onLayoutChange={saveLayout} />}
            <div className="graph-legend"><span className="legend-title">{demoEnabled ? '示例时间颜色' : '记忆时间状态'}</span>{(['recent', 'revisit', 'stale', 'unknown'] as const).map((status) => <span className="legend-item" key={status}><i style={{ '--status-color': STATUS_COLORS[status] } as React.CSSProperties} />{STATUS_LABELS[status]}</span>)}</div>
            <div className="graph-hint">{viewSnapshot.links.length} 条可见关系 · {selectedId ? '亮线连接选中概念' : '点击节点或搜索结果以高亮'} · 悬停看关系</div>
          </div>
          <div className="time-control"><div className="timeline-label"><span className="eyebrow">时间预览</span><strong>{simulated ? `+${simDays} 天` : demoEnabled ? '初始模拟值' : '实时状态'}</strong>{simulated ? <span className="simulation-tag">模拟中 · 不写入</span> : null}</div><input aria-label="模拟时间，单位天" type="range" min="0" max="30" step="1" value={simDays} onChange={(event) => setSimulatedDays(Number(event.target.value))} disabled={Boolean(attempt) || sourceReloadPending} /><div className="range-labels"><span>{demoEnabled ? '模拟起点' : '现在'}</span><span>+7 天</span><span>+14 天</span><span>+30 天</span></div>{simulated ? <button type="button" className="real-time-button" onClick={() => setSimulatedDays(0)}>{demoEnabled ? '回到初始值' : '恢复实时'}</button> : null}</div>
        </section>

        <aside className="right-panel">
          {selectedConcept && selectedState ? (
            <>
              <div className="detail-head"><div className="detail-domain">{domainLabel(domainIdOf(selectedConcept))}</div><h2>{selectedConcept.title}</h2><div className="alias-row">{selectedConcept.aliases.slice(0, 3).map((alias) => <span key={alias}>{alias}</span>)}</div></div>
              <div className="detail-state"><div><span className="eyebrow">{demoEnabled ? '模拟时间状态' : '当前时间状态'}</span><div className="state-line"><StatusBadge status={selectedState.status} /></div></div><span className="state-asof">截至 {formatDate(displaySnapshot.asOf, true)}</span></div>
              <div className="state-metrics"><div><span>{demoEnabled ? '模拟重温间隔' : '距上次重温'}</span><strong>{formatElapsed(selectedState.elapsedDays)}</strong></div><div><span>{demoEnabled ? '模拟起点' : '时间起点'} {!demoEnabled && selectedState.anchor?.kind === 'estimated' ? <em className="estimate-badge">估计</em> : null}</span><strong>{formatDate(selectedState.anchor?.occurredAt)}</strong></div></div>
              <div className="time-indicator">时间指标 D <strong>{selectedState.decay === null ? '未知' : selectedState.decay.toFixed(3)}</strong><span>{demoEnabled ? '模拟值' : '时间推算'}</span></div>
              <Curve state={selectedState} halfLifeDays={displaySnapshot.config.halfLifeDays} />
              <p className="state-reason">{selectedState.reason ?? '状态由当前时间与最近确认事件投影。'}</p>
              <div className="detail-actions"><button type="button" className="primary-button" onClick={() => void submitReview('review')} disabled={writeLocked || busyAction === 'review'}>{busyAction === 'review' ? '保存中…' : '确认已重温'}</button><button type="button" className="secondary-button" onClick={() => { reviewEventRef.current = null; setEstimatedDate(new Date().toISOString().slice(0, 10)); setReviewDialogOpen(true); }} disabled={writeLocked || busyAction === 'review'}>补记过去重温</button></div>
              <button type="button" className="recall-button" onClick={startRecall} disabled={writeLocked || Boolean(attempt)}><span>✦</span>先想一句，再查看资料</button>
              {historyEnabled && selectedConcept ? <ConceptHistoryPanel
                key={`${sourceId}:${selectedConcept.id}:${selectedConcept.source.revision}`}
                {...conceptHistory} pendingCount={pendingLearningCount} simulated={simulated}
                onRevealAnswer={() => markSourceViewed(selectedConcept.id)}
              /> : <p className="source-hint">{attempt ? '回忆任务期间隐藏学习历史与旧回答。' : demoEnabled ? '示例模式不展示真实学习历史；关闭示例后可查看已保存记录。' : '知识源正在切换，学习历史暂时隐藏。'}</p>}
              <CrossDomainPanel neighbors={crossDomainNeighbors} expandedIds={visibleExpandedIds} visibleIds={visibleIds} onToggle={toggleExpanded} onNavigate={changeDomain} disabled={domainBusy} canExpand={canExpand} />
              <div className="source-section"><div className="section-heading"><span className="eyebrow">知识资料</span>{selectedSourceViewed ? <span className="viewed-label">本次已查看</span> : null}</div><button type="button" className="source-reveal" onClick={() => markSourceViewed(selectedConcept.id)}><span>{selectedSourceViewed ? '资料已展开' : '打开来源与摘要'}</span><span>{selectedSourceViewed ? '✓' : '⌄'}</span></button><div className="source-hint">本次查阅会标记为已查看，不会自动重置重温时间。</div>{selectedSourceViewed ? <SourceBlock concept={selectedConcept} /> : null}</div>
            </>
          ) : <EmptyPanel title="选择一个概念" text="点击图谱节点，或在左侧搜索后选择结果，查看概念与时间状态。" />}
        </aside>
      </main>

      {reviewDialogOpen && selectedConcept ? <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setReviewDialogOpen(false); }}><div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="review-dialog-title"><div className="modal-kicker">补记历史 · 估计时间</div><h2 id="review-dialog-title">你大约在什么时候重温过？</h2><p>这条记录会标记为估计事件，只作为时间起点参考，不会伪装成精确测量。</p><label htmlFor="estimated-date">日期</label><input id="estimated-date" type="date" value={estimatedDate} max={new Date().toISOString().slice(0, 10)} onChange={(event) => setEstimatedDate(event.target.value)} /><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setReviewDialogOpen(false)}>取消</button><button type="button" className="primary-button" onClick={() => void submitReview('estimated', estimatedDate)} disabled={writeLocked || !estimatedDate || busyAction === 'review'}>保存估计记录</button></div></div></div> : null}

      {attempt && selectedConcept && selectedConcept.id === attempt.conceptId ? <div className="recall-overlay"><div className="recall-card" role="dialog" aria-modal="true" aria-labelledby="recall-title"><div className="recall-topline"><span className="eyebrow">主动回忆 · {attempt.stage === 'answer' ? '先回答' : '核对与自评'}</span><button type="button" className="icon-button" onClick={() => setAttempt(null)} aria-label="取消回忆">×</button></div><h2 id="recall-title">{selectedConcept.title}</h2>{attempt.stage === 'answer' ? <><p className="recall-prompt">先用自己的话写下你记得的核心原理、关键条件或一个应用场景。资料会在提交后显示。</p><textarea autoFocus value={attempt.answer} onChange={(event) => setAttempt({ ...attempt, answer: event.target.value })} placeholder="我记得……" aria-label="回忆答案" /><div className="recall-actions"><button type="button" className="secondary-button" onClick={() => setAttempt(null)}>取消</button><button type="button" className="primary-button" onClick={submitRecallAnswer}>提交回答，查看资料</button></div></> : <><div className="answer-echo"><span>你的回答</span><p>{attempt.answer || '（空白）'}</p></div><SourceBlock concept={selectedConcept} /><div className="self-rating"><span className="eyebrow">这次回忆感觉如何？</span><div className="rating-options">{(['clear', 'partial', 'blank'] as const).map((rating) => <button type="button" key={rating} className={attempt.rating === rating ? 'is-selected' : ''} onClick={() => setAttempt({ ...attempt, rating })}>{rating === 'clear' ? '能解释' : rating === 'partial' ? '有些模糊' : '想不起'}</button>)}</div></div><div className="exposure-options"><span>提交前是否看过资料？</span><select value={attempt.exposure} onChange={(event) => setAttempt({ ...attempt, exposure: event.target.value as Exposure })}><option value="unknown">不确定</option><option value="unexposed">没有</option><option value="exposed">看过</option></select></div><div className="recall-actions"><button type="button" className="secondary-button" onClick={() => setAttempt(null)}>取消，不保存</button><button type="button" className="primary-button" onClick={() => void saveObservation()} disabled={!attempt.rating || busyAction === 'observation' || writeLocked}>{busyAction === 'observation' ? '保存中…' : '保存这次观察'}</button></div><p className="recall-footnote">观察只用于了解时间提示是否符合体验，暂时不会改变曲线。</p></>}</div></div> : null}

      {notice ? <div className={`notice notice-${notice.tone}`} role="status">{notice.text}</div> : null}
    </div>
  );
}
