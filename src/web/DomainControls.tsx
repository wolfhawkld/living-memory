import type { GraphLink } from '../shared/types';
import type { CrossDomainNeighbor, DomainOption } from '../core/domain-view';
import './domain-controls.css';

export interface DomainPickerProps {
  domains: DomainOption[];
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
}

export interface CrossDomainPanelProps {
  neighbors: CrossDomainNeighbor[];
  expandedIds: readonly string[];
  visibleIds?: readonly string[];
  onToggle: (id: string) => void;
  onNavigate: (domainId: string, conceptId: string) => void;
  disabled: boolean;
  canExpand: boolean;
}

const DOMAIN_PICKER_ID = 'living-memory-domain-picker';

export function DomainPicker({ domains, value, onChange, disabled }: DomainPickerProps) {
  return (
    <div className="domain-picker-toolbar">
      <label className="domain-picker-label" htmlFor={DOMAIN_PICKER_ID}>知识域</label>
      <select
        id={DOMAIN_PICKER_ID}
        className="domain-picker-select"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        disabled={disabled}
        aria-label="知识域"
      >
        {domains.map((domain) => (
          <option key={domain.id} value={domain.id} title={domain.path}>
            {domain.label} ({domain.conceptCount})
          </option>
        ))}
      </select>
    </div>
  );
}

function relationLabel(link: GraphLink): string | null {
  const parts = [link.type.trim(), link.description.trim()].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function CrossDomainPanel({
  neighbors,
  expandedIds,
  visibleIds = [],
  onToggle,
  onNavigate,
  disabled,
  canExpand,
}: CrossDomainPanelProps) {
  const expanded = new Set(expandedIds);
  const visible = new Set(visibleIds);

  return (
    <section className="cross-domain-panel" aria-labelledby="cross-domain-heading">
      <div className="cross-domain-heading">
        <h2 id="cross-domain-heading">
          跨域关联 <span className="cross-domain-count">({neighbors.length})</span>
        </h2>
      </div>

      {neighbors.length === 0 ? (
        <p className="cross-domain-empty">当前概念暂无跨域关联</p>
      ) : (
        <ul className="cross-domain-list">
          {neighbors.map((neighbor) => {
            const conceptId = neighbor.concept.id;
            const isExpanded = expanded.has(conceptId);
            const isVisible = visible.has(conceptId);
            const relations = neighbor.links
              .map((link) => ({ link, text: relationLabel(link) }))
              .filter((item): item is { link: GraphLink; text: string } => item.text !== null);

            return (
              <li className="cross-domain-item" key={`${neighbor.domainId}:${conceptId}`}>
                <div className="cross-domain-item-heading">
                  <h3 className="cross-domain-title" title={neighbor.concept.title}>{neighbor.concept.title}</h3>
                  <span className="cross-domain-domain" title={neighbor.domainLabel}>{neighbor.domainLabel}</span>
                </div>

                {relations.length > 0 ? (
                  <ul className="cross-domain-relations" aria-label="关联关系">
                    {relations.map(({ link, text }, index) => (
                      <li className="cross-domain-relation" key={link.id || `${link.type}:${index}`} title={text}>{text}</li>
                    ))}
                  </ul>
                ) : null}

                <div className="cross-domain-actions">
                  {isVisible && !isExpanded ? (
                    <span className="cross-domain-visible" role="status">图中已显示</span>
                  ) : (
                    <button
                      type="button"
                      className="cross-domain-toggle"
                      onClick={() => onToggle(conceptId)}
                      disabled={disabled || (!isExpanded && !canExpand)}
                      aria-expanded={isExpanded}
                    >
                      {isExpanded ? '在图中收起' : '在图中展开'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="cross-domain-navigate"
                    onClick={() => onNavigate(neighbor.domainId, conceptId)}
                    disabled={disabled}
                  >
                    前往该领域
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
