import type { PendingWrite } from './api';
import './pending-writes.css';

const PATH_LABELS: Record<string, string> = {
  '/layout': '图谱布局',
  '/config': '模型参数',
  '/reviews': '确认重温',
  '/observations': '回忆观察',
};

function writeLabel(write: PendingWrite): string {
  const label = typeof write.label === 'string' ? write.label.trim() : '';
  if (label) return label;

  const path = typeof write.path === 'string' ? write.path.trim() : '';
  const knownPath = Object.keys(PATH_LABELS).find((candidate) => (
    path === candidate || path.startsWith(`${candidate}/`)
  ));
  return knownPath ? PATH_LABELS[knownPath] : path || '待同步记录';
}

function createdAtText(value: unknown): { text: string; dateTime?: string } {
  if (typeof value !== 'string' || !value.trim()) return { text: '创建时间未知' };
  const raw = value.trim();
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return { text: '创建时间未知' };
  try {
    return {
      text: new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date),
      dateTime: raw,
    };
  } catch {
    return { text: '创建时间未知' };
  }
}

function lastError(write: PendingWrite): { message: string; code: string } | null {
  const error = write.lastError;
  if (!error || typeof error !== 'object') return null;
  const message = typeof error.message === 'string' ? error.message.trim() : '';
  const code = typeof error.code === 'string' ? error.code.trim() : '';
  return {
    message: message || '同步失败，请稍后重试。',
    code,
  };
}

export function PendingWritesPanel({ writes }: { writes: PendingWrite[] }) {
  if (writes.length === 0) return null;

  return (
    <section className="pending-writes-panel" aria-label="待同步记录详情">
      <div className="pending-writes-heading">
        <span className="pending-writes-title">待同步详情</span>
        <span className="pending-writes-count" aria-label={`${writes.length} 条待同步记录`}>{writes.length}</span>
      </div>
      <div className="pending-writes-list" role="list">
        {writes.map((write, index) => {
          const error = lastError(write);
          const createdAt = createdAtText(write.createdAt);
          return (
            <article
              className={`pending-writes-item${error ? ' pending-writes-item-is-error' : ''}`}
              key={`${write.id || write.path || 'pending'}-${index}`}
              role="listitem"
            >
              <div className="pending-writes-item-heading">
                <strong className="pending-writes-item-label">{writeLabel(write)}</strong>
                <time className="pending-writes-item-time" dateTime={createdAt.dateTime}>{createdAt.text}</time>
              </div>
              {error ? (
                <div className="pending-writes-error" role="status">
                  <span className="pending-writes-error-label">同步失败</span>
                  <span className="pending-writes-error-message">{error.message}</span>
                  {error.code ? <code className="pending-writes-error-code">{error.code}</code> : null}
                </div>
              ) : (
                <div className="pending-writes-waiting">等待重试</div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
