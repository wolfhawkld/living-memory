import type { DemoRecord } from '../core/demo-snapshot';
import type { MemoryStatus, Snapshot } from '../shared/types';
import { DARK_THEME } from './theme-palette';

interface Props {
  record: DemoRecord;
  snapshot: Snapshot;
  saved: boolean;
  labels: Record<MemoryStatus, string>;
  onSelect: (id: string) => void;
}

export function DemoPanel({ record, snapshot, saved, labels, onSelect }: Props) {
  const stages = ['recent', 'revisit', 'stale', 'unknown', 'pending'] as const;
  const counts = Object.values(snapshot.states).reduce((result, state) => {
    result[state.status] += 1;
    return result;
  }, { recent: 0, revisit: 0, stale: 0, unknown: 0, pending: 0, retained: 0 });
  const concepts = new Map(snapshot.concepts.map((concept) => [concept.id, concept]));
  return (
    <div className="demo-panel">
      <div className="demo-heading"><strong>模拟时间档案</strong><span>H = 7 天 · D = 2^(−天数 / 7)</span></div>
      <div className="demo-counts" aria-label="模拟颜色分布">
        {stages.filter((status) => status !== 'pending' || counts.pending > 0).map((status) => (
          <span key={status} className="demo-count" data-status={status} style={{ '--status-color': DARK_THEME.memory[status] } as React.CSSProperties}>
            <i />{labels[status]}<strong>{counts[status]}</strong>
          </span>
        ))}
      </div>
      <details className="demo-values">
        <summary>查看初始模拟数值</summary>
        <p>0、3、7、10、14、21、28 天和未知循环分配。每次打开复用这份起点；时间指标不代表记忆百分比。</p>
        <div className="demo-table-wrap"><table>
          <thead><tr><th>概念</th><th>初始间隔</th><th>当前间隔</th><th>时间指标 D</th><th>颜色状态</th></tr></thead>
          <tbody>{record.assignments.filter((item) => concepts.has(item.conceptId)).map((item) => {
            const concept = concepts.get(item.conceptId)!;
            const state = snapshot.states[item.conceptId];
            return <tr key={item.conceptId} data-concept-id={item.conceptId}>
              <td><button type="button" onClick={() => onSelect(item.conceptId)}>{concept.title}</button></td>
              <td>{item.elapsedDays === null ? '未知' : `${item.elapsedDays} 天`}</td>
              <td>{state.elapsedDays === null ? '未知' : `${state.elapsedDays.toFixed(0)} 天`}</td>
              <td>{state.decay === null ? '—' : state.decay.toFixed(3)}</td>
              <td style={{ color: DARK_THEME.memory[state.status] }}>{labels[state.status]}</td>
            </tr>;
          })}</tbody>
        </table></div>
        <p className="demo-record-note">{saved ? '初始模拟值已保存在此浏览器' : '初始模拟值仅在本页保留，可导出保存'} · 基准 {new Date(record.baseAsOf).toLocaleString('zh-CN')}。扩大范围后刷新会补充新概念的示例值。</p>
      </details>
    </div>
  );
}
