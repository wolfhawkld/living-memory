import { useState } from 'react';
import { markdownImageUrl, type MarkdownMediaSource } from './markdown-media';

export interface MarkdownImageProps {
  src?: string;
  alt?: string;
  title?: string;
  width?: string | number;
  height?: string | number;
  source?: MarkdownMediaSource;
}

export function MarkdownImage({ src, alt, title, width, height, source }: MarkdownImageProps) {
  const url = markdownImageUrl(src, source);
  const label = alt?.trim() || '知识图片';
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [natural, setNatural] = useState(false);
  if (!url) return <span className="markdown-content-image-placeholder" role="img" aria-label={`图片：${label}`}>
    图片：{label}（图片链接不可用）
  </span>;
  const failed = failedUrl === url;
  return <span className={`markdown-image${natural ? ' is-natural' : ''}`}>
    {failed ? <span className="markdown-image-error" role="status">无法加载图片：{label}
      <button type="button" onClick={() => { setFailedUrl(null); setRetry((value) => value + 1); }}>重试图片</button>
    </span> : <span className="markdown-image-scroll">
      <button type="button" className="markdown-image-toggle" aria-pressed={natural}
        aria-label={`${natural ? '适应宽度' : '原始尺寸查看'}：${label}`} onClick={() => setNatural((value) => !value)}>
        <img key={`${url}:${retry}`} src={url} alt={label} title={title} width={natural ? undefined : width} height={natural ? undefined : height}
          loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailedUrl(url)} />
      </button>
    </span>}
    <span className="markdown-image-caption">{label}{!failed ? ` · 点击${natural ? '适应宽度' : '查看原始尺寸'}` : ''}</span>
  </span>;
}
