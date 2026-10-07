import type { LearningProgress, LearningProgressPair, LearningProgressPoint } from '../shared/learning-progress.js';

type CompatiblePoint = Partial<LearningProgressPoint>;

type CompatiblePair = Partial<Omit<LearningProgressPair, 'previous' | 'latest'>> & {
  previous?: CompatiblePoint | null;
  latest?: CompatiblePoint | null;
};

type CompatibleProgress = Partial<Omit<LearningProgress, 'tasks' | 'excluded'>> & {
  tasks?: {
    concept?: CompatiblePair;
    scenario?: CompatiblePair;
  };
  excluded?: Partial<LearningProgress['excluded']>;
};

const ratingLabels: Record<string, string> = {
  clear: '能解释',
  partial: '有些模糊',
  blank: '想不起',
};

const cueLabels: Record<string, string> = {
  independent: '独立作答',
  hinted: '借助提示',
  lookup: '查阅后作答',
  unknown: '方式未记录',
};

const exposureLabels: Record<string, string> = {
  unexposed: '未查看资料',
  exposed: '看过资料',
  unknown: '是否查看不明',
};

const outcomeLabels: Record<string, string> = {
  success: '成功',
  partial: '部分成功',
  failure: '未成功',
  unverified: '尚未核对',
};

const basisLabels: Record<string, string> = {
  'self-check': '自己对照资料',
  application: '实际应用核对',
  unknown: '依据未记录',
};

