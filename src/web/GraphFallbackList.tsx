import type { Concept, MemoryState } from '../shared/types.js';
import { domainIdOf, domainLabel } from '../core/domain-view.js';
import { STATUS_LABELS } from './memory-status.js';

export interface GraphFallbackListProps {
  concepts: Concept[];
  states: Record<string, MemoryState>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  currentDomainId?: string | null;
}

export function GraphFallbackList({ concepts, states, selectedId, onSelect, currentDomainId }: GraphFallbackListProps) {
  return (
    <div className="graph-list-fallback">
      {concepts.length === 0 ? <p className="graph-list-empty">当前没有可显示的概念。</p> : null}
      <ul className="graph-list-items" aria-label="概念文字列表">
        {concepts.map((concept) => {
          const status = states[concept.id]?.status ?? 'unknown';
          const selected = selectedId === concept.id;
          const conceptDomainId = domainIdOf(concept);
          const crossDomain = Boolean(currentDomainId && conceptDomainId !== currentDomainId);
          return (
            <li key={concept.id}>
              <button
                type="button"
                className={`fallback-node${selected ? ' is-selected' : ''}`}
                aria-pressed={selected}
                onClick={() => onSelect(concept.id)}
              >
                <span className="status-dot" aria-hidden="true" style={{ backgroundColor: `var(--memory-${status})` }} />
                <span className="fallback-node-content">
                  <span className="fallback-node-title">{concept.title}</span>
                  <span className="fallback-node-status">{STATUS_LABELS[status]}</span>
                  {crossDomain ? <span className="fallback-node-domain">跨域 · {domainLabel(conceptDomainId)}</span> : null}
                  <span className="fallback-node-path">{concept.source.path}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
