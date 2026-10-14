import { domainIdOf, domainLabel, type SameDomainRelation } from '../core/domain-view.js';
import type { Concept } from '../shared/types.js';

export interface SameDomainRelationsPanelProps {
  selectedConcept: Concept;
  relations: SameDomainRelation[];
  disabled: boolean;
  onReveal(): void;
  onNavigate(id: string): void;
}

const directionLabels = { outgoing: '出向', incoming: '入向', self: '自关联' } as const;

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
              return (
                <li key={JSON.stringify([link.id, link.source, link.target, link.type, link.description])}>
                  <span className="same-domain-relations-direction">{directionLabels[direction]}</span>
                  <div className="same-domain-relations-endpoints">
                    <div><strong>{sourceConcept.title}</strong><span>{sourceConcept.source.path}</span></div>
                    <span aria-label="指向">→</span>
                    <div><strong>{targetConcept.title}</strong><span>{targetConcept.source.path}</span></div>
                  </div>
                  <p>关系类型：<span>{link.type.trim() ? link.type : '未标注类型'}</span></p>
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
