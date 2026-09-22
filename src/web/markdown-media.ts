export interface MarkdownMediaSource {
  sourceId: string;
  conceptId: string;
  sourceRevision: string;
}

/** Keep local images inside the source-bound endpoint, never resolve them against the app URL. */
export function markdownImageUrl(value: string | undefined, source?: MarkdownMediaSource): string | null {
  const path = value?.trim();
  if (!path || /[\u0000-\u001f\u007f]/.test(path)) return null;
  if (/^https?:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      return !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(path) || path.startsWith('//') || path.startsWith('\\\\') || path.startsWith('#')) return null;
  if (!source?.sourceId || !source.conceptId || !source.sourceRevision) return null;
  const params = new URLSearchParams({ sourceId: source.sourceId, sourceRevision: source.sourceRevision, path });
  return `/api/concepts/${encodeURIComponent(source.conceptId)}/attachment?${params}`;
}

export function isImageReference(value: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)(?:[?#]|$)/i.test(value);
}
