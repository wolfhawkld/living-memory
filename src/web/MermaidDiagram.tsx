import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react';
import { createMermaidPreview, INITIAL_MERMAID_PREVIEW } from './mermaid-preview';
import { useTheme } from './ThemeProvider';

export interface MermaidDiagramProps {
  code: string;
}

export function MermaidDiagram({ code }: MermaidDiagramProps): ReactElement {
  // New source content resets reading controls. Theme changes keep this instance.
  return <MermaidDiagramContent key={code} code={code} />;
}

function MermaidDiagramContent({ code }: MermaidDiagramProps): ReactElement {
  const { resolvedTheme } = useTheme();
  const [attempt, setAttempt] = useState(0);
  const [showSource, setShowSource] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [preview] = useState(createMermaidPreview);
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef({ left: 0, top: 0 });
  const subscribe = useCallback((listener: () => void) => preview.subscribe(() => {
    // Capture the current reading position before the replacement src is committed.
    const viewport = viewportRef.current;
    if (viewport) scrollRef.current = { left: viewport.scrollLeft, top: viewport.scrollTop };
    listener();
  }), [preview]);
  const renderState = useSyncExternalStore(subscribe, preview.getSnapshot, () => INITIAL_MERMAID_PREVIEW);

  useEffect(() => {
    void preview.load(code, resolvedTheme);
  }, [attempt, code, resolvedTheme, preview]);

  useEffect(() => () => preview.clear(), [preview]);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollLeft = scrollRef.current.left;
      viewport.scrollTop = scrollRef.current.top;
    }
    preview.commitDisplayed(renderState.url);
  }, [preview, renderState.url, showSource]);

  const retry = () => setAttempt((value) => value + 1);
  const decreaseZoom = () => setZoom((value) => Math.max(.5, Number((value - .25).toFixed(2))));
  const increaseZoom = () => setZoom((value) => Math.min(3, Number((value + .25).toFixed(2))));
  const resetZoom = () => setZoom(1);

  return (
    <section className="mermaid-diagram" aria-label="Mermaid 图表" aria-busy={renderState.status === 'loading'}>
      <div className="mermaid-diagram-toolbar">
        <span className="mermaid-diagram-label">图表</span>
        <div className="mermaid-diagram-actions">
          {renderState.url && !showSource ? (
            <div className="mermaid-diagram-zoom" aria-label="图表缩放">
              <button type="button" onClick={decreaseZoom} disabled={zoom <= .5} aria-label="缩小图表">−</button>
              <span aria-live="polite">{Math.round(zoom * 100)}%</span>
              <button type="button" onClick={increaseZoom} disabled={zoom >= 3} aria-label="放大图表">+</button>
              <button type="button" onClick={resetZoom} disabled={zoom === 1}>重置</button>
            </div>
          ) : null}
          {renderState.status === 'error' ? (
            <button type="button" onClick={retry}>重试</button>
          ) : null}
          <button type="button" onClick={() => setShowSource((value) => !value)} aria-pressed={showSource}>
            {showSource ? '显示图形' : '显示原代码'}
          </button>
        </div>
      </div>

      {renderState.status === 'loading' && renderState.url && !showSource ? (
        <span className="mermaid-diagram-update-status" role="status">更新配色中…</span>
      ) : null}

      {renderState.status === 'error' && renderState.url ? (
        <div className="mermaid-diagram-error" role="alert">
          <strong>配色更新失败，暂时保留上一次图表</strong><span>{renderState.error}</span>
        </div>
      ) : null}
      {showSource ? (
        <pre className="mermaid-diagram-source"><code>{code}</code></pre>
      ) : renderState.url ? (
        <div className="mermaid-diagram-viewport" ref={viewportRef} onScroll={(event) => {
          scrollRef.current = { left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
        }}>
          <div className="mermaid-diagram-scale" style={{ zoom } as CSSProperties}>
            <img
              className="mermaid-diagram-image"
              src={renderState.url}
              style={renderState.size ? { width: renderState.size.width, height: renderState.size.height } : undefined}
              alt="Mermaid 图表"
            />
          </div>
        </div>
      ) : renderState.status === 'error' ? (
        <div className="mermaid-diagram-error" role="alert">
          <strong>图表暂时无法渲染</strong>
          <span>{renderState.error}</span>
          <small>可以切换到原代码查看 Mermaid 定义。</small>
        </div>
      ) : (
        <div className="mermaid-diagram-loading" role="status">正在渲染图表…</div>
      )}
    </section>
  );
}
