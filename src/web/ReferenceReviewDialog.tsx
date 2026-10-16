import { useEffect, useId, useRef, useState } from 'react';
import type { ActivityReference } from '../shared/activity';
import type { ActivityReferenceCurrentStatus } from '../shared/activity-reference-status';
import type { KnowledgeReferences } from '../shared/knowledge-references';
import type { Concept } from '../shared/types';
import { referencesMatchConcept } from './concept-reader-state';

export interface ReferenceReviewDialogProps {
  scopeKey: string;
  reference: ActivityReference;
  status: ActivityReferenceCurrentStatus;
  concepts: readonly Concept[];
  loadReferences: (concept: Concept, signal?: AbortSignal) => Promise<KnowledgeReferences>;
  onConfirm: (target: { concept: Concept; sectionId?: string }) => void | Promise<void>;
  onClose: () => void;
}
export type ReferenceReviewTarget = { kind: 'document' } | { kind: 'section'; sectionId: string };

export function initialReferenceCandidate(reference: ActivityReference, concepts: readonly Concept[]): string {
  return concepts.some((concept) => concept.id === reference.conceptId) ? reference.conceptId : '';
}

export function referenceReviewDisabledReason(concept: Concept | null, metadata: KnowledgeReferences | null,
  target: ReferenceReviewTarget | null, pending = false): string | null {
  if (pending) return '正在核对并打开，请稍候。';
  if (!concept) return '请先明确选择一份当前资料。';
  if (!referencesMatchConcept(metadata, concept)) return '当前资料目录尚未核验，请加载成功后再选择阅读位置。';
  if (!target) return '请选择当前全文，或明确选择一个当前章节。';
  if (target.kind === 'section' && !metadata!.sections.some((section) => section.sectionId === target.sectionId)) return '所选章节已失效，请重新选择。';
  return null;
}

export function referenceReviewStatusMessage(status: ActivityReferenceCurrentStatus['status']): string {
  return {
    current: '原引用仍可定位。你也可以明确选择当前资料，开始一次新的阅读。',
    'source-changed': '资料版本已经变化，旧章节不会自动对应到当前章节。',
    'source-moved': '资料路径已经变化，请重新确认当前资料和阅读位置。',
    'missing-concept': '原概念当前不存在。请从当前知识库明确选择资料；同名资料不会自动配对。',
    'location-unresolved': '原章节或正文块已无法精确定位，请重新选择当前阅读位置。',
  }[status];
}

