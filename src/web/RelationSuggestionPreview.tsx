import type { RelationSuggestion, RelationSuggestionEndpoint } from '../shared/types';
import { RELATION_OPERATION_LABELS } from './application-record';

export interface RelationSuggestionPreviewProps { suggestion: RelationSuggestion }

function Endpoint({ label, value }: { label: string; value: RelationSuggestionEndpoint }) {
  return <div className="relation-suggestion-endpoint">
    <h4>{label}：{value.title}</h4>
    <dl><dt>ID</dt><dd>{value.conceptId}</dd><dt>路径</dt><dd>{value.path}</dd><dt>版本</dt><dd>{value.sourceRevision}</dd></dl>
  </div>;
}

export function RelationSuggestionPreview({ suggestion }: RelationSuggestionPreviewProps) {
  return <section className="relation-suggestion-preview" aria-label="关系建议快照">
    <h3>{RELATION_OPERATION_LABELS[suggestion.operation]}</h3>
    <p className="relation-suggestion-note">待核对建议，尚未验证采纳。记录时快照，整理前核对当前知识源。</p>
    <p className="relation-suggestion-direction">{suggestion.source.title} → {suggestion.target.title}</p>
    <div className="relation-suggestion-endpoints">
      <Endpoint label="源概念" value={suggestion.source} />
      <Endpoint label="目标概念" value={suggestion.target} />
    </div>
    <dl className="relation-suggestion-values">
      {suggestion.operation !== 'add' ? <><dt>原关系类型</dt><dd>{suggestion.before.type}</dd><dt>原关系描述</dt><dd>{suggestion.before.description || '（无描述）'}</dd></> : null}
      {suggestion.operation !== 'remove' ? <><dt>建议关系类型</dt><dd>{suggestion.after.type}</dd><dt>建议关系描述</dt><dd>{suggestion.after.description || '（无描述）'}</dd></> : null}
    </dl>
  </section>;
}
