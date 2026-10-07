import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type ReactElement } from 'react';
import type { ApplicationRecordRequest, Concept, GraphLink } from '../shared/types';
import { RelationSuggestionFields } from './RelationSuggestionFields';
import {
  APPLICATION_ASSISTANCE,
  APPLICATION_ASSISTANCE_LABELS,
  APPLICATION_CONTENT_MAX_LENGTH,
  APPLICATION_KIND_LABELS,
  APPLICATION_KINDS,
  APPLICATION_MATERIAL_FIELDS,
  APPLICATION_MATERIAL_LABELS,
  APPLICATION_OUTCOME_LABELS,
  APPLICATION_OUTCOMES,
  APPLICATION_TEXT_MAX_LENGTH,
  buildApplicationMaterial,
  buildApplicationRecordRequest,
  createApplicationRecordDraft,
  createRelationSuggestionDraft,
  defaultApplicationMaterialFields,
  newApplicationRecordEventId,
  type ApplicationMaterialField,
  type ApplicationRecordDraft,
} from './application-record';

export type { ApplicationMaterialField } from './application-record';
export { buildApplicationMaterial } from './application-record';

export interface ApplicationRecordDialogProps {
  concept: Concept;
  initialDraft?: ApplicationRecordDraft;
  concepts?: readonly Concept[];
  links?: readonly GraphLink[];
  busy: boolean;
  onSave: (request: ApplicationRecordRequest) => Promise<boolean>;
  onClose: () => void;
}

interface DialogState extends ApplicationRecordDraft {
  submittedRequest: ApplicationRecordRequest | null;
  validationError: string | null;
  saveError: string | null;
}

function initialState(draft?: ApplicationRecordDraft): DialogState {
  return {
    ...(draft ? { ...draft } : createApplicationRecordDraft()),
    submittedRequest: null,
    validationError: null,
    saveError: null,
  };
}

function draftFromState(state: DialogState): ApplicationRecordDraft {
  return {
    kind: state.kind,
    context: state.context,
    content: state.content,
    outcome: state.outcome,
    assistance: state.assistance,
    result: state.result,
    limitations: state.limitations,
    insight: state.insight,
    correction: state.correction,
    references: state.references,
    ...(state.relationSuggestion ? { relationSuggestion: state.relationSuggestion } : {}),
  };
}

function isDirty(state: DialogState): boolean {
  return Boolean(
    state.context.trim() || state.content.trim() || state.result.trim() || state.limitations.trim()
      || state.insight.trim() || state.correction.trim() || state.references.trim()
      || state.outcome !== 'unverified' || state.assistance !== 'unknown' || state.kind !== 'application'
      || state.relationSuggestion?.enabled,
  );
}

