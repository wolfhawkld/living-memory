import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import type { Concept } from '../shared/types';
import { MarkdownView } from './MarkdownView';
import { referencesMatchConcept, relativeSource, sectionNavigationMessage, type ReaderSection } from './concept-reader-state';
import type { KnowledgeContentBlock, KnowledgeReference, KnowledgeReferences } from '../shared/knowledge-references';
import { isForegroundReader, observeReaderContent } from './reader-activity';

export interface ReaderOpenedFact { conceptId: string; sourceRevision: string; contentPart: ReaderSection; requestedSectionId?: string }
export interface ReaderVisibleFact { conceptId: string; sourceRevision: string; contentPart: ReaderSection; blocks: KnowledgeContentBlock[] }
export interface ConceptReaderProps {
  concept: Concept; sourceId: string; initialSection: ReaderSection; onClose: () => void;
  loadReferences?: (concept: Concept, signal?: AbortSignal) => Promise<KnowledgeReferences>;
  onNavigateReference?: (reference: KnowledgeReference) => void | Promise<void>;
  initialSectionId?: string;
  trackingEnabled?: boolean;
  onReaderOpened?: (fact: ReaderOpenedFact) => void;
  onContentVisible?: (fact: ReaderVisibleFact) => void;
}
export function ConceptReader({ concept, sourceId, initialSection, onClose, loadReferences, onNavigateReference,
  initialSectionId, trackingEnabled = false, onReaderOpened, onContentVisible }: ConceptReaderProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const backdropDown = useRef(false);
  const titleId = useId();
  const [section, setSection] = useState(initialSection);
  const [fontSize, setFontSize] = useState(17);
  const identity = JSON.stringify([sourceId, concept.id, concept.source.revision]);
  const [referenceState, setReferenceState] = useState<{ identity: string; data: KnowledgeReferences | null; failed: boolean } | null>(null);
  const [currentSection, setCurrentSection] = useState<string | null>(null);
  const [navigationMessage, setNavigationMessage] = useState('');
  const [renderedBody, setRenderedBody] = useState<{ identity: string; section: ReaderSection; version: number } | null>(null);
  const renderVersion = renderedBody?.identity === identity && renderedBody.section === section ? renderedBody.version : 0;
  const initialLocated = useRef<string | null>(null);
  const opened = useRef(new Set<string>());
  const seenBlocks = useRef(new Map<string, Set<string>>());
  const activityView = useRef({ identity, section, trackingEnabled });
  activityView.current = { identity, section, trackingEnabled };
  const activityCallbacks = useRef({ onReaderOpened, onContentVisible });
  activityCallbacks.current = { onReaderOpened, onContentVisible };
  const navigationEpoch = useRef(0);
  const navigationPending = useRef(false);
  const references = referenceState?.identity === identity && referencesMatchConcept(referenceState.data, concept) ? referenceState.data : null;
  const rendered = useCallback(() => setRenderedBody((value) => ({ identity, section, version: (value?.version ?? 0) + 1 })), [identity, section]);

  useEffect(() => {
    const controller = new AbortController();
    navigationEpoch.current += 1;
    navigationPending.current = false;
    let active = true;
    setReferenceState(null);
    setCurrentSection(null);
    setNavigationMessage('');
    setSection(initialSectionId ? 'body' : initialSection);
    initialLocated.current = null;
    if (loadReferences) void Promise.resolve().then(() => {
      if (controller.signal.aborted) return null;
      return loadReferences(concept, controller.signal);
    }).then((data) => {
      if (!active || controller.signal.aborted || !data) return;
      setReferenceState({ identity, data: referencesMatchConcept(data, concept) ? data : null, failed: !referencesMatchConcept(data, concept) });
    }).catch(() => { if (active && !controller.signal.aborted) setReferenceState({ identity, data: null, failed: true }); });
    return () => { active = false; controller.abort(); navigationEpoch.current += 1; };
  }, [identity, loadReferences, initialSection, initialSectionId]);

  const locateSection = useCallback((sectionId: string): boolean => {
    if (section !== 'body' || !references?.sections.some((entry) => entry.sectionId === sectionId)) {
      setNavigationMessage(sectionNavigationMessage('missing-section'));
      return false;
    }
    const target = [...(bodyRef.current?.querySelectorAll<HTMLElement>('[data-knowledge-section]') ?? [])]
      .find((element) => element.dataset.knowledgeSection === sectionId);
    if (!target) { setNavigationMessage(sectionNavigationMessage('missing-section')); return false; }
    target.scrollIntoView({ block: 'start', behavior: 'auto' });
    setCurrentSection(sectionId);
    setNavigationMessage('');
    return true;
  }, [section, references]);

  useEffect(() => {
    if (section === 'body' && initialSectionId && renderVersion && references && initialLocated.current !== identity + initialSectionId) {
      initialLocated.current = identity + initialSectionId;
      locateSection(initialSectionId);
    }
  }, [identity, initialSectionId, references, renderVersion, locateSection, section]);

  // Keep Markdown link component types stable when scrolling updates the active
  // section; replacing a button between pointer down/up would lose its click.
  const navigateReference = useCallback(async (reference: KnowledgeReference) => {
    if (navigationPending.current) return;
    if (!references || reference.sourceConceptId !== concept.id || reference.sourceRevision !== concept.source.revision) {
      setNavigationMessage(sectionNavigationMessage('missing-section')); return;
    }
    if (reference.status !== 'resolved-document' && reference.status !== 'resolved-section') {
      setNavigationMessage(sectionNavigationMessage(reference.status)); return;
    }
    if (reference.targetConceptId === concept.id && reference.targetRevision === concept.source.revision) {
      if (reference.sectionId) locateSection(reference.sectionId);
      else { bodyRef.current?.scrollTo({ top: 0 }); setCurrentSection(null); setNavigationMessage(''); }
    } else if (onNavigateReference) {
      const epoch = navigationEpoch.current;
      navigationPending.current = true;
      setNavigationMessage('正在打开引用资料…');
      try {
        await onNavigateReference(reference);
        if (epoch === navigationEpoch.current) setNavigationMessage('');
      } catch (error) {
        if (epoch === navigationEpoch.current) setNavigationMessage(error instanceof Error
          ? error.message : '引用资料暂时无法打开，可以继续阅读当前全文。');
      } finally {
        if (epoch === navigationEpoch.current) navigationPending.current = false;
      }
    } else setNavigationMessage('引用导航暂不可用，可以继续阅读当前全文。');
  }, [references, concept.id, concept.source.revision, locateSection, onNavigateReference]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const report = () => {
      const key = `${identity}:${section}`;
      if (!trackingEnabled || !activityCallbacks.current.onReaderOpened || !isForegroundReader(dialogRef.current, document)
        || activityView.current.identity !== identity || activityView.current.section !== section || !activityView.current.trackingEnabled || opened.current.has(key)) return;
      opened.current.add(key);
      activityCallbacks.current.onReaderOpened?.({ conceptId: concept.id, sourceRevision: concept.source.revision, contentPart: section,
        ...(section === 'body' && initialSectionId ? { requestedSectionId: initialSectionId } : {}) });
    };
    document.addEventListener('visibilitychange', report);
    document.addEventListener('focusin', report);
    report();
    return () => { document.removeEventListener('visibilitychange', report); document.removeEventListener('focusin', report); };
  }, [identity, section, trackingEnabled, initialSectionId]);

  useEffect(() => {
    const root = bodyRef.current;
    if (!trackingEnabled || !root || !renderVersion || !references?.blocks || !activityCallbacks.current.onContentVisible
      || !(section === 'body' ? concept.body : concept.summary)?.trim()) return;
    const key = `${identity}:${section}`;
    let seen = seenBlocks.current.get(key);
    if (!seen) { seen = new Set(); seenBlocks.current.set(key, seen); }
    return observeReaderContent({ root, contentPart: section, blocks: references.blocks, seen,
      visibility: document, isActive: () => Boolean(isForegroundReader(dialogRef.current, document) && activityView.current.trackingEnabled
        && activityView.current.identity === identity && activityView.current.section === section && activityCallbacks.current.onContentVisible),
      onVisible: (blocks) => activityCallbacks.current.onContentVisible?.({ conceptId: concept.id,
        sourceRevision: concept.source.revision, contentPart: section, blocks }),
    });
  }, [identity, section, trackingEnabled, references, renderVersion]);

  const switchSection = (next: ReaderSection) => {
    setSection(next);
    setCurrentSection(null);
    setNavigationMessage('');
    bodyRef.current?.scrollTo({ top: 0 });
  };

  return <dialog ref={dialogRef} className="concept-reader" aria-labelledby={titleId} aria-modal="true"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onPointerDown={(event) => { backdropDown.current = event.target === event.currentTarget; }}
    onClick={(event) => {
      if (!backdropDown.current || event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <header className="reader-heading">
      <div className="reader-heading-text"><span className="eyebrow">知识阅读</span><h2 id={titleId}>{concept.title}</h2>
        <p className="reader-source">{relativeSource(concept.source.path)}</p>
      </div>
      <button type="button" className="reader-close" onClick={onClose} aria-label="关闭阅读窗口" autoFocus>×</button>
    </header>
    <div className="reader-toolbar">
      <div className="reader-sections" role="group" aria-label="阅读内容">
        <button type="button" aria-pressed={section === 'body'} onClick={() => switchSection('body')}>完整资料</button>
        <button type="button" aria-pressed={section === 'summary'} onClick={() => switchSection('summary')}>核心摘要</button>
      </div>
      <div className="reader-font-controls" role="group" aria-label="阅读字号">
        <button type="button" aria-label="减小字号" disabled={fontSize <= 13} onClick={() => setFontSize((size) => Math.max(13, size - 2))}>A−</button>
        <span aria-live="polite">{fontSize}px</span>
        <button type="button" aria-label="增大字号" disabled={fontSize >= 25} onClick={() => setFontSize((size) => Math.min(25, size + 2))}>A＋</button>
      </div>
    </div>
    <div className="reader-location" aria-live="polite">
      <span>{section === 'summary' ? '核心摘要' : `当前章节：${references?.sections.find((entry) => entry.sectionId === currentSection)?.title ?? '全文'}`}</span>
      <span>来源版本：{concept.source.revision.slice(0, 12)}</span>
    </div>
    {referenceState?.identity === identity && referenceState.failed && <p className="reader-navigation-notice" role="status">章节与引用暂不可用，正文仍可阅读。</p>}
    {initialSectionId && !loadReferences && <p className="reader-navigation-notice" role="status">章节定位暂不可用，已显示全文。</p>}
    {navigationMessage && <p className="reader-navigation-notice" role="status">{navigationMessage}</p>}
    <div className="reader-content-layout">
    {section === 'body' && references && references.sections.length > 0 && <nav className="reader-toc" aria-label="资料目录">
      <span className="eyebrow">目录</span>
      {references.sections.map((entry) => <button type="button" key={entry.sectionId}
        style={{ paddingInlineStart: `${10 + (entry.level - 1) * 10}px` }} aria-current={entry.sectionId === currentSection ? 'location' : undefined}
        onClick={() => locateSection(entry.sectionId)}>{entry.title}</button>)}
    </nav>}
    <div ref={bodyRef} className="reader-scroll" onScroll={() => {
      const container = bodyRef.current;
      if (!container || section !== 'body' || !references) return;
      const top = container.getBoundingClientRect().top;
      let visible: string | null = null;
      for (const heading of container.querySelectorAll<HTMLElement>('[data-knowledge-section]')) {
        if (heading.getBoundingClientRect().top <= top + 80) visible = heading.dataset.knowledgeSection ?? null;
        else break;
      }
      setCurrentSection(visible);
    }} tabIndex={0} role="region" aria-label={section === 'body' ? '完整资料正文' : '核心摘要正文'}
      style={{ '--reader-font-size': `${fontSize}px` } as CSSProperties}>
      <MarkdownView key={`${identity}:${section}`} contentPart={section} content={section === 'body' ? concept.body || '此概念暂无正文。' : concept.summary || '此概念暂无摘要。'}
        source={{ sourceId, conceptId: concept.id, sourceRevision: concept.source.revision }}
        references={section === 'body' ? references?.references : undefined}
        onNavigateReference={section === 'body' ? navigateReference : undefined}
        onNavigateSection={section === 'body' ? locateSection : undefined} onRendered={rendered} />
    </div>
    </div>
    <footer className="reader-footer"><span>阅读不会自动确认重温</span><span>Esc 关闭</span></footer>
  </dialog>;
}
