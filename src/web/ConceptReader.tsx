import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import type { Concept } from '../shared/types';
import { MarkdownView } from './MarkdownView';
import { relativeSource, type ReaderSection } from './concept-reader-state';

export function ConceptReader({ concept, sourceId, initialSection, onClose }: {
  concept: Concept; sourceId: string; initialSection: ReaderSection; onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const backdropDown = useRef(false);
  const titleId = useId();
  const [section, setSection] = useState(initialSection);
  const [fontSize, setFontSize] = useState(17);

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

  const switchSection = (next: ReaderSection) => {
    setSection(next);
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
    <div ref={bodyRef} className="reader-scroll" tabIndex={0} role="region" aria-label={section === 'body' ? '完整资料正文' : '核心摘要正文'}
      style={{ '--reader-font-size': `${fontSize}px` } as CSSProperties}>
      <MarkdownView key={section} content={section === 'body' ? concept.body || '此概念暂无正文。' : concept.summary || '此概念暂无摘要。'}
        source={{ sourceId, conceptId: concept.id, sourceRevision: concept.source.revision }} />
    </div>
    <footer className="reader-footer"><span>阅读不会自动确认重温</span><span>Esc 关闭</span></footer>
  </dialog>;
}
