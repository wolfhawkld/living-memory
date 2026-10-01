import type { ReactNode } from 'react';

export interface GraphSourceContentProps {
  sourceConceptCount: number;
  listMode: boolean;
  refreshing: boolean;
  refreshDisabled: boolean;
  refreshHint?: string;
  onRefresh: () => void;
  children: ReactNode;
}

export function GraphSourceContent({
  sourceConceptCount, listMode, refreshing, refreshDisabled, refreshHint, onRefresh, children,
}: GraphSourceContentProps) {
  // A filtered view can be empty even when the knowledge source has concepts.
  if (listMode || sourceConceptCount > 0) return children;

  return (
    <div className="graph-empty" aria-busy={refreshing}>
      <div className="graph-empty-content">
        <div role="status">
          <h3>知识空间还没有概念</h3>
          <p>请先将知识 Markdown 放入此账号的知识目录，再点击刷新知识源。</p>
        </div>
        <button type="button" className="primary-button" disabled={refreshDisabled || refreshing} onClick={onRefresh}>
          {refreshing ? '刷新中…' : '刷新知识源'}
        </button>
        {refreshHint ? <p>{refreshHint}</p> : null}
      </div>
    </div>
  );
}
