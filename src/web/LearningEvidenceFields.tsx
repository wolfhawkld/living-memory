import type { LearningEvidence } from '../shared/types';

export function ConfidenceInput({ value, onChange }: { value: number | null; onChange: (value: number | null) => void }) {
  return <label className="learning-field">不查资料，完整解释核心原理和关键条件的把握有多大？
    <select value={value ?? ''} onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}>
      <option value="">暂不预测</option>{[0, 25, 50, 75, 100].map((confidence) => <option value={confidence} key={confidence}>{confidence}%</option>)}
    </select>
    <small>开始作答后固定这次预测，核对结果后再比较。</small>
  </label>;
}

export function LearningEvidenceFields({ value, onChange, disabled }: { value: LearningEvidence; onChange: (value: LearningEvidence) => void; disabled?: boolean }) {
  return <fieldset className="learning-fields" disabled={disabled}>
    <legend>核对结果</legend>
    <label className="learning-field">作答时用了什么帮助？<select value={value.cue} onChange={(e) => onChange({ ...value, cue: e.target.value as LearningEvidence['cue'] })}>
      <option value="unknown">不确定</option><option value="independent">仅凭题目，独立作答</option><option value="hinted">借助额外提示</option><option value="lookup">查阅资料 / AI 后作答</option>
    </select></label>
    <label className="learning-field">与资料或实际应用核对后的结果<select value={value.outcome} onChange={(e) => onChange({ ...value, outcome: e.target.value as LearningEvidence['outcome'] })}>
      <option value="unverified">尚未核对</option><option value="success">核心原理与关键条件正确</option><option value="partial">部分正确 / 有遗漏</option><option value="failure">没有想起或不正确</option>
    </select></label>
    <label className="learning-field">判断依据<select value={value.basis} onChange={(e) => onChange({ ...value, basis: e.target.value as LearningEvidence['basis'] })}>
      <option value="unknown">尚无明确依据</option><option value="self-check">自己对照资料核对</option><option value="application">实际应用结果核对</option>
    </select></label>
    <p className="source-hint">这是你核对后的记录。只有事前有预测、独立作答且结果明确的记录进入信心比较。</p>
  </fieldset>;
}
