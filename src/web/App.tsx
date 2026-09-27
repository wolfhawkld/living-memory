import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { LearningOverviewItem } from '../shared/learning-overview';
import type { CorrectionOverviewItem } from '../shared/correction-overview';
import type { ConceptReviewPreference, ReviewPlanResponse, ReviewPlanUpdate } from '../shared/review-plan';
import type { AccountUser } from '../shared/accounts';
import type {
  ApplicationRecordRequest,
  Concept,
  Exposure,
  Layout,
  MemoryState,
  RecallRating,
  Snapshot,
  ObservationRequest,
  ReviewRequest,
  RetentionRequest,
} from '../shared/types';
import {
  ApiRequestError,
  api,
  archivePendingCorrection,
  canArchiveCorrectionWrite,
  flushPendingWrites,
  getPendingWrites,
  queuePendingWrite,
  subscribePendingWrites,
  subscribeToSessionRecovery,
  type PendingWrite,
  type PendingSyncResult,
} from './api';
import { GraphFallbackList, GraphView } from './GraphView';
import { ThemeSelector } from './ThemeSelector';
import { BriefReviewPanel, BriefReviewProgress } from './BriefReviewPanel';
import { ConceptReviewControls, ReviewPlanDialog } from './ReviewPlanControls';
import { useReviewPlan } from './useReviewPlan';
import { ImportDataDialog } from './ImportDataDialog';
import { IdentityDialog } from './IdentityDialog';
import type { IdentityLinkRequest, IdentityLinkCommit, IdentityLinkReceipt } from '../shared/identity';
import './identity-dialog.css';
import './import-data.css';
import type { ImportPreviewRequest, ImportCommitRequest, ImportReceipt } from '../shared/import-data';
import { createPendingWriteBarrier } from './pending-write-barrier';
import { reviewAllowance } from './review-allowance';
import { briefReviewCheckpointKey, clearBriefReviewCheckpoint, readBriefReviewCheckpoint, writeBriefReviewCheckpoint,
  type BriefRecallAttempt as RecallAttempt, type BriefReviewCheckpoint } from './brief-review-checkpoint';
import { briefReviewConfirmationSuperseded, prepareBriefReviewResume } from './brief-review-resume';
import { selectBriefReviewCandidates } from '../core/brief-review';
import { advanceBriefReview, briefReviewCounts, completeBriefReviewItem, resolveBriefReviewItem, type BriefReviewSession } from './brief-review-session';
import './brief-review.css';
import { createDemoRecord, extendDemoRecord, isDemoRecord, projectDemoSnapshot, type DemoRecord } from '../core/demo-snapshot';
import { DemoPanel } from './DemoPanel';
import { createDeferredChangeController, subscribeToChanges } from './change-sync';
import { chooseDomain, domainIdOf, domainLabel, getCrossDomainNeighbors, listDomains, mergeLayout, projectDomainView } from '../core/domain-view';
import { CrossDomainPanel, DomainPicker } from './DomainControls';
import { ConceptSearch } from './ConceptSearch';
import { PendingWritesPanel } from './PendingWritesPanel';
import { ConceptHistoryPanel } from './ConceptHistoryPanel';
import { LearningSummaryPanel } from './LearningSummaryPanel';
import { ConfidenceInput, LearningEvidenceFields } from './LearningEvidenceFields';
import { ScenarioPractice } from './ScenarioPractice';
import { ApplicationRecordDialog } from './ApplicationRecordDialog';
import type { SaveCorrection } from './ApplicationCorrectionPanel';
import './application-record.css';
import './application-correction.css';
import { LearningOverviewDialog } from './LearningOverviewDialog';
import { createLearningOverviewLoader, resolveCorrectionOverviewSelection, resolveOverviewSelection } from './learning-overview-loader';
import './learning-overview.css';
import './correction-overview.css';
import './time-recall.css';
import { RetentionConfirmation } from './RetentionConfirmation';
import { useConceptHistory } from './useConceptHistory';
import { parseSourceExposure, sourceExposureKey, SOURCE_EXPOSURE_STORAGE_KEY } from './source-exposure';
import { ConceptReader } from './ConceptReader';
import { MarkdownView } from './MarkdownView';
import { canShowConceptReader, relativeSource, type ReaderRequest, type ReaderSection } from './concept-reader-state';
import { createIdleRotationClock, trackRotationActivity, type RotationStatus } from './graph-rotation';
import type { ChangeNotification } from '../shared/types';
import { inspectLayout } from '../shared/layout';
import './concept-history.css';
import 'katex/dist/katex.min.css';
import './markdown-content.css';
import './concept-reader.css';
import './markdown-image.css';
import './mermaid-diagram.css';
import './learning-evidence.css';
import './scenario-practice.css';

const DAY_MS = 86_400_000;
const STATUS_LABELS: Record<MemoryState['status'], string> = {
  unknown: '尚未评估',
  recent: '近期重温',
  revisit: '建议再看',
  stale: '较久未重温',
  pending: '待确认',
  retained: '长期保持（本人确认）',
};

type Notice = { tone: 'info' | 'success' | 'error'; text: string } | null;

function pendingSyncNotice(result: PendingSyncResult): Notice {
  if (result.busy) return { tone: 'info', text: '另一个页面正在同步此知识空间，待同步状态会自动更新。' };
  const skipped = result.repairs?.reduce((sum, repair) => sum + repair.skippedPositions, 0) ?? 0;
  const repairNotice = skipped > 0 ? `已备份并修复旧布局，跳过 ${skipped} 个无效位置，保留这些节点的现有布局。` : '';
  const configNotice = result.duplicateConfigs ? `${result.duplicateConfigs} 条参数请求此前已生效，本次未再次改动配置。` : '';
  const failure = result.failures[0];
  if (failure) {
    const timedOut = result.failures.some(item => item.code === 'REQUEST_TIMEOUT');
    const progress = result.sent > 0 ? `已同步 ${result.sent} 条。` : '';
    const failedCount = !timedOut && result.sent > 0 ? `另有 ${result.failed} 条未完成。` : '';
    const timeoutNotice = timedOut ? '本轮同步已暂停，其余记录保留待重试。' : '';
    return { tone: 'error', text: `${progress}${failedCount}${repairNotice}${configNotice}${failure.label}：${failure.message}${timeoutNotice}` };
  }
  return result.sent > 0 ? { tone: 'success', text: `已同步 ${result.sent} 条待处理记录。${repairNotice}${configNotice}` } : null;
}

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
  const markerColor = `var(--memory-${state.status})`;
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

function SourceBlock({ concept, sourceId, onOpen }: { concept: Concept; sourceId: string; onOpen: (section: ReaderSection) => void }) {
  return (
    <div className="source-block">
      <div className="source-heading"><span>资料来源</span><span className="source-revision" title={concept.source.revision}>版本 {concept.source.revision.replace('sha256:', '').slice(0, 10)}</span></div>
      <div className="source-path" title="只显示相对来源，不展示本机根路径">{relativeSource(concept.source.path)}</div>
      <details className="source-summary-details">
        <summary>展开核心摘要</summary>
        <div className="source-summary-preview"><MarkdownView content={concept.summary || '此概念暂无摘要。'} compact
          source={{ sourceId, conceptId: concept.id, sourceRevision: concept.source.revision }} /></div>
      </details>
      <div className="source-reading-actions"><button type="button" onClick={() => onOpen('body')}>大窗阅读完整资料 ↗</button><button type="button" onClick={() => onOpen('summary')}>大窗查看摘要</button></div>
    </div>
  );
}

function EmptyPanel({ title, text }: { title: string; text: string }) {
  return <div className="empty-panel"><span className="empty-mark">✦</span><strong>{title}</strong><p>{text}</p></div>;
}