function confirmDiscard(state: DialogState): boolean {
  if (!isDirty(state) || typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  return window.confirm('这条应用 / 总结记录尚未保存，确定关闭并丢弃吗？');
}

function updateField<K extends keyof ApplicationRecordDraft>(
  setState: React.Dispatch<React.SetStateAction<DialogState>>,
  field: K,
  value: ApplicationRecordDraft[K],
) {
  setState((current) => current.submittedRequest ? current : { ...current, [field]: value, validationError: null, saveError: null });
}

function textArea(
  value: string,
  maxLength: number,
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void,
  id: string,
  placeholder: string,
  disabled: boolean,
) {
  return <>
    <textarea id={id} value={value} maxLength={maxLength} disabled={disabled} onChange={onChange} placeholder={placeholder} />
    <small>{value.length} / {maxLength}</small>
  </>;
}

export function ApplicationRecordDialog({ concept, initialDraft, concepts = [], links = [], busy, onSave, onClose }: ApplicationRecordDialogProps): ReactElement {
  const stateRef = useRef<DialogState | null>(null);
  if (!stateRef.current) stateRef.current = initialState(initialDraft);
  const [state, setState] = useState<DialogState>(stateRef.current);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closeRequestedRef = useRef(false);
  const titleId = useId();
  const contextId = useId();
  const contentId = useId();
  const outcomeId = useId();
  const assistanceId = useId();
  const resultId = useId();
  const limitationsId = useId();
  const insightId = useId();
  const correctionId = useId();
  const referencesId = useId();
  const isBusy = busy || saving;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (!dialog.open && typeof dialog.showModal === 'function') dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
      const previous = previousFocusRef.current;
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
    };
  }, []);

  const close = () => {
    if (isBusy || savingRef.current || closeRequestedRef.current) return;
    if (!confirmDiscard(state)) return;
    closeRequestedRef.current = true;
    onClose();
  };

  const save = async () => {
    if (isBusy || savingRef.current) return;
    savingRef.current = true;
    let request = state.submittedRequest;
    if (!request) {
      try {
        request = buildApplicationRecordRequest(concept, draftFromState(state), new Date().toISOString(), newApplicationRecordEventId(), { concepts, links });
      } catch (error: unknown) {
        setState((current) => ({ ...current, validationError: error instanceof Error ? error.message : '请补充记录内容。' }));
        savingRef.current = false;
        return;
      }
      setState((current) => ({ ...current, submittedRequest: request, validationError: null, saveError: null }));
    }
    setSaving(true);
    try {
      const saved = await onSave(request);
      if (saved) {
        closeRequestedRef.current = true;
        onClose();
      } else {
        setState((current) => ({ ...current, submittedRequest: request, saveError: '记录没有确认写入，请检查连接后重试。' }));
      }
    } catch (error: unknown) {
      setState((current) => ({ ...current, submittedRequest: request, saveError: error instanceof Error ? error.message : '记录没有确认写入，请检查连接后重试。' }));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const submitted = Boolean(state.submittedRequest);
  const fieldDisabled = isBusy || submitted;
  const detailsId = useId();

  return <dialog
    ref={dialogRef}
    className="application-record-dialog"
    aria-labelledby={titleId}
    aria-modal="true"
    onCancel={(event) => { event.preventDefault(); close(); }}
  >
    <div className="application-record-shell">
      <header className="application-record-header">
        <div>
          <span className="application-record-kicker">知识使用记录</span>
          <h2 id={titleId}>{state.kind === 'application' ? '记录一次实际应用' : '记录一次学习总结'}</h2>
          <p className="application-record-concept">{concept.title}<span>{concept.domain}</span></p>
        </div>
        <button type="button" className="application-record-close" onClick={close} disabled={isBusy} aria-label="关闭记录窗口">×</button>
      </header>

      <section className="application-record-body" aria-labelledby={titleId}>
        <p className="application-record-intro">这条记录用于积累知识在真实工作和学习中的使用证据。它独立于回忆测试，不会自动改变衰减状态，也不会自动写回共享知识源。</p>
        {initialDraft ? <p className="application-record-intro">已从场景核对预填学习总结，请检查并补充自己的理解。若确实用于工作，可切换为实际应用，再填写辅助方式和结果；原始回答仍单独保存在场景观察中。</p> : null}

        <div className="application-record-kind" role="group" aria-label="记录类型">
          {APPLICATION_KINDS.map((kind) => <button key={kind} type="button" aria-pressed={state.kind === kind} disabled={fieldDisabled} onClick={() => updateField(setState, 'kind', kind)}>{APPLICATION_KIND_LABELS[kind]}</button>)}
        </div>

        <div className="application-record-main-fields">
          <label className="application-record-field" htmlFor={contextId}>
            <span>{state.kind === 'application' ? '应用场景' : '来源 / 主题'}{state.kind === 'summary' ? '（可选）' : ''}</span>
            {textArea(state.context, APPLICATION_TEXT_MAX_LENGTH, (event) => updateField(setState, 'context', event.target.value), contextId, state.kind === 'application' ? '例如：为一个数据处理流程设计清晰的规则校验……' : '例如：读完一组关于注意力机制的资料后整理要点……', fieldDisabled)}
          </label>
          <label className="application-record-field" htmlFor={contentId}>
            <span>{state.kind === 'application' ? '你如何使用或解释这个概念' : '自己的解释 / 总结'}<b aria-hidden="true">必填</b></span>
            {textArea(state.content, APPLICATION_CONTENT_MAX_LENGTH, (event) => updateField(setState, 'content', event.target.value), contentId, '尽量用自己的话写下具体做法、判断过程或关键原理。', fieldDisabled)}
          </label>
        </div>

        <div className="application-record-selects">
          <label className="application-record-field" htmlFor={outcomeId}><span>结果判断</span><select id={outcomeId} value={state.outcome} disabled={fieldDisabled} onChange={(event) => updateField(setState, 'outcome', event.target.value as ApplicationRecordDraft['outcome'])}>{APPLICATION_OUTCOMES.map((value) => <option key={value} value={value}>{APPLICATION_OUTCOME_LABELS[value]}</option>)}</select></label>
          <label className="application-record-field" htmlFor={assistanceId}><span>完成时的辅助方式</span><select id={assistanceId} value={state.assistance} disabled={fieldDisabled} onChange={(event) => updateField(setState, 'assistance', event.target.value as ApplicationRecordDraft['assistance'])}>{APPLICATION_ASSISTANCE.map((value) => <option key={value} value={value}>{APPLICATION_ASSISTANCE_LABELS[value]}</option>)}</select></label>
        </div>

        <details id={detailsId} className="application-record-details">
          <summary>补充结果、限制和 insight（可选）</summary>
          <div className="application-record-detail-grid">
            <label className="application-record-field" htmlFor={resultId}><span>结果</span>{textArea(state.result, APPLICATION_TEXT_MAX_LENGTH, (event) => updateField(setState, 'result', event.target.value), resultId, '实际产出、验证结果或当前进展。', fieldDisabled)}</label>
            <label className="application-record-field" htmlFor={limitationsId}><span>限制与未解决问题</span>{textArea(state.limitations, APPLICATION_TEXT_MAX_LENGTH, (event) => updateField(setState, 'limitations', event.target.value), limitationsId, '哪些条件、数据或边界仍然限制了它。', fieldDisabled)}</label>
            <label className="application-record-field" htmlFor={insightId}><span>新的 insight</span>{textArea(state.insight, APPLICATION_TEXT_MAX_LENGTH, (event) => updateField(setState, 'insight', event.target.value), insightId, '这次使用后得到的新连接、新判断或新问题。', fieldDisabled)}</label>
            <label className="application-record-field" htmlFor={correctionId}><span>需要修正的理解</span>{textArea(state.correction, APPLICATION_TEXT_MAX_LENGTH, (event) => updateField(setState, 'correction', event.target.value), correctionId, '原先哪里理解得不准确，之后要怎样修正。', fieldDisabled)}</label>
            <label className="application-record-field" htmlFor={referencesId}><span>参考资料与线索</span>{textArea(state.references, APPLICATION_TEXT_MAX_LENGTH, (event) => updateField(setState, 'references', event.target.value), referencesId, '可供后续整理的链接、文件或概念线索。', fieldDisabled)}</label>
          </div>
        </details>

        <RelationSuggestionFields
          concept={concept}
          concepts={concepts}
          links={links}
          draft={state.relationSuggestion ?? createRelationSuggestionDraft()}
          disabled={fieldDisabled}
          onChange={(draft) => updateField(setState, 'relationSuggestion', draft)}
        />

        {state.validationError ? <p className="application-record-error" role="alert">{state.validationError}</p> : null}
        {state.saveError ? <p className="application-record-error" role="alert">{state.saveError}</p> : null}
        {state.saveError && state.submittedRequest ? <details className="application-record-retain">
          <summary>保存遇到问题？先保留当前材料</summary>
          <p>如果知识源版本已经变化，原记录可能无法按冻结版本重试。你可以选择字段并复制为 Markdown，之后再手动交给 progressive-kg 整理；这里不会自动发布。</p>
          <ApplicationMaterialPreview concept={concept} record={state.submittedRequest} />
        </details> : null}
        <div className="application-record-actions">
          <button type="button" className="application-record-button secondary" onClick={close} disabled={isBusy}>取消，不保存</button>
          <button type="button" className="application-record-button primary" onClick={() => void save()} disabled={isBusy}>{saving ? '保存中…' : submitted ? '重试保存' : '保存这条记录'}</button>
        </div>
        <p className="application-record-footnote">保存后可以在历史记录中选择需要交给 progressive-kg 的字段并复制为 Markdown；选择和复制都不会自动发布或修改原知识源。</p>
      </section>
    </div>
  </dialog>;
}

export interface ApplicationMaterialPreviewProps {
  concept: Pick<Concept, 'id' | 'title' | 'source'>;
  record: ApplicationRecordRequest;
}

export function ApplicationMaterialPreview({ concept, record }: ApplicationMaterialPreviewProps): ReactElement {
  const [selected, setSelected] = useState<ApplicationMaterialField[]>(() => defaultApplicationMaterialFields(record));
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const material = useMemo(() => buildApplicationMaterial(concept, record, selected), [concept, record, selected]);

  useEffect(() => {
    setSelected(defaultApplicationMaterialFields(record));
    setCopied(false);
    setCopyError(null);
  }, [record]);

  const toggle = (field: ApplicationMaterialField) => {
    setSelected((current) => current.includes(field) ? current.filter((value) => value !== field) : [...current, field]);
    setCopied(false);
    setCopyError(null);
  };

  const copy = async () => {
    setCopyError(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前环境没有可用的剪贴板权限。');
      await navigator.clipboard.writeText(material);
      setCopied(true);
    } catch (error: unknown) {
      setCopied(false);
      setCopyError(error instanceof Error ? error.message : '复制失败；请从下方文本框手动复制。');
    }
  };

  return <section className="application-material-preview" aria-label="可复制的知识材料">
    <p className="application-material-note">选择要交给 progressive-kg 整理的字段。业务上下文和原始内容默认不选，系统也不会自动发布。</p>
    <div className="application-material-fields" role="group" aria-label="材料字段">
      {APPLICATION_MATERIAL_FIELDS.map((field) => <label key={field}><input type="checkbox" checked={selected.includes(field)} onChange={() => toggle(field)} />{APPLICATION_MATERIAL_LABELS[field]}</label>)}
    </div>
    <pre className="application-material-output" aria-label="Markdown 预览">{material}</pre>
    <div className="application-material-actions">
      <button type="button" className="application-record-button secondary" onClick={() => void copy()}>{copied ? '已复制' : '复制 Markdown'}</button>
      {copyError ? <span className="application-material-copy-error" role="alert">{copyError}</span> : null}
    </div>
    {copyError ? <textarea className="application-material-fallback" readOnly value={material} aria-label="手动复制 Markdown" /> : null}
  </section>;
}

export default ApplicationRecordDialog;
