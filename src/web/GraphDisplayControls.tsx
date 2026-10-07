import type { DomainVisibilitySummary } from '../core/domain-visibility.js';
import type { GraphLimitPreference } from './graph-display-preference.js';

export interface GraphDisplayControlsProps {
  preference: GraphLimitPreference;
  serverLimit: number;
  summary: DomainVisibilitySummary;
  disabled: boolean;
  onChange: (value: GraphLimitPreference) => void;
}

const GRAPH_LIMIT_ID = 'living-memory-graph-display-limit';
const GRAPH_LIMIT_HELP_ID = 'living-memory-graph-display-limit-help';
const MANUAL_LIMITS = [20, 50, 100, 200, 300] as const;

export function GraphDisplayControls({
  preference,
  serverLimit,
  summary,
  disabled,
  onChange,
}: GraphDisplayControlsProps) {
  return (
    <div className="graph-display-controls">
      <div className="domain-picker-toolbar graph-display-toolbar">
        <label className="domain-picker-label" htmlFor={GRAPH_LIMIT_ID}>当前领域节点上限</label>
        <select
          id={GRAPH_LIMIT_ID}
          className="domain-picker-select graph-display-select"
          value={preference}
          disabled={disabled}
          aria-describedby={GRAPH_LIMIT_HELP_ID}
          title="每个领域的节点上限；跨域展开仍受总数300限制"
          onChange={(event) => {
            if (disabled) return;
            const value = event.currentTarget.value;
            if (value === 'server') {
              onChange('server');
              return;
            }
            const limit = MANUAL_LIMITS.find((item) => String(item) === value);
            if (limit !== undefined) onChange(limit);
          }}
        >
          <option value="server">跟随默认（{serverLimit}）</option>
          {MANUAL_LIMITS.map((limit) => <option key={limit} value={limit}>{limit}</option>)}
        </select>
      </div>
      <p className="graph-display-help" id={GRAPH_LIMIT_HELP_ID}>
        仅调整图谱显示范围，不影响学习或查询。
      </p>
      <p className="graph-display-summary">
        当前领域节点：{summary.visiblePrimaryNodes} / {summary.domainTotalNodes}；
        主动展开跨域节点：{summary.visibleCrossDomainNodes}；
        域内关系：{summary.visibleInternalLinks} / {summary.totalInternalLinks}
      </p>
      {summary.hiddenPrimaryNodes > 0 ? (
        <p className="graph-display-truncation" role="status">
          因节点上限暂未显示：{summary.hiddenPrimaryNodes} 个当前领域节点、{summary.hiddenInternalLinks} 条域内关系。
        </p>
      ) : null}
    </div>
  );
}
