import { Component, lazy, Suspense, type ReactNode } from 'react';
import type { MarkdownMediaSource } from './markdown-media';

const MarkdownContent = lazy(() => import('./MarkdownContent').then((module) => ({ default: module.MarkdownContent })));

class MarkdownFallback extends Component<{ content: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="markdown-fallback">
      <p role="alert">排版组件暂时不可用，先显示原文。</p>
      <pre>{this.props.content}</pre>
    </div>;
    return this.props.children;
  }
}

/** Load the Markdown/math parser only when someone opens knowledge material. */
export function MarkdownView({ content, compact = false, source }: { content: string; compact?: boolean; source?: MarkdownMediaSource }) {
  return <MarkdownFallback content={content}><Suspense fallback={<p className="markdown-loading" role="status">正在排版资料…</p>}>
    <MarkdownContent content={content} compact={compact} source={source} />
  </Suspense></MarkdownFallback>;
}
