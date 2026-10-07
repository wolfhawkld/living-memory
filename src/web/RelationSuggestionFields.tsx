import { useId, useState } from 'react';
import type { Concept, GraphLink } from '../shared/types';
import { domainIdOf, domainLabel } from '../core/domain-view';
import {
  createRelationSuggestionDraft, directedSuggestionLinks, RELATION_OPERATION_LABELS,
  type RelationSuggestionDraft,
} from './application-record';

export interface RelationSuggestionFieldsProps {
  concept: Concept;
  concepts: readonly Concept[];
  links: readonly GraphLink[];
  draft: RelationSuggestionDraft;
  disabled: boolean;
  onChange: (draft: RelationSuggestionDraft) => void;
}

export function RelationSuggestionFields({ concept, concepts, links, draft, disabled, onChange }: RelationSuggestionFieldsProps) {
  const id = useId();
  const [query, setQuery] = useState('');
  const other = concepts.find((item) => item.id === draft.otherConceptId);
  const search = query.trim().toLocaleLowerCase();
  const options = concepts.filter((item) => item.id !== concept.id && (
    item.id === draft.otherConceptId || !search
    || [item.id, item.title, item.source.path, domainLabel(domainIdOf(item))].some((value) => value.toLocaleLowerCase().includes(search))
  ));
  const existing = directedSuggestionLinks(concept.id, draft, links);
  const relations = existing.filter((link, index) => existing.findIndex((candidate) => (
    candidate.type === link.type && candidate.description === link.description
  )) === index);
  const key = (value: { type: string; description: string }) => JSON.stringify([value.type, value.description]);
  const change = (patch: Partial<RelationSuggestionDraft>) => { if (!disabled) onChange({ ...draft, ...patch }); };

  return <details className="application-record-details relation-suggestion-fields">
    <summary>关系建议（可选）</summary>
    <label className="relation-suggestion-enable">
      <input type="checkbox" checked={draft.enabled} disabled={disabled} onChange={(event) => {
        if (disabled) return;
        onChange(event.currentTarget.checked ? { ...draft, enabled: true } : createRelationSuggestionDraft());
      }} />为这条记录添加一条关系建议
    </label>
    {draft.enabled ? <>
      <p className="relation-suggestion-note">待核对建议，尚未验证采纳。这里只保存记录时快照，不会自动修改知识源。</p>
      <div className="application-record-detail-grid">
        <label className="application-record-field" htmlFor={`${id}-search`}><span>搜索第二个概念</span>
          <input id={`${id}-search`} type="search" value={query} disabled={disabled} placeholder="搜索标题、领域、路径或 ID" onChange={(event) => { if (!disabled) setQuery(event.currentTarget.value); }} />
        </label>
        <label className="application-record-field" htmlFor={`${id}-concept`}><span id={`${id}-concept-label`}>第二个概念（全部领域）</span>
          <select id={`${id}-concept`} aria-labelledby={`${id}-concept-label`} aria-describedby={!options.length ? `${id}-concept-help` : undefined} value={draft.otherConceptId} disabled={disabled} onChange={(event) => change({ otherConceptId: event.currentTarget.value, before: null })}>
            <option value="">请选择概念</option>
            {options.map((item) => <option key={item.id} value={item.id}>{item.title} · {domainLabel(domainIdOf(item))} · {item.source.path} · {item.id}</option>)}
          </select>
          {!options.length ? <small id={`${id}-concept-help`}>没有匹配的其他概念。</small> : null}
        </label>
        <label className="application-record-field" htmlFor={`${id}-direction`}><span id={`${id}-direction-label`}>关系方向</span>
          <select id={`${id}-direction`} aria-labelledby={`${id}-direction-label`} aria-describedby={`${id}-direction-help`} value={draft.direction} disabled={disabled} onChange={(event) => {
            const direction = event.currentTarget.value;
            if (direction === 'outgoing' || direction === 'incoming') change({ direction, before: null });
          }}>
            <option value="outgoing">当前概念 → 第二个概念</option>
            <option value="incoming">第二个概念 → 当前概念</option>
          </select>
          <small id={`${id}-direction-help`}>{draft.direction === 'outgoing' ? `${concept.title} → ${other?.title ?? '请选择第二个概念'}` : `${other?.title ?? '请选择第二个概念'} → ${concept.title}`}</small>
        </label>
        <label className="application-record-field" htmlFor={`${id}-operation`}><span id={`${id}-operation-label`}>建议操作</span>
          <select id={`${id}-operation`} aria-labelledby={`${id}-operation-label`} value={draft.operation} disabled={disabled} onChange={(event) => {
            const operation = event.currentTarget.value;
            if (operation === 'add' || operation === 'change' || operation === 'remove') change({ operation, before: null });
          }}>
            {(['add', 'change', 'remove'] as const).map((operation) => <option key={operation} value={operation}>{RELATION_OPERATION_LABELS[operation]}</option>)}
          </select>
        </label>
      </div>
      {draft.operation !== 'add' ? <label className="application-record-field" htmlFor={`${id}-before`}><span id={`${id}-before-label`}>该方向现有的原关系</span>
        <select id={`${id}-before`} aria-labelledby={`${id}-before-label`} aria-describedby={`${id}-before-help`} value={draft.before ? key(draft.before) : ''} disabled={disabled} onChange={(event) => {
          const link = relations.find((candidate) => key(candidate) === event.currentTarget.value);
          const before = link ? { type: link.type, description: link.description } : null;
          change({ before, ...(before && draft.operation === 'change' ? { after: { ...before } } : {}) });
        }}>
          <option value="">请选择原关系</option>
          {relations.map((link) => <option key={key(link)} value={key(link)}>{link.type} · {link.description || '（无描述）'}</option>)}
        </select>
        <small id={`${id}-before-help`}>{relations.length ? '原关系的类型和描述会一并保存。' : '该方向没有现有关系，无法提出修改或移除建议。'}修改方向请分别记录移除和新增建议。</small>
      </label> : null}
      {draft.operation !== 'remove' ? <div className="application-record-detail-grid">
        <label className="application-record-field" htmlFor={`${id}-type`}><span>建议关系类型</span>
          <input id={`${id}-type`} value={draft.after.type} maxLength={256} disabled={disabled} onChange={(event) => change({ after: { ...draft.after, type: event.currentTarget.value } })} />
        </label>
        <label className="application-record-field" htmlFor={`${id}-description`}><span>建议关系描述（可选）</span>
          <textarea id={`${id}-description`} value={draft.after.description} maxLength={4000} disabled={disabled} onChange={(event) => change({ after: { ...draft.after, description: event.currentTarget.value } })} />
        </label>
      </div> : null}
      <p className="relation-suggestion-note">启用后请选完整的概念、方向和关系；取消勾选会放弃这条关系建议。</p>
    </> : null}
  </details>;
}
