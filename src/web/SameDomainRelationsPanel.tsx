import { domainIdOf, domainLabel, type SameDomainRelation } from '../core/domain-view.js';
import type { Concept } from '../shared/types.js';

export interface SameDomainRelationsPanelProps {
  selectedConcept: Concept;
  relations: SameDomainRelation[];
  disabled: boolean;
  onReveal(): void;
  onNavigate(id: string): void;
}

export function SameDomainRelationsPanel({
  selectedConcept, relations, disabled, onReveal, onNavigate,
}: SameDomainRelationsPanelProps) {
  const directory = domainIdOf(selectedConcept);
  return (
    <details
      className="same-domain-relations"
      onToggle={(event) => {
        if (event.currentTarget.open && !disabled) onReveal();
      }}
    >
      <summary aria-disabled={disabled} onClick={(event) => {
        if (disabled) event.preventDefault();
      }}>
        查看同域关系（{relations.length}条）
      </summary>
      <div className="same-domain-relations-content">
        <p className="same-domain-relations-scope">
          所属目录：{domainLabel(directory)}<br />
          <span>{directory === '__root__' ? '（根目录）' : directory}</span>
        </p>
        <p className="same-domain-relations-hint">来自完整知识索引，不受图谱节点上限限制。方向沿用原关系记录。展开关系会视为已查看资料。</p>
        {relations.length === 0 ? <p>当前概念没有同域关系。</p> : (
          <ul className="same-domain-relations-list">
            {relations.map(({ link, sourceConcept, targetConcept, direction }) => {
              const neighbor = direction === 'outgoing' ? targetConcept : sourceConcept;
              const relationType = link.type.trim() ? link.type : '未标注类型';
              const roleOf = (concept: Concept) => concept.id === selectedConcept.id ? '当前概念' : '同域概念';
              const diagramLabel = direction === 'self'
                ? `当前概念 ${sourceConcept.title} 关联自身；关系类型：${relationType}`
                : `${roleOf(sourceConcept)} ${sourceConcept.title} 指向${roleOf(targetConcept)} ${targetConcept.title}；关系类型：${relationType}`;
              const node = (concept: Concept, endpoint: 'source' | 'target') => {
                const current = concept.id === selectedConcept.id;
                return <div className={`same-domain-relations-node${current ? ' is-current' : ''}`}
                  data-endpoint={endpoint} data-concept-role={current ? 'current' : 'neighbor'}>
                  <span className="same-domain-relations-node-role">{roleOf(concept)}</span>
                  <strong>{concept.title}</strong>
                  <span className="same-domain-relations-node-path">{concept.source.path}</span>
                </div>;
              };
              return (
                <li key={JSON.stringify([link.id, link.source, link.target, link.type, link.description])}>
                  <div className="same-domain-relations-endpoints" role="group" aria-label={diagramLabel}>
                    {node(sourceConcept, 'source')}
                    <div className={`same-domain-relations-connector${direction === 'self' ? ' is-self' : ''}`}>
                      <svg viewBox="0 0 24 32" aria-hidden="true" focusable="false">
                        {direction === 'self'
                          ? <path d="M19 10A8 8 0 1 0 20 20M14 10H20V4" />
                          : <path d="M12 2V28M6 22L12 28L18 22" />}
                      </svg>
                      <div className="same-domain-relations-edge-type">
                        {direction === 'self' ? <span className="same-domain-relations-self-label">关联自身</span> : null}
                        <span className="same-domain-relations-type-label">关系类型</span>
                        <strong>{relationType}</strong>
                      </div>
                    </div>
                    {direction !== 'self' ? node(targetConcept, 'target') : null}
                  </div>
                  <p>关系说明：<span>{link.description.trim() ? link.description : '未提供说明'}</span></p>
                  {direction !== 'self' && <button type="button" disabled={disabled} onClick={() => {
                    if (!disabled) onNavigate(neighbor.id);
                  }}>查看关联概念：{neighbor.title}</button>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}