function formatDate(value: string | undefined): string {
  if (!value) return '日期未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '日期未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function formatMetric(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未记录';
  return Number(value.toFixed(3)).toString();
}

function formatElapsedDays(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未记录';
  return `${formatMetric(value)} 天`;
}

function formatConfidence(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未记录';
  return `${Math.round(value)}%`;
}

function formatInterval(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未记录';
  if (value < 0) return '时间异常';
  if (value === 0) return '同一时刻';
  if (value < 1) return `${(value * 24).toFixed(1)} 小时`;
  return `${value.toFixed(1)} 天`;
}

function lookupLabel(labels: Record<string, string>, value: string | undefined): string {
  return value && labels[value] ? labels[value] : '未记录';
}

function exposureLabel(point: CompatiblePoint): string {
  if (point.observedExposure === true) return '已查看资料';
  return lookupLabel(exposureLabels, point.exposure);
}

function conditionLabel(value: CompatiblePair['conditions']): string {
  if (value === 'same') return '所报条件相同';
  if (value === 'different') return '所报条件不同';
  if (value === 'insufficient') return '记录不足，无法判断条件';
  return '所报条件不明';
}

function pointCount(pair: CompatiblePair | undefined): number {
  if (!pair) return 0;
  let count = 0;
  if (pair.previous) count += 1;
  if (pair.latest && pair.latest !== pair.previous) count += 1;
  return count;
}

function totalLabel(pair: CompatiblePair | undefined): string {
  if (pair?.total !== undefined && Number.isFinite(pair.total)) return String(Math.max(0, Math.trunc(pair.total)));
  return String(pointCount(pair));
}

function pointEntries(pair: CompatiblePair | undefined): Array<{ label: string; point: CompatiblePoint }> {
  if (!pair) return [];
  const entries: Array<{ label: string; point: CompatiblePoint }> = [];
  if (pair.previous) entries.push({ label: '上一条', point: pair.previous });
  if (pair.latest && pair.latest !== pair.previous) entries.push({ label: '最近一条', point: pair.latest });
  return entries;
}

function ProgressPoint({ point, task, label }: {
  point: CompatiblePoint;
  task: 'concept' | 'scenario';
  label: string;
}) {
  return <article className="learning-progress-point">
    <div className="learning-progress-point-heading">
      <strong>{label}</strong>
      <time dateTime={point.observedAt || undefined}>{formatDate(point.observedAt)}</time>
    </div>
    <div className="learning-progress-point-recorded">记录于 {formatDate(point.recordedAt)}</div>
    <p className="learning-progress-point-recorded">{point.evidenceMode === 'mental' ? '脑中自报 · 未记录原答，不计入独立成功或信心校准' : point.evidenceMode === 'written' ? '书面回答' : '作答方式未记录'}</p>
    <dl className="learning-progress-metrics">
      {task === 'concept' ? <div><dt>自评</dt><dd>{lookupLabel(ratingLabels, point.rating)}</dd></div> : null}
      {task === 'scenario' ? <>
        <div><dt>场景来源</dt><dd>{point.scenarioRevisit ? '同场景回访' : '未标记回访'}</dd></div>
        <div><dt>{point.evidenceMode === 'mental' ? '自报结果' : '核对结果'}</dt><dd>{lookupLabel(outcomeLabels, point.outcome)}</dd></div>
        <div><dt>核对依据</dt><dd>{lookupLabel(basisLabels, point.basis)}</dd></div>
      </> : null}
      <div><dt>提示方式</dt><dd>{point.evidenceMode === 'mental' ? '自报：' : ''}{lookupLabel(cueLabels, point.cue)}</dd></div>
      <div><dt>曝光</dt><dd>{exposureLabel(point)}</dd></div>
      <div><dt>事前信心</dt><dd>{formatConfidence(point.confidence)}</dd></div>
      <div><dt>距重温</dt><dd>{formatElapsedDays(point.elapsedDays)}</dd></div>
      <div><dt>H</dt><dd>{formatElapsedDays(point.halfLifeDays)}</dd></div>
      <div><dt>参数版本</dt><dd>{typeof point.configRevision === 'number' && Number.isFinite(point.configRevision) ? `v${point.configRevision}` : '未记录'}</dd></div>
    </dl>
  </article>;
}

function TaskSection({ task, pair }: { task: 'concept' | 'scenario'; pair: CompatiblePair | undefined }) {
  const entries = pointEntries(pair);
  const total = totalLabel(pair);
  const totalNumber = pair?.total !== undefined && Number.isFinite(pair.total)
    ? Math.max(0, Math.trunc(pair.total))
    : pointCount(pair);
  const condition = conditionLabel(pair?.conditions);

  return <section className="learning-progress-task" aria-labelledby={`learning-progress-${task}`}>
    <div className="learning-progress-task-heading">
      <h3 id={`learning-progress-${task}`}>{task === 'concept' ? '概念解释' : '场景调用'}</h3>
      <span>记录数：{total}</span>
    </div>
    <div className="learning-progress-task-meta">
      <span>真实作答间隔：{formatInterval(pair?.intervalDays)}</span>
      <span>条件：{condition}</span>
    </div>
    {totalNumber === 0 && entries.length === 0 ? <p className="learning-progress-empty">暂无当前资料版本回忆记录。</p> : null}
    {totalNumber === 1 && entries.length <= 1 ? <p className="learning-progress-single">当前资料版本只有 1 条记录，无法形成两次对照。</p> : null}
    {totalNumber > 1 && entries.length < 2 ? <p className="learning-progress-single">当前资料版本有 {total} 条记录，但可显示的对照点不足。</p> : null}
    {entries.length > 0 ? <div className="learning-progress-points">
      {entries.map(({ label, point }) => <ProgressPoint key={`${label}:${point.observedAt ?? 'unknown'}`} point={point} task={task} label={label} />)}
    </div> : null}
  </section>;
}

function ExcludedNote({ progress }: { progress: CompatibleProgress }) {
  const previousRevision = progress.excluded?.previousRevision;
  const invalidTime = progress.excluded?.invalidTime;
  const oldCount = typeof previousRevision === 'number' && Number.isFinite(previousRevision)
    ? Math.max(0, Math.trunc(previousRevision)) : 0;
  const invalidCount = typeof invalidTime === 'number' && Number.isFinite(invalidTime)
    ? Math.max(0, Math.trunc(invalidTime)) : 0;
  if (oldCount === 0 && invalidCount === 0) return null;
  return <p className="learning-progress-excluded">
    {oldCount > 0 ? `旧资料版本记录排除 ${oldCount} 条` : null}
    {oldCount > 0 && invalidCount > 0 ? '；' : null}
    {invalidCount > 0 ? `时间异常记录排除 ${invalidCount} 条` : null}。
  </p>;
}

/** A collapsed metadata-only view of the latest learning evidence. */
export function LearningProgressPanel({ progress, simulated = false }: { progress: LearningProgress | undefined; simulated?: boolean }) {
  if (!progress) return <details className="learning-progress-panel">
    <summary>回忆变化追踪</summary>
    <div className="learning-progress-body"><p className="learning-progress-empty">当前服务尚未返回变化追踪数据，请更新服务后刷新。缺少数据不表示没有学习记录。</p></div>
  </details>;
  const compatible = progress as unknown as CompatibleProgress;
  const concept = compatible.tasks?.concept;
  const scenario = compatible.tasks?.scenario;
  const asOf = compatible.asOf;

  return <details className="learning-progress-panel">
    <summary>回忆变化追踪</summary>
    <div className="learning-progress-body">
      {simulated ? <p className="learning-progress-excluded">当前为时间预览，以下仍为真实学习记录。</p> : null}
      {asOf ? <p className="learning-progress-as-of">当前资料版本 · 数据截至 {formatDate(asOf)}</p> : null}
      <TaskSection task="concept" pair={concept} />
      <TaskSection task="scenario" pair={scenario} />
      <ExcludedNote progress={compatible} />
      <div className="learning-progress-caveat">
        <p>两次作答间隔不代表期间未接触资料；场景题目可能不同。</p>
        <p>这里只对照已记录的条件和结果，不据此推断记忆改善或自动改变记忆状态。</p>
      </div>
    </div>
  </details>;
}
