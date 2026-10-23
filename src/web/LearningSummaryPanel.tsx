import type { LearningSummary } from '../shared/types';
import type { ObservationPrivacySummary } from '../shared/observation-privacy';

export function LearningSummaryPanel({ summary, observationPrivacy }: { summary: LearningSummary | undefined; observationPrivacy?: ObservationPrivacySummary }) {
  if (!summary) return null;
  return <section className="learning-summary" aria-label="场景调用与信心校准">
    <h3>场景调用与信心校准</h3>
    <p>当前资料版本 · 场景记录 {summary.scenario.total} 次</p>
    {observationPrivacy ? <p>当前概念全部资料版本中，已清除原答 {observationPrivacy.cleared} 条；其中采用中的 {observationPrivacy.excludedFromPerformance} 条因原答不可用而排除表现统计。评分采用与复习消耗分别保留。</p> : null}
    {summary.scenario.revisited ? <p>其中同场景回访 {summary.scenario.revisited} 次，计数不代表新场景迁移能力。</p> : null}
    <dl className="learning-counts">
      <div><dt>独立想起并核对适用</dt><dd>{summary.scenario.independentSuccess}</dd></div>
      <div><dt>借助提示或查阅</dt><dd>{summary.scenario.assisted}</dd></div>
      <div><dt>部分适用 / 未成功 / 未核对</dt><dd>{summary.scenario.partial} / {summary.scenario.failure} / {summary.scenario.unverified}</dd></div>
    </dl>
    {(['concept', 'scenario'] as const).map((task) => {
      const item = summary.calibration[task];
      return <div className="calibration-row" key={task}>
        <strong>{task === 'concept' ? '概念解释' : '场景调用'} · {item.count} 次可比较记录</strong>
        {item.count ? <p>平均事前信心 {item.meanConfidence!.toFixed(0)}% · 核对成功率 {item.successRate!.toFixed(0)}%<br />差值 {item.gap! > 0 ? '+' : ''}{item.gap!.toFixed(0)} 个百分点</p>
          : <p>等待事前信心与明确的独立作答结果。</p>}
      </div>;
    })}
    <p className="source-hint">结果由你核对，样本少时只作观察。部分成功、看过资料、借助提示及未核对的记录不进入信心比较；各项计数可能重叠。场景比较可包含同场景回访，只核对当次预测。</p>
  </section>;
}
