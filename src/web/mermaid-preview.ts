import { createSvgObjectUrl, renderMermaidSvg, revokeSvgObjectUrl } from './mermaid-renderer';

export type DiagramTheme = 'dark' | 'light';
export interface DiagramImageSize { width: number; height: number }
export interface MermaidPreviewState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly code: string | null;
  readonly theme: DiagramTheme | null;
  readonly url: string | null;
  readonly size: DiagramImageSize | null;
  readonly error: string | null;
}

export const INITIAL_MERMAID_PREVIEW: MermaidPreviewState = {
  status: 'idle', code: null, theme: null, url: null, size: null, error: null,
};

export interface MermaidPreviewDependencies {
  render: (code: string, options: { theme: DiagramTheme; signal: AbortSignal }) => Promise<{ svg: string }>;
  createUrl: (svg: string) => string;
  revokeUrl: (url: string) => void;
  prepareImage: (url: string, signal: AbortSignal) => Promise<DiagramImageSize | void>;
}

/** Load the replacement before swapping src so the reader keeps its image geometry. */
export function prepareMermaidImage(url: string, signal: AbortSignal): Promise<DiagramImageSize> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const finish = (error?: Error) => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener('abort', abort);
      if (error) {
        image.src = '';
        reject(error);
      } else resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    const abort = () => finish(new Error('图表渲染已取消。'));
    if (signal.aborted) { abort(); return; }
    image.onload = () => finish();
    image.onerror = () => finish(new Error('图表预览加载失败，可重试。'));
    signal.addEventListener('abort', abort, { once: true });
    image.src = url;
  });
}

/** Own request ordering and Blob lifetimes without depending on React or the DOM. */
export function createMermaidPreview(overrides: Partial<MermaidPreviewDependencies> = {}) {
  const deps: MermaidPreviewDependencies = {
    render: renderMermaidSvg, createUrl: createSvgObjectUrl,
    revokeUrl: revokeSvgObjectUrl, prepareImage: prepareMermaidImage, ...overrides,
  };
  let state = INITIAL_MERMAID_PREVIEW;
  let generation = 0;
  let pending: { abort: AbortController; url: string | null } | null = null;
  const ownedUrls = new Set<string>();
  const listeners = new Set<() => void>();
  const publish = (next: MermaidPreviewState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const release = (url: string | null) => {
    if (url && ownedUrls.delete(url)) deps.revokeUrl(url);
  };
  const cancel = () => {
    generation += 1;
    pending?.abort.abort();
    release(pending?.url ?? null);
    pending = null;
  };

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async load(code: string, theme: DiagramTheme): Promise<void> {
      cancel();
      const request = generation;
      const task = { abort: new AbortController(), url: null as string | null };
      pending = task;
      const previousUrl = state.code === code ? state.url : null;
      const previousSize = state.code === code ? state.size : null;
      if (state.code !== code) for (const url of ownedUrls) release(url);
      publish({ status: 'loading', code, theme, url: previousUrl, size: previousSize, error: null });
      const current = () => request === generation && !task.abort.signal.aborted;
      try {
        const { svg } = await deps.render(code, { theme, signal: task.abort.signal });
        if (!current()) return;
        task.url = deps.createUrl(svg);
        ownedUrls.add(task.url);
        const measured = await deps.prepareImage(task.url, task.abort.signal);
        if (!current()) { release(task.url); return; }
        const size = measured && Number.isFinite(measured.width) && measured.width > 0
          && Number.isFinite(measured.height) && measured.height > 0 ? measured : null;
        // Keep the previously displayed URL alive until React commits the new src.
        pending = null;
        publish({ status: 'ready', code, theme, url: task.url, size, error: null });
      } catch (error) {
        release(task.url);
        if (!current()) return;
        pending = null;
        publish({ status: 'error', code, theme, url: previousUrl, size: previousSize,
          error: error instanceof Error && error.message ? error.message : 'Mermaid 图表渲染失败。' });
      }
    },
    commitDisplayed(url: string | null) {
      if (!url || url !== state.url) return;
      for (const owned of ownedUrls) {
        if (owned !== url && owned !== pending?.url) release(owned);
      }
    },
    clear() {
      cancel();
      for (const url of ownedUrls) release(url);
      publish(INITIAL_MERMAID_PREVIEW);
    },
  };
}
