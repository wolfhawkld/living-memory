import type { KnowledgeContentBlock } from '../shared/knowledge-references';

export interface ReaderVisibilitySource {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange' | 'focusin', callback: () => void): void;
  removeEventListener(type: 'visibilitychange' | 'focusin', callback: () => void): void;
}
export interface ReaderIntersection {
  target: Element;
  isIntersecting: boolean;
  intersectionRect: { width: number; height: number };
}
export interface ReaderBlockObserver { observe(element: Element): void; disconnect(): void }
export interface ReaderContentObserverOptions {
  root: Element;
  contentPart: 'summary' | 'body';
  blocks: readonly KnowledgeContentBlock[];
  seen: Set<string>;
  isActive: () => boolean;
  onVisible: (blocks: KnowledgeContentBlock[]) => void;
  visibility: ReaderVisibilitySource;
  createObserver?: (callback: (entries: readonly ReaderIntersection[]) => void, root: Element) => ReaderBlockObserver;
}

/** Native dialog focus identifies the foremost reader conservatively. */
export function isForegroundReader(dialog: Pick<HTMLDialogElement, 'open' | 'contains'> | null,
  source: { visibilityState: string; activeElement: Element | null }): boolean {
  const active = source.activeElement;
  return Boolean(dialog?.open && source.visibilityState === 'visible' && active
    && dialog.contains(active) && active.closest('dialog') === dialog);
}

/** Reports positive intersections, never inferred reading or learning progress. */
export function observeReaderContent(options: ReaderContentObserverOptions): () => void {
  let disposed = false;
  let generation = 0;
  let observer: ReaderBlockObserver | null = null;
  const catalog = new Map(options.blocks.filter((block) => block.contentPart === options.contentPart).map((block) => [block.blockId, block]));
  const factory = options.createObserver ?? (typeof IntersectionObserver === 'undefined' ? undefined
    : (callback, root) => new IntersectionObserver(callback, { root, threshold: [0, Number.EPSILON] }));
  function stop() { generation += 1; observer?.disconnect(); observer = null; }
  function refresh() {
    const permitted = !disposed && factory && options.visibility.visibilityState === 'visible' && options.isActive();
    if (!permitted) { stop(); return; }
    stop();
    const observed = new Set<Element>();
    const epoch = generation;
    observer = factory!((entries) => {
      if (disposed || epoch !== generation || options.visibility.visibilityState !== 'visible' || !options.isActive()) return;
      const visible: KnowledgeContentBlock[] = [];
      for (const entry of entries) {
        if (!observed.has(entry.target) || !options.root.contains(entry.target) || !entry.isIntersecting
          || !(entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0)) continue;
        const blockId = entry.target.getAttribute('data-knowledge-block');
        const block = blockId ? catalog.get(blockId) : undefined;
        if (!block || options.seen.has(block.blockId)) continue;
        options.seen.add(block.blockId);
        visible.push(block);
      }
      if (visible.length) options.onVisible(visible);
    }, options.root);
    for (const element of options.root.querySelectorAll('[data-knowledge-block]')) {
      const id = element.getAttribute('data-knowledge-block');
      if (!id || !catalog.has(id) || options.seen.has(id)) continue;
      observed.add(element);
      observer.observe(element);
    }
  }
  options.visibility.addEventListener('visibilitychange', refresh);
  options.visibility.addEventListener('focusin', refresh);
  refresh();
  return () => { disposed = true; stop(); options.visibility.removeEventListener('visibilitychange', refresh); options.visibility.removeEventListener('focusin', refresh); };
}