export default function App({ account, onLogout, onManageAccounts }: { account?: AccountUser; onLogout?: () => void; onManageAccounts?: () => void } = {}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [layout, setLayout] = useState<Layout>({});
  const [writeToken, setWriteToken] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [demoEnabled, setDemoEnabled] = useState(true);
  const [demoRecord, setDemoRecord] = useState<DemoRecord | null>(null);
  const [demoSaved, setDemoSaved] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [historyFocus, setHistoryFocus] = useState<{ sourceId: string; conceptId: string; applicationEventId: string } | null>(null);
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
  const [readerRequest, setReaderRequest] = useState<ReaderRequest | null>(null);
  const [attempt, setAttempt] = useState<RecallAttempt | null>(null);
  const [briefBudget, setBriefBudget] = useState<3 | 5>(3);
  const [briefSession, setBriefSession] = useState<BriefReviewSession | null>(null);
  const [briefSuspended, setBriefSuspended] = useState<BriefReviewCheckpoint | null>(null);
  const [briefResumeError, setBriefResumeError] = useState<string | null>(null);
  const [briefStorageError, setBriefStorageError] = useState<string | null>(null);
  const briefStorageConflictRef = useRef(false);
  const briefSessionRef = useRef(briefSession);
  briefSessionRef.current = briefSession;
  const [reviewPlanOpen, setReviewPlanOpen] = useState(false);
  const [reviewPlanSaveError, setReviewPlanSaveError] = useState<string | null>(null);
  const reviewPlanWriteRef = useRef(false);
  const briefActionRef = useRef(false);
  const learningWriteRef = useRef(false);
  const correctionEditingRef = useRef(new Set<string>());
  const [correctionRecoveryVersions, setCorrectionRecoveryVersions] = useState<Record<string, number>>({});
  const onCorrectionEditingChange = useCallback((applicationEventId: string, editing: boolean) => {
    if (editing) correctionEditingRef.current.add(applicationEventId);
    else {
      correctionEditingRef.current.delete(applicationEventId);
      if (correctionEditingRef.current.size === 0) queueMicrotask(() => changeHandlersRef.current.flush());
    }
  }, []);
  const confirmCorrectionNavigation = useCallback(() => correctionEditingRef.current.size === 0
    || window.confirm('当前复核说明尚未提交，继续操作会关闭这份草稿。确定继续吗？'), []);
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const [applicationDraft, setApplicationDraft] = useState<{ concept: Concept; sourceId: string } | null>(null);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [overviewSelectionError, setOverviewSelectionError] = useState<string | null>(null);
  const overviewOpenRef = useRef(false);
  const overviewNavigationRef = useRef(0);
  const overviewActionRef = useRef(false);
  const overviewLoader = useMemo(() => createLearningOverviewLoader(sourceId, api.getLearningOverview), [sourceId]);
  const overviewState = useSyncExternalStore(overviewLoader.subscribe, overviewLoader.getSnapshot, overviewLoader.getSnapshot);
  const [scenarioReader, setScenarioReader] = useState<Concept | null>(null);
  const [retentionConfirmation, setRetentionConfirmation] = useState<RetentionRequest | null>(null);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [estimatedDate, setEstimatedDate] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const identityOpenRef = useRef(false);
  identityOpenRef.current = identityOpen;
  const [importOpen, setImportOpen] = useState(false);
  const importOpenRef = useRef(false);
  const layoutRestorePendingRef = useRef(false);
  const layoutWritesRef = useRef(createPendingWriteBarrier());
  importOpenRef.current = importOpen;
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
    readerOpen: false,
  });
  const changeHandlersRef = useRef<{
    onChange: (notification: ChangeNotification) => void;
    onConnected: (notification: ChangeNotification, reconnected: boolean) => void;
    flush: () => void;
  }>({ onChange: () => undefined, onConnected: () => undefined, flush: () => undefined });

  const realNow = new Date();
  overviewOpenRef.current = overviewOpen;
  const simulated = simDays > 0;
  const hasSession = Boolean(writeToken);
  activeDomainRef.current = activeDomainId;
  const writeLocked = demoEnabled || simulated || simulationLoading || sourceReloadPending;
  const reviewPlan = useReviewPlan(sourceId, Boolean(sourceId && hasSession && !writeLocked), snapshot);
  writeLockedRef.current = writeLocked;
  const asOf = simulated && !demoEnabled ? new Date(simulationBaseRef.current + simDays * DAY_MS).toISOString() : undefined;
  sourceIdRef.current = sourceId;
  writeTokenRef.current = writeToken;
  changeUiRef.current = {
    loading,
    hidden: typeof document !== 'undefined' && document.hidden,
    demoEnabled,
    simulated,
    attempt: Boolean(attempt) || scenarioOpen || Boolean(briefSession) || Boolean(applicationDraft) || overviewOpen,
    reviewDialogOpen: reviewDialogOpen || Boolean(retentionConfirmation),
    configOpen: configOpen || reviewPlanOpen || importOpen || identityOpen,
    busyAction,
    refreshing,
    simulationLoading,
    sourceReloadPending,
    readerOpen: Boolean(readerRequest),
  };

  const refreshPendingState = useCallback(() => setPendingWrites(getPendingWrites(sourceId)), [sourceId]);

  const showNotice = useCallback((next: Notice) => {
    setNotice(next);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    if (next) noticeTimer.current = window.setTimeout(() => setNotice(null), 5_000);
  }, []);

  const persistBrief = useCallback((session: BriefReviewSession, draft: RecallAttempt | null, reviewRequest?: ReviewRequest) => {
    if (briefStorageConflictRef.current) throw new Error('另一标签页已修改未完成记录，当前草稿仍在本页，请复制后重新加载。');
    const checkpoint: BriefReviewCheckpoint = { version: 1, savedAt: new Date().toISOString(), session, attempt: draft,
      ...(reviewRequest ? { reviewRequest } : {}) };
    writeBriefReviewCheckpoint(session.sourceId, checkpoint);
    setBriefSuspended(checkpoint);
    setBriefStorageError(null);
    return checkpoint;
  }, []);

  useEffect(() => {
    if (!sourceId) return;
    briefStorageConflictRef.current = false;
    setBriefResumeError(null);
    try { setBriefSuspended(readBriefReviewCheckpoint(sourceId)); setBriefStorageError(null); }
    catch { setBriefStorageError('无法读取本机的未完成复习记录。'); }
    const changed = (event: StorageEvent) => {
      if (event.key !== null && event.key !== briefReviewCheckpointKey(sourceId)) return;
      if (briefSessionRef.current) {
        briefStorageConflictRef.current = true;
        setBriefStorageError('另一标签页已修改未完成记录，当前草稿仍在本页，请复制后结束本轮并重新加载。');
      } else {
        try { setBriefSuspended(readBriefReviewCheckpoint(sourceId)); setBriefResumeError(null); }
        catch { setBriefStorageError('未完成记录读取失败，请保留当前页面。'); }
      }
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [sourceId]);

  useEffect(() => {
    if (!briefSession || briefSession.sourceId !== sourceId) return;
    const save = () => {
      try {
        const item = briefSession.items[briefSession.index];
        const review = reviewEventRef.current;
        persistBrief(briefSession, attempt, review?.conceptId === item.conceptId
          ? { ...review, sourceRevision: item.sourceRevision } : undefined);
      } catch (cause) { setBriefStorageError(`复习草稿未自动保存：${errorMessage(cause)}`); }
    };
    save();
    window.addEventListener('pagehide', save);
    return () => window.removeEventListener('pagehide', save);
  }, [attempt, briefSession, persistBrief, sourceId]);

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
      if (account && session.user?.id !== account.id) {
        window.dispatchEvent(new CustomEvent('lm-auth-required'));
        throw new ApiRequestError('账号已切换，正在重新加载知识空间。', { code: 'AUTH_REQUIRED', status: 401 });
      }
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
  }, [account?.id]);

  const canApplyChange = useCallback(() => {
    const ui = changeUiRef.current;
    return (
      !ui.loading &&
      !briefActionRef.current &&
      !overviewOpenRef.current &&
      correctionEditingRef.current.size === 0 &&
      !ui.hidden &&
      !ui.demoEnabled &&
      !ui.simulated &&
      !ui.attempt &&
      !ui.reviewDialogOpen &&
      !ui.configOpen &&
      !ui.busyAction &&
      !ui.refreshing &&
      !ui.simulationLoading &&
      !ui.sourceReloadPending &&
      !ui.readerOpen
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
  }, [attempt, briefSession, scenarioOpen, applicationDraft, overviewOpen, reviewPlanOpen, importOpen, identityOpen, retentionConfirmation, busyAction, configOpen, demoEnabled, loading, refreshing, reviewDialogOpen, simulated, simulationLoading, sourceId, sourceReloadPending, writeToken, readerRequest]);

  useEffect(() => {
    if (overviewOpen && sourceId && !demoEnabled && !simulated && !sourceReloadPending) void overviewLoader.refresh();
    return () => { overviewLoader.clear(); };
  }, [overviewLoader, overviewOpen, sourceId, demoEnabled, simulated, sourceReloadPending]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => trackRotationActivity(document, window, rotationClock, () => performance.now()), [rotationClock]);

  useEffect(() => {
    const onPending = () => refreshPendingState();
    const unsubscribe = subscribePendingWrites(sourceId, onPending);
    window.addEventListener('online', onPending);
    return () => {
      unsubscribe();
      window.removeEventListener('online', onPending);
    };
  }, [refreshPendingState, sourceId]);

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
    if (writeLocked || importOpen || identityOpen || !writeToken || !sourceId || pendingWrites.length === 0) return undefined;
    const retry = () => {
      void flushPendingWrites(writeToken, sourceId).then(async (result) => {
        if (sourceIdRef.current !== sourceId) return;
        refreshPendingState();
        const notice = pendingSyncNotice(result);
        showNotice(notice);
        if (result.sent > 0 && canApplyChange()) {
          try { await loadSnapshot(undefined, sourceId, canApplyChange); } catch (error) {
            showNotice({ tone: 'error', text: `${notice?.text ?? ''} 页面状态刷新失败：${errorMessage(error)}` });
          }
        }
      }).catch((error) => {
        showNotice({ tone: 'error', text: `重试未完成：${errorMessage(error)}` });
      });
    };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [canApplyChange, loadSnapshot, pendingWrites.length, refreshPendingState, showNotice, sourceId, importOpen, identityOpen, writeLocked, writeToken]);

  useEffect(() => {
    return () => {
      if (layoutWriteTimer.current !== null) window.clearTimeout(layoutWriteTimer.current);
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    };
  }, []);

  const pendingConceptIds = useMemo(() => new Set(pendingWrites.filter((item) => !['/applications', '/corrections'].includes(item.path)).map((item) => item.conceptId).filter((id): id is string => Boolean(id))), [pendingWrites]);
  const displaySnapshot = useMemo(() => {
    if (snapshot && demoEnabled && demoRecord) return projectDemoSnapshot(snapshot, demoRecord, simDays);
    if (!snapshot || pendingConceptIds.size === 0) return snapshot;
    const states = { ...snapshot.states };
    for (const conceptId of pendingConceptIds) {
      const current = states[conceptId];
      if (current) states[conceptId] = { ...current, status: current.status === 'retained' ? 'retained' : 'pending',
        reason: current.status === 'retained' ? '本地记录等待同步；已确认的长期保持继续有效，直到恢复衰减操作成功同步。' : '本地记录等待同步' };
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
  const domainBusy = Boolean(attempt) || Boolean(briefSession) || scenarioOpen || Boolean(applicationDraft) || overviewOpen || reviewPlanOpen || importOpen || identityOpen || Boolean(retentionConfirmation) || Boolean(readerRequest) || reviewDialogOpen || configOpen || Boolean(busyAction) || refreshing || loading || simulationLoading || sourceReloadPending;
  const dailyAllowance = useMemo(() => reviewPlan.response ? reviewAllowance(reviewPlan.response, pendingWrites) : null, [reviewPlan.response, pendingWrites]);
  const briefCandidates = useMemo(() => snapshot && domainId && !writeLocked && reviewPlan.response && dailyAllowance
    ? selectBriefReviewCandidates(snapshot, domainId, {
      limit: Math.min(briefBudget, dailyAllowance.remaining),
      excludedIds: new Set([...pendingConceptIds, ...dailyAllowance.excludedIds]),
      preferences: reviewPlan.response.plan.concepts, asOf: reviewPlan.response.asOf,
    }) : [],
  [snapshot, domainId, writeLocked, briefBudget, pendingConceptIds, reviewPlan.response, dailyAllowance]);
  const briefDisabledReason = demoEnabled ? '请先切换到真实学习记录。'
    : simulated ? '请先恢复实时时间。'
    : sourceReloadPending ? '知识源已变化，请结束当前任务后重新加载。'
    : !hasSession ? '本地会话尚未就绪。'
    : domainBusy ? '请先完成当前操作。'
    : reviewPlan.loading ? '正在读取复习安排…'
    : !reviewPlan.response ? '复习安排尚未就绪，可打开「复习安排」重试。' : null;
  const briefItem = briefSession?.items[briefSession.index];
  const briefResult = briefSession && briefItem ? briefSession.results[briefItem.conceptId] : null;
  const briefProgressLock = sourceReloadPending || (briefSession && briefSession.sourceId !== sourceId)
    ? '知识源已变化，请结束本轮后重新加载。' : writeLocked || !hasSession ? '当前无法写入真实记录，请结束本轮后重试。'
    : briefStorageConflictRef.current ? briefStorageError : null;
  const learningOverlayOpen = Boolean(attempt) || scenarioOpen || Boolean(briefSession) || Boolean(applicationDraft) || overviewOpen || reviewPlanOpen || importOpen || identityOpen;

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
  const briefReviewDisabledReason = briefItem && (!selectedConcept || selectedConcept.id !== briefItem.conceptId
    || selectedConcept.source.revision !== briefItem.sourceRevision || snapshot?.states[briefItem.conceptId]?.retention?.active
    || pendingConceptIds.has(briefItem.conceptId))
    ? '本条内容或状态已变化，请稍后到节点详情确认重温。'
    : briefItem && briefReviewConfirmationSuperseded(reviewEventRef.current, snapshot?.states[briefItem.conceptId]?.anchor)
      ? '已有更新的重温记录，本轮的旧确认无需再次提交。' : null;
  const readerVisible = canShowConceptReader(readerRequest, sourceId, selectedConcept, attempt?.stage ?? null, sourceReloadPending);
  useEffect(() => {
    if (readerRequest && !readerVisible) setReaderRequest(null);
  }, [readerRequest, readerVisible]);
  const selectedSourceViewed = Boolean(selectedConcept && sourceViewedKeys.includes(sourceExposureKey(sourceId, selectedConcept)));
  const historyEnabled = Boolean(selectedConcept && sourceId && !demoEnabled && !attempt && !briefSession && !scenarioOpen && !applicationDraft && !overviewOpen && !sourceReloadPending);
  const focusedApplicationEventId = historyFocus?.sourceId === sourceId && historyFocus.conceptId === selectedConcept?.id
    ? historyFocus.applicationEventId : undefined;
  useEffect(() => {
    if (historyFocus && (historyFocus.sourceId !== sourceId || historyFocus.conceptId !== selectedId
      || attempt || briefSession || scenarioOpen || applicationDraft || demoEnabled)) setHistoryFocus(null);
  }, [historyFocus, sourceId, selectedId, attempt, briefSession, scenarioOpen, applicationDraft, demoEnabled]);
  const conceptHistory = useConceptHistory({
    sourceId, conceptId: selectedConcept?.id ?? '', sourceRevision: selectedConcept?.source.revision ?? '',
    applicationEventId: focusedApplicationEventId,
  }, historyEnabled, snapshot);
  const pendingLearningCount = pendingWrites.filter((write) => write.conceptId === selectedId
    && (write.path === '/reviews' || write.path === '/observations' || write.path === '/retentions' || write.path === '/applications' || write.path === '/corrections')).length;
  const pendingCorrectionApplications = useMemo(() => pendingWrites.flatMap((write) => {
    const payload = write.payload;
    return write.path === '/corrections' && payload && typeof payload === 'object'
      && 'applicationEventId' in payload && typeof payload.applicationEventId === 'string'
      ? [payload.applicationEventId] : [];
  }), [pendingWrites]);
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
      const rank: Record<MemoryState['status'], number> = { stale: 0, revisit: 1, unknown: 2, pending: 3, recent: 4, retained: 5 };
      return (rank[leftState?.status ?? 'unknown'] - rank[rightState?.status ?? 'unknown']) || left.title.localeCompare(right.title, 'zh-CN');
    });
  }, [displaySnapshot, domainId, visibleExpandedIds]);

  const changeDomain = useCallback((nextDomainId: string, targetId?: string) => {
    if (domainBusy || !snapshot || !domains.some((domain) => domain.id === nextDomainId)) return;
    if (!confirmCorrectionNavigation()) return;
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
  }, [confirmCorrectionNavigation, domainBusy, domains, showNotice, snapshot, sourceId]);

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

  const openReader = useCallback((section: ReaderSection = 'body') => {
    if (!selectedConcept || !sourceId || sourceReloadPending || briefActionRef.current || (attempt && attempt.stage !== 'feedback')) return;
    markSourceViewed(selectedConcept.id);
    setReaderRequest({ sourceId, conceptId: selectedConcept.id, sourceRevision: selectedConcept.source.revision, section });
  }, [selectedConcept, sourceId, sourceReloadPending, attempt?.stage, markSourceViewed]);
  const closeReader = useCallback(() => setReaderRequest(null), []);

  const selectConcept = useCallback((conceptId: string) => {
    if (briefSession || applicationDraft || overviewOpen || briefActionRef.current) return;
    if (conceptId !== selectedId && !confirmCorrectionNavigation()) return;
    if (attempt && attempt.conceptId !== conceptId) {
      if (!window.confirm('当前回忆尚未保存，确定取消并切换概念吗？')) return;
      setAttempt(null);
    }
    setSelectedId(conceptId);
    setFocusRevision((revision) => revision + 1);
  }, [attempt, briefSession, applicationDraft, overviewOpen, selectedId, confirmCorrectionNavigation]);

  const selectSearchResult = useCallback((conceptId: string) => {
    if (domainBusy) return;
    const concept = snapshot?.concepts.find((item) => item.id === conceptId);
    if (!concept) return;
    const targetDomain = domainIdOf(concept);
    if (targetDomain !== domainId) changeDomain(targetDomain, conceptId);
    else selectConcept(conceptId);
  }, [changeDomain, domainBusy, domainId, selectConcept, snapshot]);

  const closeOverview = useCallback(() => {
    overviewOpenRef.current = false;
    overviewNavigationRef.current += 1;
    overviewActionRef.current = false;
    overviewLoader.clear();
    setOverviewOpen(false);
    setOverviewSelectionError(null);
    setBusyAction((current) => current === 'overview' ? null : current);
  }, [overviewLoader]);

  const selectOverviewItem = useCallback(async (item: LearningOverviewItem | CorrectionOverviewItem) => {
    const overview = overviewLoader.getSnapshot();
    if (!overviewOpenRef.current || overviewActionRef.current || overview.loading || overview.error || !overview.overview || writeLocked) return;
    const ticket = ++overviewNavigationRef.current;
    overviewActionRef.current = true;
    setBusyAction('overview');
    setOverviewSelectionError(null);
    const stillActive = () => overviewOpenRef.current && overviewNavigationRef.current === ticket
      && sourceIdRef.current === sourceId && !writeLockedRef.current;
    try {
      const latest = await loadSnapshot(undefined, sourceId, stillActive);
      if (!latest || !stillActive()) return;
      const isCorrection = 'applicationEventId' in item;
      const concept = isCorrection
        ? resolveCorrectionOverviewSelection(sourceId, overview.overview, item, latest)
        : resolveOverviewSelection(sourceId, overview.overview, item, latest);
      const targetDomain = domainIdOf(concept);
      if (layoutWriteTimer.current !== null) {
        window.clearTimeout(layoutWriteTimer.current);
        layoutWriteTimer.current = null;
      }
      activeDomainRef.current = targetDomain;
      setActiveDomainId(targetDomain);
      setExpandedIds([]);
      setSelectedId(concept.id);
      setHistoryFocus(isCorrection ? { sourceId, conceptId: concept.id, applicationEventId: item.applicationEventId } : null);
      setFocusRevision((revision) => revision + 1);
      reviewEventRef.current = null;
      try { window.localStorage.setItem(`living-memory.domain.v1.${sourceId}`, targetDomain); } catch { /* Navigation remains available. */ }
      closeOverview();
    } catch (error) {
      if (stillActive()) setOverviewSelectionError(errorMessage(error));
    } finally {
      if (overviewNavigationRef.current === ticket) {
        overviewActionRef.current = false;
        setBusyAction((current) => current === 'overview' ? null : current);
      }
    }
  }, [closeOverview, loadSnapshot, overviewLoader, sourceId, writeLocked]);

  const clearSelection = useCallback(() => {
    if (domainBusy) return;
    if (!confirmCorrectionNavigation()) return;
    setSelectedId(null);
    setFocusRevision(0);
    reviewEventRef.current = null;
  }, [domainBusy, confirmCorrectionNavigation]);

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
    if (!writeToken || writeLocked || attempt || briefSession || briefActionRef.current) return;
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
  }, [attempt, briefSession, loadSnapshot, showNotice, sourceId, writeLocked, writeToken]);

  const writeWithRetry = useCallback(async (options: {
    path: '/reviews' | '/observations' | '/retentions' | '/applications' | '/corrections' | '/config' | '/layout';
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
      const timedOut = writeError instanceof ApiRequestError && writeError.code === 'REQUEST_TIMEOUT';
      const changedEvidenceSource = ['/observations', '/applications', '/corrections'].includes(options.path) && writeError instanceof ApiRequestError && writeError.code === 'SOURCE_MISMATCH';
      const expiredAccount = Boolean(options.eventId) && writeError instanceof ApiRequestError && writeError.code === 'AUTH_REQUIRED';
      if (retryable || changedEvidenceSource || expiredAccount) {
        const queued = await queuePendingWrite(sourceId, { method: options.method, path: options.path, payload: options.payload, eventId: options.eventId, conceptId: options.conceptId, label: options.label });
        if (queued) {
          refreshPendingState();
          showNotice({ tone: 'info', text: expiredAccount ? '登录已失效，原记录已保存在此账号知识空间的待同步队列；重新登录后可重试。' : changedEvidenceSource
            ? '知识源已变化，原记录已保存在原知识源的待同步队列；重新连接原知识源后可重试。'
            : timedOut
              ? '保存结果尚未确认，原记录已保留到待同步队列，可稍后原样重试。'
              : '网络暂时不可用，原记录已保存到待同步队列。' });
          return { ok: false, queued: true };
        }
        const message = timedOut
          ? '保存结果尚未确认，浏览器也未能缓存原记录；请保留当前页面，确认浏览器允许本地存储后重试。'
          : '记录尚未保存；请保留当前页面，确认浏览器已更新且允许本地存储后重试。';
        showNotice({ tone: 'error', text: message });
        return { ok: false, queued: false, unsaved: true, error: message };
      }
      showNotice({ tone: 'error', text: errorMessage(writeError) });
      return { ok: false, queued: false, error: errorMessage(writeError) };
    }
  }, [refreshPendingState, showNotice, sourceId]);

  const submitReview = useCallback(async (kind: 'review' | 'estimated', requestedOccurredAt?: string) => {
    if (!snapshot || !selectedConcept || !writeToken || writeLocked || learningWriteRef.current || briefActionRef.current) return;
    if (briefSession && (briefProgressLock || briefSession.sourceId !== sourceId || briefSession.items[briefSession.index]?.conceptId !== selectedConcept.id
      || briefSession.results[selectedConcept.id] !== 'saved' || briefReviewDisabledReason
      || briefSession.reviews[selectedConcept.id] || briefSession.items[briefSession.index]?.sourceRevision !== selectedConcept.source.revision)) return;
    learningWriteRef.current = true;
    try {
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
      if (briefSession) {
        try { persistBrief(briefSession, null, payload); }
        catch (cause) { setBriefStorageError(`重温尚未提交：${errorMessage(cause)}`); return; }
      }
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
      if (result.ok || result.queued) setReviewDialogOpen(false);
      if (briefSession && (result.ok || result.queued)) {
        setBriefSession((current) => current?.id === briefSession.id
          ? { ...current, reviews: { ...current.reviews, [selectedConcept.id]: result.ok ? 'saved' : 'queued' } } : current);
      }
      if (result.ok) {
        reviewEventRef.current = null;
        showNotice({ tone: 'success', text: kind === 'estimated' ? '已保存一条估计的过去重温。' : '已确认重温，时间起点已更新。' });
        await reloadRealSnapshot();
      }
    } finally {
      learningWriteRef.current = false;
      setBusyAction(null);
    }
  }, [briefProgressLock, briefReviewDisabledReason, briefSession, persistBrief, reloadRealSnapshot, selectedConcept, showNotice, snapshot, sourceId, writeLocked, writeToken, writeWithRetry]);

  const beginRecall = useCallback((concept: Concept, state: MemoryState) => {
    const viewed = sourceViewedKeys.includes(sourceExposureKey(sourceId, concept));
    setReaderRequest(null);
    setSelectedId(concept.id);
    setFocusRevision((revision) => revision + 1);
    reviewEventRef.current = null;
    setAttempt({
      conceptId: concept.id,
      eventId: null,
      answer: '',
      startedAt: new Date().toISOString(),
      observedAt: null,
      configRevision: null,
      anchorEventId: state.anchor?.sourceRevision === concept.source.revision ? state.anchor.eventId : null,
      sourceRevision: concept.source.revision,
      sourceViewedBefore: viewed,
      stage: 'prediction',
      learning: { task: 'concept', confidence: null, confidenceAt: null, cue: 'unknown', outcome: 'unverified', basis: 'unknown' },
      rating: null,
      exposure: viewed ? 'exposed' : 'unknown',
    });
  }, [sourceId, sourceViewedKeys]);

  const startRecall = useCallback(() => {
    if (!snapshot || !selectedConcept || !selectedState || writeLocked || attempt || briefSession || briefActionRef.current || busyAction) return;
    beginRecall(selectedConcept, selectedState);
  }, [attempt, beginRecall, briefSession, busyAction, selectedConcept, selectedState, snapshot, writeLocked]);

  const pendingReviewIds = useCallback(() => new Set(getPendingWrites(sourceId)
    .filter((write) => !['/applications', '/corrections'].includes(write.path)).map((write) => write.conceptId).filter((id): id is string => Boolean(id))), [sourceId]);

  const briefExclusions = useCallback((response: ReviewPlanResponse) => new Set([
    ...pendingReviewIds(), ...reviewAllowance(response, getPendingWrites(sourceId)).excludedIds,
  ]), [pendingReviewIds, sourceId]);

  const saveReviewPlan = useCallback(async (change: { dailyBudget: number } | { concept: ConceptReviewPreference & { conceptId: string; sourceRevision: string } }) => {
    if (!reviewPlan.response || writeLocked || !writeToken || reviewPlanWriteRef.current || briefActionRef.current || briefSession) return;
    reviewPlanWriteRef.current = true;
    setBusyAction('review-plan');
    setReviewPlanSaveError(null);
    try {
      const payload = { revision: reviewPlan.response.plan.revision, ...change } as ReviewPlanUpdate;
      await api.putReviewPlan(payload, writeToken, sourceId, reviewPlan.timeZone);
      if (sourceIdRef.current !== sourceId) return;
      const refreshed = await reviewPlan.refresh();
      if (!refreshed || sourceIdRef.current !== sourceId) return;
      showNotice({ tone: 'success', text: '复习安排已保存，记忆时间和学习记录保持不变。' });
    } catch (cause) {
      if (sourceIdRef.current !== sourceId) return;
      setReviewPlanSaveError(errorMessage(cause));
      showNotice({ tone: 'error', text: `复习安排未确认保存：${errorMessage(cause)}。请刷新安排后重试。` });
      void reviewPlan.refresh().catch(() => undefined);
    } finally { reviewPlanWriteRef.current = false; setBusyAction(null); }
  }, [briefSession, reviewPlan.response, reviewPlan.refresh, reviewPlan.timeZone, showNotice, sourceId, writeLocked, writeToken]);

  const startBriefReview = useCallback(async () => {
    if (briefDisabledReason || !domainId || !sourceId || briefActionRef.current || briefSuspended) return;
    briefActionRef.current = true;
    setBusyAction('brief-review');
    try {
      const existing = readBriefReviewCheckpoint(sourceId);
      if (existing) { setBriefSuspended(existing); return; }
      const [latest, arrangement] = await Promise.all([loadSnapshot(undefined, sourceId), reviewPlan.refresh()]);
      if (!latest || !arrangement || writeLockedRef.current || sourceIdRef.current !== sourceId) return;
      const allowance = reviewAllowance(arrangement, getPendingWrites(sourceId));
      const candidates = selectBriefReviewCandidates(latest, domainId, {
        limit: Math.min(briefBudget, allowance.remaining), excludedIds: briefExclusions(arrangement),
        preferences: arrangement.plan.concepts, asOf: arrangement.asOf,
      });
      if (!candidates.length) {
        showNotice({ tone: 'info', text: allowance.remaining ? '当前领域没有符合安排的时间候选，仍可手动选择概念回忆。' : '今日预算已用完，可以休息；仍可手动回忆或调整预算。' });
        return;
      }
      const session: BriefReviewSession = {
        id: newEventId(), sourceId, domainId, index: 0, results: {}, reviews: {},
        items: candidates.map((candidate) => ({ ...candidate, title: latest.concepts.find((concept) => concept.id === candidate.conceptId)!.title })),
      };
      const first = resolveBriefReviewItem(session, latest, briefExclusions(arrangement), { preferences: arrangement.plan.concepts, asOf: arrangement.asOf });
      if (!first) return;
      const concurrent = readBriefReviewCheckpoint(sourceId);
      if (concurrent) { setBriefSuspended(concurrent); showNotice({ tone: 'info', text: '另一标签页已开始复习，请先继续已有的一轮。' }); return; }
      persistBrief(session, null);
      setBriefSession(session);
      beginRecall(first.concept, first.state);
    } catch (startError) {
      showNotice({ tone: 'error', text: `暂时无法开始复习：${errorMessage(startError)}` });
    } finally {
      briefActionRef.current = false;
      setBusyAction(null);
    }
  }, [beginRecall, briefBudget, briefDisabledReason, briefExclusions, briefSuspended, domainId, loadSnapshot, persistBrief, reviewPlan.refresh, showNotice, sourceId]);

  const endBriefReview = useCallback(() => {
    if (!briefSession || busyAction || briefActionRef.current || learningWriteRef.current) return;
    const counts = briefReviewCounts(briefSession);
    try {
      if (!briefStorageConflictRef.current) clearBriefReviewCheckpoint(sourceId);
      setBriefSuspended(briefStorageConflictRef.current ? readBriefReviewCheckpoint(sourceId) : null);
      briefStorageConflictRef.current = false;
      setBriefStorageError(null);
      setBriefResumeError(null);
    } catch (cause) { showNotice({ tone: 'error', text: `尚未结束：${errorMessage(cause)}` }); return; }
    setReaderRequest(null);
    setAttempt(null);
    setBriefSession(null);
    reviewEventRef.current = null;
    showNotice({ tone: 'info', text: `本轮已结束：保存 ${counts.saved} 条观察，另有 ${counts.queued} 条进入待同步队列，跳过 ${counts.skipped} 条。未提交的作答不会保存。` });
  }, [briefSession, busyAction, showNotice, sourceId]);

  const pauseBriefReview = useCallback(() => {
    if (!briefSession || busyAction || briefActionRef.current || learningWriteRef.current) return;
    try {
      const review = reviewEventRef.current;
      persistBrief(briefSession, attempt, review ? { ...review, sourceRevision: briefSession.items[briefSession.index].sourceRevision } : undefined);
      setReaderRequest(null);
      setAttempt(null);
      setBriefSession(null);
      showNotice({ tone: 'info', text: '已暂停；作答与进度保存在当前浏览器，可稍后继续。' });
    } catch (cause) { setBriefStorageError(`尚未暂停：${errorMessage(cause)}`); }
  }, [attempt, briefSession, busyAction, persistBrief, showNotice]);

  const discardSuspendedBrief = useCallback(() => {
    if (briefSession || busyAction || briefActionRef.current) return;
    try {
      const current = readBriefReviewCheckpoint(sourceId);
      if (current?.session.id !== briefSuspended?.session.id) { setBriefSuspended(current); return; }
      clearBriefReviewCheckpoint(sourceId);
      setBriefSuspended(null);
      setBriefResumeError(null);
      setBriefStorageError(null);
    } catch (cause) { setBriefResumeError(errorMessage(cause)); }
  }, [briefSession, briefSuspended, busyAction, sourceId]);

  const resumeBriefReview = useCallback(async () => {
    if (briefDisabledReason || briefActionRef.current || briefSession) return;
    briefActionRef.current = true;
    setBusyAction('brief-review');
    setBriefResumeError(null);
    try {
      const checkpoint = readBriefReviewCheckpoint(sourceId);
      if (!checkpoint) { setBriefSuspended(null); return; }
      setBriefSuspended(checkpoint);
      const [latest, arrangement] = await Promise.all([loadSnapshot(undefined, sourceId), reviewPlan.refresh()]);
      if (!latest || !arrangement || sourceIdRef.current !== sourceId || writeLockedRef.current) return;
      const currentCheckpoint = readBriefReviewCheckpoint(sourceId);
      if (!currentCheckpoint || currentCheckpoint.session.id !== checkpoint.session.id || currentCheckpoint.savedAt !== checkpoint.savedAt) {
        setBriefSuspended(currentCheckpoint);
        throw new Error('未完成记录已被另一标签页更新，请重新点击继续。');
      }
      const restored = prepareBriefReviewResume(checkpoint, latest, arrangement, getPendingWrites(sourceId));
      activeDomainRef.current = restored.session.domainId;
      setActiveDomainId(restored.session.domainId);
      setExpandedIds([]);
      setSelectedId(restored.concept?.id ?? null);
      setFocusRevision((revision) => revision + 1);
      setBriefSession(restored.session);
      if (restored.attempt) {
        const viewed = restored.attempt.sourceViewedBefore || (restored.concept && sourceViewedKeys.includes(sourceExposureKey(sourceId, restored.concept)));
        setAttempt(restored.attempt.stage !== 'feedback' && viewed
          ? { ...restored.attempt, sourceViewedBefore: true, exposure: 'exposed' } : restored.attempt);
        if (restored.attempt.stage === 'feedback') markSourceViewed(restored.attempt.conceptId);
      } else if (restored.state && restored.concept) beginRecall(restored.concept, restored.state);
      else setAttempt(null);
      reviewEventRef.current = checkpoint.reviewRequest ? { ...checkpoint.reviewRequest, occurredAt: checkpoint.reviewRequest.occurredAt! } : null;
      try { window.localStorage.setItem(`living-memory.domain.v1.${sourceId}`, restored.session.domainId); } catch { /* The session still controls its domain. */ }
    } catch (cause) { setBriefResumeError(errorMessage(cause)); }
    finally { briefActionRef.current = false; setBusyAction(null); }
  }, [beginRecall, briefDisabledReason, briefSession, loadSnapshot, markSourceViewed, reviewPlan.refresh, sourceId, sourceViewedKeys]);

  const skipBriefItem = useCallback(() => {
    if (!briefSession || !attempt || busyAction || learningWriteRef.current) return;
    setBriefSession((current) => completeBriefReviewItem(current, briefSession.id, attempt.conceptId, 'skipped'));
    setReaderRequest(null);
    setAttempt(null);
  }, [attempt, briefSession, busyAction]);

  const nextBriefItem = useCallback(async () => {
    if (!briefSession || attempt || busyAction || briefProgressLock || writeLocked || !writeToken || briefActionRef.current
      || briefSession.sourceId !== sourceId) return;
    const next = advanceBriefReview(briefSession);
    if (next === briefSession) return;
    briefActionRef.current = true;
    setBusyAction('brief-review');
    try {
      const [latest, arrangement] = await Promise.all([loadSnapshot(undefined, sourceId), reviewPlan.refresh()]);
      if (!latest || !arrangement || writeLockedRef.current || sourceIdRef.current !== sourceId) return;
      if (!reviewAllowance(arrangement, getPendingWrites(sourceId)).remaining) {
        showNotice({ tone: 'info', text: '今日预算已用完，可暂停本轮明天继续。' });
        return;
      }
      const ready = resolveBriefReviewItem(next, latest, briefExclusions(arrangement), { preferences: arrangement.plan.concepts, asOf: arrangement.asOf });
      setBriefSession(ready ? next : completeBriefReviewItem(next, next.id, next.items[next.index].conceptId, 'unavailable'));
      if (ready) beginRecall(ready.concept, ready.state);
      else setSelectedId(null);
    } catch (nextError) {
      showNotice({ tone: 'error', text: `下一条尚未开始：${errorMessage(nextError)}，可重试或结束本轮。` });
    } finally {
      briefActionRef.current = false;
      setBusyAction(null);
    }
  }, [attempt, beginRecall, briefExclusions, briefProgressLock, briefSession, busyAction, loadSnapshot, reviewPlan.refresh, showNotice, sourceId, writeLocked, writeToken]);

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
    if (!attempt || !selectedConcept || selectedConcept.id !== attempt.conceptId || !snapshot || !writeToken || writeLocked
      || learningWriteRef.current || (briefSession && briefProgressLock) || attempt.stage !== 'feedback' || !attempt.rating || !attempt.observedAt) return;
    learningWriteRef.current = true;
    try {
      const eventId = attempt.eventId ?? newEventId();
      const payload: ObservationRequest = attempt.submittedPayload ?? {
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
        learning: attempt.learning,
      };
      setAttempt({ ...attempt, eventId, submittedPayload: payload });
      if (briefSession) {
        try { persistBrief(briefSession, { ...attempt, eventId, submittedPayload: payload }); }
        catch (cause) { setBriefStorageError(`观察尚未提交：${errorMessage(cause)}`); return; }
      }
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
      if (!result.ok && !result.queued) setAttempt({ ...attempt, eventId, submittedPayload: payload });
      if (result.ok || result.queued) {
        if (briefSession) setBriefSession((current) => completeBriefReviewItem(current, briefSession.id, attempt.conceptId, result.ok ? 'saved' : 'queued'));
        setReaderRequest(null);
        setAttempt(null);
      }
      if (result.ok) {
        showNotice({ tone: 'success', text: '观察已记录；它暂时不会改变重温时间曲线。' });
        await reloadRealSnapshot();
      }
    } finally {
      learningWriteRef.current = false;
      setBusyAction(null);
    }
  }, [attempt, briefProgressLock, briefSession, persistBrief, reloadRealSnapshot, selectedConcept, showNotice, snapshot, sourceId, writeLocked, writeToken, writeWithRetry]);

  const saveConfig = useCallback(async () => {
    if (!snapshot || !writeToken || writeLocked || attempt || briefSession || briefActionRef.current || busyAction) return;
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
      const receipt = result.result as { status?: string } | undefined;
      showNotice({ tone: 'success', text: receipt?.status === 'duplicate'
        ? '这项参数请求此前已生效，本次保留后续设置，并刷新当前配置。'
        : `已更新全局 H = ${halfLifeDays} 天。` });
      await reloadRealSnapshot();
    }
  }, [attempt, briefSession, busyAction, halfLifeDraft, reloadRealSnapshot, showNotice, snapshot, sourceId, writeLocked, writeToken, writeWithRetry]);

  const saveScenarioObservation = async (payload: ObservationRequest): Promise<boolean> => {
    if (sourceReloadPending && sourceId) {
      const queued = await queuePendingWrite(sourceId, { path: '/observations', method: 'POST', payload,
        eventId: payload.eventId, conceptId: payload.conceptId, label: '场景调用观察（等待原知识源）' });
      if (!queued) throw new Error('知识源已变化，浏览器也未允许保存记录。请保留当前页面和回答后重试。');
      refreshPendingState();
      showNotice({ tone: 'info', text: '场景记录已保存在原知识源的待同步队列；重新连接原知识源后可重试。' });
      return true;
    }
    if (!writeToken || writeLocked || busyAction) return false;
    setBusyAction('scenario');
    const result = await writeWithRetry({ path: '/observations', method: 'POST', payload,
      eventId: payload.eventId, conceptId: payload.conceptId, label: '场景调用观察',
      send: () => api.postObservation(payload, writeToken, sourceId) });
    setBusyAction(null);
    if (result.ok) {
      showNotice({ tone: 'success', text: '场景调用与事前信心已保存，可在关联节点的学习历史中查看。' });
      await reloadRealSnapshot();
    }
    return result.ok || Boolean(result.queued);
  };

  const saveApplication = async (payload: ApplicationRecordRequest): Promise<boolean> => {
    if (!applicationDraft || learningWriteRef.current || busyAction) return false;
    if (payload.conceptId !== applicationDraft.concept.id || payload.sourceRevision !== applicationDraft.concept.source.revision) {
      throw new Error('记录与打开时的概念不一致，请保留内容后重新打开。');
    }
    const draftSource = applicationDraft.sourceId;
    const label = payload.kind === 'application' ? '实际应用记录' : '总结与 insight';
    learningWriteRef.current = true;
    setBusyAction('application');
    try {
      if (sourceReloadPending || draftSource !== sourceIdRef.current) {
        const queued = await queuePendingWrite(draftSource, { path: '/applications', method: 'POST', payload,
          eventId: payload.eventId, conceptId: payload.conceptId, label });
        if (!queued) throw new Error('知识源已变化，浏览器也未允许保存记录。请保留当前内容后重试。');
        refreshPendingState();
        showNotice({ tone: 'info', text: '应用与总结记录已保存在原知识空间的待同步队列；重新连接后可重试。' });
        setApplicationDraft(null);
        return true;
      }
      if (!writeToken || writeLocked) throw new Error('当前无法写入真实记录，请保留内容后重试。');
      const result = await writeWithRetry({ path: '/applications', method: 'POST', payload,
        eventId: payload.eventId, conceptId: payload.conceptId, label,
        send: () => api.postApplication(payload, writeToken, draftSource) });
      if (!result.ok && !result.queued) throw new Error(result.error ?? '记录尚未保存，请重试。');
      setApplicationDraft(null);
      if (result.ok) {
        showNotice({ tone: 'success', text: '已保存到节点学习历史；重温时间与回忆评分未改变。' });
        await reloadRealSnapshot();
      }
      return true;
    } finally {
      learningWriteRef.current = false;
      setBusyAction(null);
    }
  };

  const saveCorrection: SaveCorrection = async (payload) => {
    if (!writeToken || writeLocked || busyAction || learningWriteRef.current || !historyEnabled || simulated
      || payload.conceptId !== selectedConcept?.id || pendingCorrectionApplications.includes(payload.applicationEventId)) {
      return { ok: false, error: '当前无法保存修正复核，请保留说明并稍后重试。' };
    }
    learningWriteRef.current = true;
    setBusyAction('correction');
    try {
      const result = await writeWithRetry({ path: '/corrections', method: 'POST', payload,
        eventId: payload.eventId, conceptId: payload.conceptId, label: '知识修正复核',
        send: () => api.postCorrection(payload, writeToken, sourceId) });
      if (result.ok) {
        showNotice({ tone: 'success', text: '修正处理结果已保存，可在原应用 / 总结记录下查看。' });
        await reloadRealSnapshot();
      }
      return { ok: result.ok, queued: Boolean(result.queued), error: result.error };
    } finally {
      learningWriteRef.current = false;
      setBusyAction(null);
    }
  };

  const saveRetention = async () => {
    if (!retentionConfirmation || !writeToken || writeLocked || busyAction) return;
    const payload = retentionConfirmation;
    setBusyAction('retention');
    const result = await writeWithRetry({ path: '/retentions', method: 'POST', payload,
      eventId: payload.eventId, conceptId: payload.conceptId, label: payload.active ? '确认长期保持' : '恢复时间衰减',
      send: () => api.postRetention(payload, writeToken, sourceId) });
    setBusyAction(null);
    if (result.ok || result.queued) setRetentionConfirmation(null);
    if (result.ok) {
      showNotice({ tone: 'success', text: payload.active ? '已固定为长期保持，直到你手动恢复衰减。' : '已恢复时间衰减，沿用原有重温起点。' });
      await reloadRealSnapshot();
    }
  };

  const saveLayout = useCallback((next: Layout) => {
    if (importOpenRef.current || identityOpenRef.current || layoutRestorePendingRef.current || writeLockedRef.current || !writeToken || activeDomainRef.current !== domainId) return;
    const inspected = inspectLayout(next);
    if (!inspected || Object.keys(inspected.layout).length === 0) return;
    const payload = inspected.layout;
    const merged = mergeLayout(layoutRef.current, payload);
    layoutRef.current = merged;
    setLayout(merged);
    if (layoutWriteTimer.current !== null) window.clearTimeout(layoutWriteTimer.current);
    layoutWriteTimer.current = window.setTimeout(() => {
      if (importOpenRef.current || identityOpenRef.current || layoutRestorePendingRef.current || writeLockedRef.current || sourceIdRef.current !== sourceId || activeDomainRef.current !== domainId || !writeTokenRef.current) return;
      const currentToken = writeTokenRef.current;
      void layoutWritesRef.current.track(writeWithRetry({ path: '/layout', method: 'PUT', payload, eventId: null, conceptId: null, label: '保存图谱布局', send: () => api.putLayout(payload, currentToken, sourceId) }));
    }, 1_200);
  }, [domainId, sourceId, writeLocked, writeToken, writeWithRetry]);

  const dataMaintenanceLockedReason = writeLocked || !hasSession ? '请先连接当前知识空间并切换到真实记录。'
    : pendingWrites.length ? '请先同步待写入记录，再进行数据维护。'
    : briefSuspended ? '请先继续或结束未完成的复习，再进行数据维护。' : null;

  const previewImport = useCallback(async (request: ImportPreviewRequest) => {
    await layoutWritesRef.current.settle();
    if (!importOpenRef.current || sourceIdRef.current !== sourceId || writeLockedRef.current || pendingSourceIdRef.current || getPendingWrites(sourceId).length || readBriefReviewCheckpoint(sourceId)) {
      return Promise.reject(new Error('当前有未完成记录或知识空间已变化，请先处理后再导入。'));
    }
    return api.previewImport(request, writeTokenRef.current, sourceId);
  }, [sourceId]);

  const commitImport = useCallback(async (request: ImportCommitRequest) => {
    await layoutWritesRef.current.settle();
    if (!importOpenRef.current || sourceIdRef.current !== sourceId || writeLockedRef.current || pendingSourceIdRef.current || getPendingWrites(sourceId).length || readBriefReviewCheckpoint(sourceId)) {
      return Promise.reject(new Error('当前有未完成记录或知识空间已变化，请先处理后再导入。'));
    }
    return api.commitImport(request, writeTokenRef.current, sourceId);
  }, [sourceId]);

  const refreshRestoredData = useCallback((expectedSourceId: string, successText: string, focusConceptId?: string) => {
    // A committed receipt remains successful even if refreshing the UI fails.
    if (expectedSourceId !== sourceIdRef.current || pendingSourceIdRef.current) return;
    // Keep autosave paused until restored positions are read successfully.
    layoutRestorePendingRef.current = true;
    setBusyAction('data-refresh');
    let valid = true;
    let timer = 0;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = window.setTimeout(() => { valid = false; reject(new Error('refresh timeout')); }, 15_000);
    });
    void Promise.race([
      Promise.all([loadSnapshot(undefined, expectedSourceId, () => valid), api.getLayout(expectedSourceId), reviewPlan.refresh()]),
      deadline,
    ])
      .then(([next, nextLayout]) => {
        if (!next || expectedSourceId !== sourceIdRef.current || pendingSourceIdRef.current) return;
        layoutRef.current = nextLayout;
        setLayout(nextLayout);
        layoutRestorePendingRef.current = false;
        setHalfLifeDraft(String(next.config.halfLifeDays));
        if (focusConceptId) {
          const concept = next.concepts.find(item => item.id === focusConceptId);
          if (concept) {
            activeDomainRef.current = domainIdOf(concept);
            setActiveDomainId(domainIdOf(concept));
            setExpandedIds([]);
            setSelectedId(concept.id);
            setFocusRevision(value => value + 1);
          }
        }
        showNotice({ tone: 'success', text: successText });
      }).catch(() => showNotice({ tone: 'error', text: '操作已成功，但页面刷新失败。请重新加载页面查看结果。' }))
      .finally(() => { valid = false; window.clearTimeout(timer); setBusyAction(null); });
  }, [loadSnapshot, reviewPlan.refresh, showNotice]);

  const imported = useCallback((receipt: ImportReceipt) => {
    refreshRestoredData(receipt.sourceId, '学习数据已恢复，图谱与复习安排已更新。');
  }, [refreshRestoredData]);

  const loadIdentities = useCallback(async () => {
    await layoutWritesRef.current.settle();
    if (!identityOpenRef.current || sourceIdRef.current !== sourceId || writeLockedRef.current || pendingSourceIdRef.current
      || getPendingWrites(sourceId).length || readBriefReviewCheckpoint(sourceId)) throw new Error('请先处理未完成记录并确认当前知识空间。');
    await api.refresh(writeTokenRef.current, sourceId);
    return api.getIdentityStatus(sourceId);
  }, [sourceId]);
  const previewIdentityLink = useCallback(async (request: IdentityLinkRequest) => {
    await layoutWritesRef.current.settle();
    if (!identityOpenRef.current || sourceIdRef.current !== sourceId || writeLockedRef.current || pendingSourceIdRef.current
      || getPendingWrites(sourceId).length || readBriefReviewCheckpoint(sourceId)) throw new Error('请先处理未完成记录并确认当前知识空间。');
    return api.previewIdentityLink(request, writeTokenRef.current, sourceId);
  }, [sourceId]);
  const commitIdentityLink = useCallback(async (request: IdentityLinkCommit) => {
    await layoutWritesRef.current.settle();
    if (!identityOpenRef.current || sourceIdRef.current !== sourceId || writeLockedRef.current || pendingSourceIdRef.current
      || getPendingWrites(sourceId).length || readBriefReviewCheckpoint(sourceId)) throw new Error('请先处理未完成记录并确认当前知识空间。');
    return api.commitIdentityLink(request, writeTokenRef.current, sourceId);
  }, [sourceId]);
  const linked = useCallback((receipt: IdentityLinkReceipt) => {
    refreshRestoredData(receipt.sourceId, '历史已衔接，原有学习记录与时间保持不变。', receipt.conceptId);
  }, [refreshRestoredData]);

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
  }, [loadSnapshot, pendingWrites.length, refreshPendingState, showNotice, sourceId, importOpen, identityOpen, writeLocked, writeToken]);

  const archiveCorrection = useCallback(async (write: PendingWrite) => {
    if (!sourceId || writeLocked || busyAction || !canArchiveCorrectionWrite(write)) return;
    if (!window.confirm('先保留原请求备份，再将此复核请求移出待同步队列？这不会撤销服务器上已保存的记录。之后可重新核对当前资料并保存新的决定。')) return;
    setBusyAction('correction-recovery');
    try {
      const archived = await archivePendingCorrection(sourceId, write);
      if (sourceIdRef.current !== sourceId) return;
      if (!archived) {
        showNotice({ tone: 'error', text: '未能安全备份并撤回请求，原记录仍保留。请等同步结束后重试，并确认浏览器允许本地存储。' });
        return;
      }
      const payload = write.payload;
      if (payload && typeof payload === 'object' && 'applicationEventId' in payload && typeof payload.applicationEventId === 'string') {
        const id = payload.applicationEventId;
        setCorrectionRecoveryVersions((before) => ({ ...before, [id]: (before[id] ?? 0) + 1 }));
      }
      refreshPendingState();
      conceptHistory.onRetry();
      showNotice({ tone: 'success', text: '原复核请求已备份在此浏览器并退出同步，可在原应用 / 总结下重新核对。' });
    } finally { setBusyAction(null); }
  }, [busyAction, conceptHistory.onRetry, refreshPendingState, showNotice, sourceId, writeLocked]);

  const setSimulatedDays = (value: number) => {
    if (domainBusy || briefActionRef.current) return;
    setSimDays(value);
    if (demoEnabled) {
      try {
        window.localStorage.setItem(`living-memory.demo-offset.v1.${sourceId}`, String(value));
      } catch { /* The initial record remains exportable even without storage. */ }
    }
  };

  const changeDemoMode = (enabled: boolean) => {
    if (domainBusy || briefActionRef.current) return;
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
          {account ? <><span className="account-name" title="当前私人知识空间">{account.username}</span>{account.role === 'admin' ? <button type="button" className="quiet-button" disabled={domainBusy} onClick={onManageAccounts}>账号管理</button> : null}<button type="button" className="quiet-button" disabled={domainBusy} onClick={onLogout}>退出登录</button></> : null}
          <button type="button" className="quiet-button" disabled={writeLocked || domainBusy || !hasSession} onClick={() => { setReaderRequest(null); setScenarioOpen(true); }}>场景调用练习</button>
          <button type="button" className="quiet-button" onClick={() => void refreshSource()} disabled={domainBusy || writeLocked} aria-label="刷新知识源与时间状态"><span className={refreshing ? 'spin' : ''}>↻</span><span>刷新</span></button>
          <button type="button" className="quiet-button" onClick={() => void exportData()} disabled={writeLocked || domainBusy || !hasSession} aria-label="导出学习数据" title="下载已同步的学习记录、参数和布局，用于留档与分析。不含知识正文及待同步记录；可通过「导入恢复」恢复到当前账号。"><span aria-hidden="true">⇩</span><span>导出学习数据</span></button>
          <button type="button" className="quiet-button" disabled={domainBusy || Boolean(dataMaintenanceLockedReason)} title={dataMaintenanceLockedReason ?? '预览并恢复 JSON 备份中的学习数据'} onClick={() => {
            if (layoutWriteTimer.current !== null) { window.clearTimeout(layoutWriteTimer.current); layoutWriteTimer.current = null; }
            importOpenRef.current = true;
            setImportOpen(true);
          }}>导入恢复</button>
          <button type="button" className="quiet-button" disabled={domainBusy || Boolean(dataMaintenanceLockedReason)} title={dataMaintenanceLockedReason ?? '确认改名或移动后的文件对应关系，继续沿用学习历史'} onClick={() => {
            if (layoutWriteTimer.current !== null) { window.clearTimeout(layoutWriteTimer.current); layoutWriteTimer.current = null; }
            identityOpenRef.current = true;
            setIdentityOpen(true);
          }}>历史衔接</button>
          <button type="button" className={`config-button${configOpen ? ' is-open' : ''}`} onClick={() => setConfigOpen((open) => !open)} disabled={Boolean(attempt) || Boolean(briefSession) || Boolean(busyAction) || writeLocked}>H = {displaySnapshot.config.halfLifeDays} 天 <span>⌄</span></button>
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

      {sourceReloadPending ? <div className="mode-bar source-reload-banner" role="alert"><div><strong>知识源已变化</strong><span>请完成当前输入后重新加载页面。</span></div><button type="button" disabled={learningOverlayOpen || Boolean(retentionConfirmation) || Boolean(busyAction)} onClick={() => window.location.reload()}>重新加载页面</button></div> : null}

      <div className={`mode-bar${demoEnabled ? ' is-demo' : ''}`}>
        <div><strong>{demoEnabled ? '示例状态 · 非真实记忆' : '真实学习记录'}</strong><span>{demoEnabled ? '虚构重温间隔，拖动时间轴查看颜色变化' : '由你确认的学习与重温记录计算'}</span></div>
        <div className="mode-actions"><ThemeSelector />{demoEnabled ? <button type="button" onClick={exportDemo}>导出模拟记录</button> : null}<button type="button" onClick={() => changeDemoMode(!demoEnabled)} disabled={domainBusy}>{demoEnabled ? '查看真实记录' : '查看示例状态'}</button></div>
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
        <button type="button" className="quiet-button" disabled={writeLocked || domainBusy || !hasSession} onClick={() => {
          if (briefActionRef.current) return;
          if (!confirmCorrectionNavigation()) return;
          overviewOpenRef.current = true;
          setOverviewSelectionError(null);
          setOverviewOpen(true);
        }}>知识薄弱点总览</button>
      </div>
      <main className={`workspace${learningOverlayOpen ? ' workspace-recall-hidden' : ''}`} aria-hidden={learningOverlayOpen ? true : undefined}
        aria-busy={busyAction === 'brief-review'} inert={learningOverlayOpen || busyAction === 'brief-review' ? true : undefined}>
        <aside className="left-panel">
          <div className="panel-heading"><div><span className="eyebrow">知识空间</span><h1>概念索引</h1></div><span className="count-chip">{listedConcepts.length}</span></div>
          <ConceptSearch key={sourceId} concepts={snapshot.concepts} currentDomainId={domainId} disabled={domainBusy} onSelect={selectSearchResult} />
          <BriefReviewPanel domainLabel={domainId ? domainLabel(domainId) : '当前领域'} candidateCount={briefCandidates.length}
            budget={briefBudget} disabledReason={briefDisabledReason} onBudgetChange={setBriefBudget} onStart={() => void startBriefReview()}
            daily={dailyAllowance && reviewPlan.response ? { ...dailyAllowance, budget: reviewPlan.response.plan.dailyBudget, timeZone: reviewPlan.timeZone } : undefined}
            planDisabled={domainBusy || writeLocked || !hasSession}
            onOpenPlan={() => { setReviewPlanSaveError(null); setReviewPlanOpen(true); void reviewPlan.refresh().catch(() => undefined); }}
            suspended={briefSuspended ? { domainLabel: domainLabel(briefSuspended.session.domainId), index: briefSuspended.session.index,
              total: briefSuspended.session.items.length, savedAt: briefSuspended.savedAt, hasAnswer: Boolean(briefSuspended.attempt?.answer) } : undefined}
            resumeError={briefResumeError ?? briefStorageError} onResume={() => void resumeBriefReview()} onDiscard={discardSuspendedBrief}
            onCopyAnswer={() => {
              if (!briefSuspended?.attempt?.answer) return;
              if (!navigator.clipboard?.writeText) { setBriefResumeError('当前浏览器无法访问剪贴板，原作答仍保留，请使用支持本地剪贴板的浏览器恢复。'); return; }
              markSourceViewed(briefSuspended.attempt.conceptId);
              void navigator.clipboard.writeText(briefSuspended.attempt.answer).then(() => showNotice({ tone: 'success', text: '已复制未提交作答。' }),
                () => setBriefResumeError('剪贴板不可用，原作答仍保存在当前浏览器，请稍后重试复制。'));
            }} />
          <div className="list-meta"><span>当前领域 · 按时间状态排序</span><span className="pending-inline">{pendingWrites.length > 0 ? `待同步 ${pendingWrites.length}` : ''}</span></div>
          <div className="concept-list" aria-label="概念列表">
            {listedConcepts.map((concept) => {
              const state = displaySnapshot.states[concept.id] ?? { status: 'unknown' as const };
              return <button type="button" key={concept.id} className={`concept-row${selectedId === concept.id ? ' is-selected' : ''}`} onClick={() => selectConcept(concept.id)}><span className="row-status" style={{ '--status-color': `var(--memory-${state.status})` } as React.CSSProperties}><span /></span><span className="row-content"><strong>{concept.title}</strong><small>{domainLabel(domainIdOf(concept))}{domainIdOf(concept) !== domainId ? ' · 跨域' : ''}</small></span><span className="row-chevron">›</span></button>;
            })}
            {listedConcepts.length === 0 ? <EmptyPanel title={snapshot.concepts.length ? '当前领域暂无概念' : '知识空间还没有概念'} text={snapshot.concepts.length ? '切换知识域，或搜索知识库中的其他概念。' : '请先将知识 Markdown 放入此账号的知识目录，再点击刷新知识源。'} /> : null}
          </div>
          <PendingWritesPanel writes={pendingWrites} onArchiveCorrection={archiveCorrection} disabled={writeLocked || Boolean(busyAction)} />
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
            {listMode ? <GraphFallbackList concepts={viewSnapshot.concepts} states={viewSnapshot.states} selectedId={selectedId} onSelect={selectConcept} /> : <GraphView key={`${sourceId}:${domainId}:${demoEnabled ? 'demo' : simulated ? 'forecast' : 'real'}`} snapshot={viewSnapshot} layout={layout} selectedId={selectedId} focusRevision={focusRevision} simulated={demoEnabled || simulated} paused={learningOverlayOpen || readerVisible} twoDimensional={twoDimensional} glowEnabled={glowEnabled} autoRotateEnabled={autoRotateEnabled} rotationPaused={domainBusy} rotationClock={rotationClock} onRotationStatusChange={setRotationStatus} onSelect={selectConcept} onLayoutChange={saveLayout} />}
            <div className="graph-legend"><span className="legend-title">{demoEnabled ? '示例时间颜色' : '记忆时间状态'}</span>{(['recent', 'revisit', 'stale', 'unknown', ...(!demoEnabled ? ['retained' as const] : [])] as const).map((status) => <span className="legend-item" key={status}><i style={{ '--status-color': `var(--memory-${status})` } as React.CSSProperties} />{STATUS_LABELS[status]}</span>)}</div>
            <div className="graph-hint">{viewSnapshot.links.length} 条可见关系 · {selectedId ? '亮线连接选中概念' : '点击节点或搜索结果以高亮'} · 悬停看关系</div>
          </div>
          <div className="time-control"><div className="timeline-label"><span className="eyebrow">时间预览</span><strong>{simulated ? `+${simDays} 天` : demoEnabled ? '初始模拟值' : '实时状态'}</strong>{simulated ? <span className="simulation-tag">模拟中 · 不写入</span> : null}</div><input aria-label="模拟时间，单位天" type="range" min="0" max="30" step="1" value={simDays} onChange={(event) => setSimulatedDays(Number(event.target.value))} disabled={Boolean(attempt) || sourceReloadPending} /><div className="range-labels"><span>{demoEnabled ? '模拟起点' : '现在'}</span><span>+7 天</span><span>+14 天</span><span>+30 天</span></div>{simulated ? <button type="button" className="real-time-button" onClick={() => setSimulatedDays(0)}>{demoEnabled ? '回到初始值' : '恢复实时'}</button> : null}</div>
        </section>

        <aside className="right-panel">
          {selectedConcept && selectedState ? (
            <>
              <div className="detail-head"><div className="detail-domain">{domainLabel(domainIdOf(selectedConcept))}</div><h2>{selectedConcept.title}</h2><div className="alias-row">{selectedConcept.aliases.slice(0, 3).map((alias) => <span key={alias}>{alias}</span>)}</div></div>
              <div className="detail-state"><div><span className="eyebrow">{demoEnabled ? '模拟时间状态' : '当前时间状态'}</span><div className="state-line"><StatusBadge status={selectedState.status} /></div></div><span className="state-asof">截至 {formatDate(displaySnapshot.asOf, true)}</span></div>
              {selectedState.status !== 'retained' ? <><div className="state-metrics"><div><span>{demoEnabled ? '模拟重温间隔' : '距上次重温'}</span><strong>{formatElapsed(selectedState.elapsedDays)}</strong></div><div><span>{demoEnabled ? '模拟起点' : '时间起点'} {!demoEnabled && selectedState.anchor?.kind === 'estimated' ? <em className="estimate-badge">估计</em> : null}</span><strong>{formatDate(selectedState.anchor?.occurredAt)}</strong></div></div>
              <div className="time-indicator">时间指标 D <strong>{selectedState.decay === null ? '未知' : selectedState.decay.toFixed(3)}</strong><span>{demoEnabled ? '模拟值' : '时间推算'}</span></div>
              <Curve state={selectedState} halfLifeDays={displaySnapshot.config.halfLifeDays} /></> : <div className="retention-fixed-note">长期保持 · 本人确认于 {formatDate(selectedState.retention?.occurredAt)}<br />固定显示，不随时间衰减。</div>}
              <p className="state-reason">{selectedState.reason ?? '状态由当前时间与最近确认事件投影。'}</p>
              <button type="button" className="retention-button" disabled={writeLocked || Boolean(busyAction) || pendingConceptIds.has(selectedConcept.id)} onClick={() => setRetentionConfirmation({ eventId: newEventId(), conceptId: selectedConcept.id, sourceRevision: selectedConcept.source.revision, occurredAt: new Date().toISOString(), active: !snapshot.states[selectedConcept.id]?.retention?.active, previousEventId: snapshot.states[selectedConcept.id]?.retention?.eventId ?? null })}>{snapshot.states[selectedConcept.id]?.retention?.active ? '恢复时间衰减…' : '设为长期保持…'}</button>
              <div className="detail-actions"><button type="button" className="primary-button" onClick={() => void submitReview('review')} disabled={writeLocked || busyAction === 'review'}>{busyAction === 'review' ? '保存中…' : '确认已重温'}</button><button type="button" className="secondary-button" onClick={() => { reviewEventRef.current = null; setEstimatedDate(new Date().toISOString().slice(0, 10)); setReviewDialogOpen(true); }} disabled={writeLocked || busyAction === 'review'}>补记过去重温</button></div>
              <button type="button" className="recall-button" onClick={startRecall} disabled={writeLocked || Boolean(attempt)}><span>✦</span>先想一句，再查看资料</button>
              <button type="button" className="recall-button" disabled={writeLocked || domainBusy || !hasSession} onClick={() => {
                setApplicationDraft({ sourceId, concept: structuredClone(selectedConcept) });
              }}>记录应用 / 总结</button>
              {!demoEnabled ? <ConceptReviewControls preference={reviewPlan.response?.plan.concepts[selectedConcept.id]}
                disabled={writeLocked || domainBusy || !reviewPlan.response || reviewPlan.loading}
                onChange={(preference) => void saveReviewPlan({ concept: { ...preference, conceptId: selectedConcept.id, sourceRevision: selectedConcept.source.revision } })} /> : null}
              <div className="source-section"><div className="section-heading"><span className="eyebrow">知识资料</span>{selectedSourceViewed ? <span className="viewed-label">本次已查看</span> : null}</div><button type="button" className="source-reveal" onClick={() => openReader()} disabled={sourceReloadPending}><span>打开大窗阅读</span><span aria-hidden="true">↗</span></button><div className="source-hint">本次查阅会标记为已查看，不会自动重置重温时间。</div>{selectedSourceViewed ? <SourceBlock concept={selectedConcept} sourceId={sourceId} onOpen={openReader} /> : null}</div>
              {historyEnabled ? <LearningSummaryPanel summary={conceptHistory.history?.learning} /> : null}
              {historyEnabled && selectedConcept ? <ConceptHistoryPanel
                key={`${sourceId}:${selectedConcept.id}:${selectedConcept.source.revision}`}
                {...conceptHistory} pendingCount={pendingLearningCount} simulated={simulated}
                concept={selectedConcept}
                onSaveCorrection={saveCorrection}
                correctionDisabled={writeLocked || simulated || Boolean(busyAction)}
                pendingCorrectionApplications={pendingCorrectionApplications}
                onCorrectionEditingChange={onCorrectionEditingChange}
                correctionRecoveryVersions={correctionRecoveryVersions}
                focusedApplicationEventId={focusedApplicationEventId}
                onClearFocus={() => {
                  if (!confirmCorrectionNavigation()) return;
                  setHistoryFocus(null);
                }}
                onRevealAnswer={() => markSourceViewed(selectedConcept.id)}
              /> : <p className="source-hint">{attempt ? '回忆任务期间隐藏学习历史与旧回答。' : demoEnabled ? '示例模式不展示真实学习历史；关闭示例后可查看已保存记录。' : '知识源正在切换，学习历史暂时隐藏。'}</p>}
              <CrossDomainPanel neighbors={crossDomainNeighbors} expandedIds={visibleExpandedIds} visibleIds={visibleIds} onToggle={toggleExpanded} onNavigate={changeDomain} disabled={domainBusy} canExpand={canExpand} />
            </>
          ) : <EmptyPanel title="选择一个概念" text="点击图谱节点，或在左侧搜索后选择结果，查看概念与时间状态。" />}
        </aside>
      </main>

      {reviewDialogOpen && selectedConcept ? <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setReviewDialogOpen(false); }}><div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="review-dialog-title"><div className="modal-kicker">补记历史 · 估计时间</div><h2 id="review-dialog-title">你大约在什么时候重温过？</h2><p>这条记录会标记为估计事件，只作为时间起点参考，不会伪装成精确测量。</p><label htmlFor="estimated-date">日期</label><input id="estimated-date" type="date" value={estimatedDate} max={new Date().toISOString().slice(0, 10)} onChange={(event) => setEstimatedDate(event.target.value)} /><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setReviewDialogOpen(false)}>取消</button><button type="button" className="primary-button" onClick={() => void submitReview('estimated', estimatedDate)} disabled={writeLocked || !estimatedDate || busyAction === 'review'}>保存估计记录</button></div></div></div> : null}

      {attempt && selectedConcept && selectedConcept.id === attempt.conceptId ? <div className="recall-overlay"><div className="recall-card" role="dialog" aria-modal="true" aria-labelledby="recall-title">
        <div className="recall-topline"><span className="eyebrow">{briefSession ? `少量复习 · ${briefSession.index + 1}/${briefSession.items.length}` : '主动回忆'} · {attempt.stage === 'prediction' ? '事前预测' : attempt.stage === 'answer' ? '先回答' : '核对与自评'}</span>
          {briefSession ? <div className="brief-review-task-actions"><button type="button" className="quiet-button" disabled={Boolean(busyAction)} onClick={skipBriefItem}>跳过本条</button><button type="button" className="quiet-button" disabled={Boolean(busyAction)} onClick={pauseBriefReview}>暂停，稍后继续</button><button type="button" className="quiet-button" disabled={Boolean(busyAction)} onClick={endBriefReview}>结束本轮</button></div>
            : <button type="button" className="icon-button" disabled={busyAction === 'observation'} onClick={() => setAttempt(null)} aria-label="取消回忆">×</button>}
        </div>
        <h2 id="recall-title">{selectedConcept.title}</h2>
        {briefItem ? <p className="brief-review-task-reason">推荐依据：{briefItem.focus ? '手动重点优先 · ' : ''}{briefItem.status === 'stale' ? '较久未重温' : '已到再访阶段'}，距最近{briefItem.estimated ? '估计' : '确认'}重温 {formatElapsed(briefItem.elapsedDays)}。此提示不代表实际回忆能力。</p> : null}
        {briefSession && briefStorageError ? <p className="brief-review-locked" role="alert">{briefStorageError}</p> : null}
        {briefSession && briefProgressLock ? <p className="brief-review-locked" role="alert">{briefProgressLock}</p> : null}
        {attempt.stage === 'prediction' ? <>
          <ConfidenceInput value={attempt.learning.confidence} onChange={(confidence) => setAttempt({ ...attempt, learning: { ...attempt.learning, confidence } })} />
          <button type="button" className="primary-button" onClick={() => setAttempt({ ...attempt, stage: 'answer', learning: { ...attempt.learning, confidenceAt: attempt.learning.confidence === null ? null : new Date().toISOString() } })}>开始作答</button>
        </> : attempt.stage === 'answer' ? <>
          <p className="recall-prompt">先用自己的话写下核心原理和关键条件。资料会在提交后显示。</p>
          <p className="source-hint">事前信心：{attempt.learning.confidence === null ? '未预测' : `${attempt.learning.confidence}%`}</p>
          <textarea autoFocus maxLength={12000} value={attempt.answer} onChange={(event) => setAttempt({ ...attempt, answer: event.target.value })} placeholder="我记得……" aria-label="回忆答案" />
          <div className="recall-actions"><button type="button" className="secondary-button" onClick={briefSession ? skipBriefItem : () => setAttempt(null)}>{briefSession ? '跳过本条' : '取消'}</button><button type="button" className="primary-button" onClick={submitRecallAnswer}>提交回答，查看资料</button></div>
        </> : <>
          <div className="answer-echo"><span>你的回答 · 事前信心 {attempt.learning.confidence === null ? '未预测' : `${attempt.learning.confidence}%`}</span><p>{attempt.answer || '（空白）'}</p></div>
          <SourceBlock concept={selectedConcept} sourceId={sourceId} onOpen={openReader} />
          <fieldset className="recall-feedback-fields" disabled={Boolean(attempt.submittedPayload) || busyAction === 'observation'}>
            <div className="self-rating"><span className="eyebrow">这次回忆感觉如何？</span><div className="rating-options">{(['clear', 'partial', 'blank'] as const).map((rating) => <button type="button" key={rating} className={attempt.rating === rating ? 'is-selected' : ''} onClick={() => setAttempt({ ...attempt, rating })}>{rating === 'clear' ? '能解释' : rating === 'partial' ? '有些模糊' : '想不起'}</button>)}</div></div>
            <div className="exposure-options"><span>提交前是否看过资料？</span><select disabled={attempt.sourceViewedBefore} value={attempt.exposure} onChange={(event) => setAttempt({ ...attempt, exposure: event.target.value as Exposure })}><option value="unknown">不确定</option><option value="unexposed">没有</option><option value="exposed">看过</option></select></div>
            <LearningEvidenceFields value={attempt.learning} onChange={(learning) => setAttempt({ ...attempt, learning })} />
          </fieldset>
          <div className="recall-actions"><button type="button" className="secondary-button" disabled={busyAction === 'observation'} onClick={briefSession ? skipBriefItem : () => setAttempt(null)}>{briefSession ? '跳过本条' : '关闭'}</button><button type="button" className="primary-button" onClick={() => void saveObservation()} disabled={!attempt.rating || busyAction === 'observation' || writeLocked || (attempt.learning.outcome !== 'unverified' && attempt.learning.basis === 'unknown')}>{busyAction === 'observation' ? '保存中…' : attempt.submittedPayload ? '重试原记录' : '保存这次观察'}</button></div>
          <p className="recall-footnote">保存作答与核对结果，供信心比较；不会自动重置重温时间。</p>
        </>}
      </div></div> : null}

      {briefSession && briefItem && briefResult && !attempt ? <BriefReviewProgress key={`${briefSession.id}:${briefSession.index}`}
        title={briefItem.title} index={briefSession.index} total={briefSession.items.length} result={briefResult}
        {...briefReviewCounts(briefSession)} reviewStatus={briefSession.reviews[briefItem.conceptId] ?? 'idle'}
        busy={Boolean(busyAction) || refreshing} lockedReason={briefProgressLock ?? briefStorageError} reviewDisabledReason={briefReviewDisabledReason}
        onReview={() => void submitReview('review')} onNext={() => void nextBriefItem()} onEnd={endBriefReview} onPause={pauseBriefReview} /> : null}

      {identityOpen ? <IdentityDialog key={sourceId} sourceId={sourceId} lockedReason={dataMaintenanceLockedReason}
        onLoad={loadIdentities} onPreview={previewIdentityLink} onCommit={commitIdentityLink}
        onLinked={linked} onClose={() => setIdentityOpen(false)} /> : null}

      {importOpen ? <ImportDataDialog key={sourceId} sourceId={sourceId} accountLabel={account?.username ?? '本机知识空间'}
        lockedReason={dataMaintenanceLockedReason} onPreview={previewImport} onCommit={commitImport}
        onImported={imported} onClose={() => setImportOpen(false)} /> : null}

      {reviewPlanOpen ? <ReviewPlanDialog response={reviewPlan.response} loading={reviewPlan.loading || busyAction === 'review-plan' || writeLocked}
        error={sourceReloadPending ? '知识空间已变化，请关闭并重新加载页面。' : reviewPlanSaveError ?? reviewPlan.error}
        onClose={() => setReviewPlanOpen(false)} onRefresh={() => { setReviewPlanSaveError(null); void reviewPlan.refresh().catch(() => undefined); }}
        onSaveBudget={(dailyBudget) => void saveReviewPlan({ dailyBudget })} /> : null}

      {overviewOpen ? <LearningOverviewDialog key={sourceId}
        overview={sourceReloadPending ? null : overviewState.overview} loading={overviewState.loading || busyAction === 'overview'}
        error={sourceReloadPending ? '知识空间已变化，请关闭总览并重新加载页面。' : overviewSelectionError ?? overviewState.error}
        initialDomainId={domainId} pendingCount={pendingWrites.filter((write) => write.eventId).length}
        onClose={closeOverview} onSelect={(item) => void selectOverviewItem(item)}
        onSelectCorrection={(item) => void selectOverviewItem(item)}
        onRefresh={() => { if (!sourceReloadPending && !overviewActionRef.current) { setOverviewSelectionError(null); void overviewLoader.refresh(); } }} /> : null}

      {applicationDraft ? <ApplicationRecordDialog key={`${applicationDraft.sourceId}:${applicationDraft.concept.id}`}
        concept={applicationDraft.concept} busy={busyAction === 'application'} onSave={saveApplication}
        onClose={() => setApplicationDraft(null)} /> : null}

      {scenarioOpen ? <ScenarioPractice key={sourceId} snapshot={snapshot} sourceId={sourceId} busy={busyAction === 'scenario'}
        onClose={() => { setScenarioOpen(false); setScenarioReader(null); }} onSave={saveScenarioObservation}
        wasSourceViewed={(concept) => sourceViewedKeys.includes(sourceExposureKey(sourceId, concept))}
        onSourceExposed={(concept) => markSourceViewed(concept.id)}
        onReadSource={(concept) => { markSourceViewed(concept.id); setScenarioReader(concept); }} /> : null}
      {scenarioOpen && scenarioReader ? <ConceptReader key={`scenario:${sourceId}:${scenarioReader.id}`} concept={scenarioReader} sourceId={sourceId} initialSection="body" onClose={() => setScenarioReader(null)} /> : null}
      {retentionConfirmation ? <RetentionConfirmation active={retentionConfirmation.active} busy={busyAction === 'retention'} onClose={() => setRetentionConfirmation(null)} onConfirm={() => void saveRetention()} /> : null}

      {readerVisible && readerRequest && selectedConcept ? <ConceptReader key={`${sourceId}:${selectedConcept.id}:${selectedConcept.source.revision}`} concept={selectedConcept} sourceId={sourceId} initialSection={readerRequest.section} onClose={closeReader} /> : null}

      {notice ? <div className={`notice notice-${notice.tone}`} role="status">{notice.text}</div> : null}
    </div>
  );
}