export function ReferenceReviewDialog({ scopeKey, reference, status, concepts, loadReferences, onConfirm, onClose }: ReferenceReviewDialogProps) {
  const titleId = useId(); const candidateInputId = useId(); const radioName = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backdropDown = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const confirmEpoch = useRef(0);
  const pendingRef = useRef(false);
  const identity = JSON.stringify([scopeKey, reference.conceptId, reference.sourceRevision, reference.path,
    reference.scope, reference.sectionId, reference.blockId, reference.bodyRange]);
  const [candidateState, setCandidateState] = useState({ identity, id: initialReferenceCandidate(reference, concepts) });
  const candidateId = candidateState.identity === identity ? candidateState.id : initialReferenceCandidate(reference, concepts);
  const concept = concepts.find((entry) => entry.id === candidateId) ?? null;
  const candidateKey = JSON.stringify([identity, concept?.id, concept?.source.revision, concept?.source.path]);
  const latestCandidateKey = useRef(candidateKey);
  latestCandidateKey.current = candidateKey;
  const [metadataState, setMetadataState] = useState<{ key: string; data: KnowledgeReferences | null; loading: boolean; error: string | null } | null>(null);
  const [targetState, setTargetState] = useState<{ key: string; value: ReferenceReviewTarget | null }>({ key: candidateKey, value: null });
  const [pendingState, setPendingState] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<{ key: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const metadata = metadataState?.key === candidateKey && concept && referencesMatchConcept(metadataState.data, concept) ? metadataState.data : null;
  const target = targetState.key === candidateKey ? targetState.value : null;
  const pending = pendingState === identity;
  const disabledReason = referenceReviewDisabledReason(concept, metadata, target, pending);

  useEffect(() => {
    confirmEpoch.current += 1; pendingRef.current = false; setPendingState(null); setConfirmError(null);
  }, [candidateKey]);

  useEffect(() => {
    const controller = new AbortController(); controllerRef.current = controller;
    const ticket = ++generation.current;
    setTargetState({ key: candidateKey, value: null });
    setConfirmError(null);
    if (!concept) { setMetadataState(null); return () => controller.abort(); }
    setMetadataState({ key: candidateKey, data: null, loading: true, error: null });
    void Promise.resolve().then(() => controller.signal.aborted ? null : loadReferences(concept, controller.signal)).then((data) => {
      if (controller.signal.aborted || ticket !== generation.current) return;
      if (!data || !referencesMatchConcept(data, concept)) throw new Error('目录与所选资料版本不一致，请重新加载后核对。');
      setMetadataState({ key: candidateKey, data, loading: false, error: null });
    }).catch((error) => {
      if (controller.signal.aborted || ticket !== generation.current) return;
      setMetadataState({ key: candidateKey, data: null, loading: false, error: error instanceof Error ? error.message : '当前资料目录加载失败，请重试。' });
    });
    return () => { controller.abort(); generation.current += 1; };
  }, [candidateKey, retry, loadReferences]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; dialog.showModal();
    return () => {
      controllerRef.current?.abort(); generation.current += 1; confirmEpoch.current += 1;
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  const close = () => {
    controllerRef.current?.abort(); generation.current += 1; confirmEpoch.current += 1;
    onClose();
  };
  const selectCandidate = (id: string) => {
    if (pendingRef.current) return;
    controllerRef.current?.abort(); generation.current += 1;
    setCandidateState({ identity, id }); setMetadataState(null);
    setTargetState({ key: '', value: null }); setConfirmError(null);
  };
  const confirm = async () => {
    if (pendingRef.current || disabledReason || !concept || !target) return;
    pendingRef.current = true; setPendingState(identity); setConfirmError(null);
    const ticket = confirmEpoch.current;
    const active = () => ticket === confirmEpoch.current && latestCandidateKey.current === candidateKey;
    try {
      await onConfirm({ concept, ...(target.kind === 'section' ? { sectionId: target.sectionId } : {}) });
      if (active()) close();
    } catch (error) {
      if (active()) setConfirmError({ key: candidateKey,
        message: error instanceof Error ? error.message : '当前资料暂时无法打开，请重新核对后重试。' });
    } finally {
      if (active()) { pendingRef.current = false; setPendingState(null); }
    }
  };

  return <dialog ref={dialogRef} className="reference-review-dialog" aria-labelledby={titleId} aria-modal="true"
    onCancel={(event) => { event.preventDefault(); close(); }}
    onPointerDown={(event) => { backdropDown.current = event.target === event.currentTarget; }}
    onClick={(event) => {
      if (!backdropDown.current || event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }}>
    <header><div><span className="eyebrow">引用复核</span><h2 id={titleId}>重新选择当前阅读位置</h2></div>
      <button type="button" className="reference-review-close" onClick={close} aria-label="关闭引用复核" autoFocus>×</button></header>
    <div className="reference-review-scroll">
      <p role="status">{referenceReviewStatusMessage(status.status)}</p>
      <div className="reference-review-comparison">
        <section aria-label="保留的原引用"><h3>保留的原引用</h3><dl>
          <dt>概念</dt><dd>{reference.title || reference.conceptId}</dd><dt>路径</dt><dd>{reference.path}</dd>
          <dt>版本</dt><dd>{reference.sourceRevision}</dd>
          <dt>原内容范围</dt><dd>{reference.contentPart === 'summary' || reference.scope === 'summary' ? '摘要' : reference.scope === 'result' ? '查询结果' : '正文'}</dd>
          {reference.sectionId ? <><dt>原章节</dt><dd>{reference.sectionId}</dd></> : null}
          {reference.blockId ? <><dt>原内容块</dt><dd>{reference.blockId}</dd></> : null}
          {reference.bodyRange ? <><dt>原显示范围</dt><dd>第 {reference.bodyRange.startLine}–{reference.bodyRange.endLine} 行 · 偏移 {reference.bodyRange.startOffset}–{reference.bodyRange.endOffset}（显示正文坐标）</dd></> : null}
        </dl></section>
        <section aria-label="当前候选资料"><h3>当前候选资料</h3>
          <label htmlFor={candidateInputId}>明确选择当前概念</label>
          <select id={candidateInputId} value={candidateId} onChange={(event) => selectCandidate(event.currentTarget.value)} disabled={pending}>
            <option value="">请选择资料</option>
            {concepts.map((entry) => <option key={entry.id} value={entry.id}>{entry.title} · {entry.source.path}</option>)}
          </select>
          {concept ? <dl><dt>概念</dt><dd>{concept.title}</dd><dt>路径</dt><dd>{concept.source.path}</dd><dt>当前版本</dt><dd>{concept.source.revision}</dd></dl>
            : <p>即使存在同名概念，也需要你明确选择。</p>}
        </section>
      </div>
      <section className="reference-review-targets" aria-label="当前阅读位置"><h3>明确选择当前阅读位置</h3>
        {metadataState?.key === candidateKey && metadataState.loading ? <p role="status">正在核验当前资料目录…</p> : null}
        {metadataState?.key === candidateKey && metadataState.error ? <p role="alert">{metadataState.error}</p> : null}
        {concept ? <button type="button" onClick={() => { setTargetState({ key: '', value: null }); setMetadataState(null); setRetry((value) => value + 1); }} disabled={pending || Boolean(metadataState?.key === candidateKey && metadataState.loading)}>重新加载当前目录</button> : null}
        <label className="reference-review-whole"><input type="radio" name={radioName} checked={target?.kind === 'document'}
          disabled={!metadata || pending} onChange={() => setTargetState({ key: candidateKey, value: { kind: 'document' } })} />当前全文</label>
        {metadata ? <div className="reference-review-chapters" role="group" aria-label="可选择的当前章节">
          {metadata.sections.length ? metadata.sections.map((section) => <button type="button" key={section.sectionId} disabled={pending}
            style={{ paddingInlineStart: `${12 + (section.level - 1) * 12}px` }}
            aria-pressed={target?.kind === 'section' && target.sectionId === section.sectionId}
            onClick={() => setTargetState({ key: candidateKey, value: { kind: 'section', sectionId: section.sectionId } })}>{section.headingPath.join(' › ')} · {section.sectionId}</button>)
            : <p>当前资料没有章节，可明确选择全文。</p>}
        </div> : null}
      </section>
      <p className="reference-review-boundary">旧引用和学习记录会保留。查阅追踪开启时，会另记新的阅读引用；旧引用不改。不会复制旧学习表现、长期保持状态或自动登记概念身份。疑似拆分或合并时，也请明确选择当前资料。</p>
      {confirmError?.key === candidateKey ? <p role="alert">{confirmError.message}</p> : null}
    </div>
    <footer><span role="status">{disabledReason ?? '已明确选择当前阅读位置，打开前会再次核对版本。'}</span>
      <button type="button" disabled={Boolean(disabledReason)} onClick={() => void confirm()}>打开当前资料</button></footer>
  </dialog>;
}
