import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import {
  createSvgObjectUrl,
  renderMermaidSvg,
  revokeSvgObjectUrl,
} from './mermaid-renderer';

export interface MermaidDiagramProps {
  code: string;
}

type RenderState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  url: string | null;
};

const INITIAL_STATE: RenderState = { status: 'idle', error: null, url: null };

export function MermaidDiagram({ code }: MermaidDiagramProps): ReactElement {
  const [attempt, setAttempt] = useState(0);
  const [showSource, setShowSource] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [renderState, setRenderState] = useState<RenderState>(INITIAL_STATE);
  const requestRef = useRef(0);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    let active = true;
    setRenderState({ status: 'loading', error: null, url: null });
    setShowSource(false);
    setZoom(1);

    void renderMermaidSvg(code).then(({ svg }) => {
      if (!active || request !== requestRef.current) return;

      let nextUrl: string;
      try {
        nextUrl = createSvgObjectUrl(svg);
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : '图表预览不可用。';
        setRenderState({ status: 'error', error: message, url: null });
        return;
      }

      if (!active || request !== requestRef.current) {
        revokeSvgObjectUrl(nextUrl);
        return;
      }

      const previousUrl = objectUrlRef.current;
      objectUrlRef.current = nextUrl;
      if (previousUrl) revokeSvgObjectUrl(previousUrl);
      setRenderState({ status: 'ready', error: null, url: nextUrl });
    }).catch((error: unknown) => {
      if (!active || request !== requestRef.current) return;
      const message = error instanceof Error && error.message ? error.message : 'Mermaid 图表渲染失败。';
      setRenderState({ status: 'error', error: message, url: null });
    });

    return () => {
      active = false;
      if (request !== requestRef.current) return;
      const url = objectUrlRef.current;
      objectUrlRef.current = null;
      if (url) revokeSvgObjectUrl(url);
    };
  }, [attempt, code]);

  const retry = () => setAttempt((value) => value + 1);
  const decreaseZoom = () => setZoom((value) => Math.max(.5, Number((value - .25).toFixed(2))));
  const increaseZoom = () => setZoom((value) => Math.min(3, Number((value + .25).toFixed(2))));
  const resetZoom = () => setZoom(1);

  return (
    <section className="mermaid-diagram" aria-label="Mermaid 图表">
      <div className="mermaid-diagram-toolbar">
        <span className="mermaid-diagram-label">图表</span>
        <div className="mermaid-diagram-actions">
          {renderState.status === 'ready' && !showSource ? (
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

      {showSource ? (
        <pre className="mermaid-diagram-source"><code>{code}</code></pre>
      ) : renderState.status === 'ready' && renderState.url ? (
        <div className="mermaid-diagram-viewport">
          <div className="mermaid-diagram-scale" style={{ zoom } as CSSProperties}>
            <img
              className="mermaid-diagram-image"
              src={renderState.url}
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
