export const MERMAID_MAX_TEXT_SIZE = 20_000;
export const MERMAID_MAX_EDGES = 1_000;

export interface MermaidRenderApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, code: string, container?: Element): Promise<{ svg: string; bindFunctions?: unknown }>;
}

export interface MermaidRenderOptions {
  api?: MermaidRenderApi;
  id?: string;
}

export interface MermaidRenderResult {
  id: string;
  code: string;
  svg: string;
}

export interface SvgObjectUrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export class MermaidRenderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MermaidRenderError';
    this.code = code;
  }
}

const FRONTMATTER_PATTERN = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const CONFIG_DIRECTIVE_PATTERN = /^\s*%%\s*(?:\{\s*(?:init|initialize|config)\s*:[\s\S]*?\}\s*%%|(?:init|initialize)\b[^\r\n]*)\s*(?:\r?\n|$)/gim;
const SVG_TAG_PATTERN = /<\s*[a-z][\w:-]*(?:\s[^<>]*?)?>/gis;
const UNSAFE_SVG_TAG_PATTERN = /<\s*script\b/i;
const UNSAFE_SVG_ATTRIBUTE_PATTERN = /\s+on[a-z][\w-]*\s*=|(?:href|xlink:href)\s*=\s*["']\s*(?:javascript:|data:text\/html)/i;
const SVG_ROOT_PATTERN = /<\s*svg\b[^<>]*>/i;
const SVG_VIEWBOX_PATTERN = /\bviewBox\s*=\s*(["'])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*[,\s]+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*[,\s]+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*[,\s]+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*\1/i;
const SVG_DIMENSION_ATTRIBUTE_PATTERN = /\s+(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi;
const SVG_STYLE_ATTRIBUTE_PATTERN = /(\s+style\s*=\s*)(["'])([\s\S]*?)\2/i;
const MAX_SVG_INTRINSIC_DIMENSION = 50_000;

let mermaidModulePromise: Promise<MermaidRenderApi> | null = null;
let renderSequence = 0;
let renderQueue: Promise<void> = Promise.resolve();
const configuredApis = new WeakSet<object>();

export type MermaidModuleLoader = () => Promise<MermaidRenderApi>;

const defaultMermaidModuleLoader: MermaidModuleLoader = () => import('mermaid').then((module) => {
  const api = (module.default ?? module) as unknown as MermaidRenderApi;
  if (!api || typeof api.initialize !== 'function' || typeof api.render !== 'function') {
    throw new MermaidRenderError('MERMAID_API_INVALID', 'Mermaid 渲染器接口不可用。');
  }
  return api;
});
let mermaidModuleLoader: MermaidModuleLoader = defaultMermaidModuleLoader;

/**
 * Remove author-supplied configuration before Mermaid parses the definition.
 * Site-owned security and resource limits are applied in initialize instead.
 */
export function sanitizeMermaidCode(source: string): string {
  if (typeof source !== 'string') {
    throw new MermaidRenderError('MERMAID_SOURCE_INVALID', 'Mermaid 图表内容无效。');
  }

  let code = source.replace(FRONTMATTER_PATTERN, '');
  code = code.replace(CONFIG_DIRECTIVE_PATTERN, '');
  code = code.trim();

  if (!code) {
    throw new MermaidRenderError('MERMAID_SOURCE_EMPTY', 'Mermaid 图表内容为空。');
  }
  if (code.length > MERMAID_MAX_TEXT_SIZE) {
    throw new MermaidRenderError('MERMAID_SOURCE_TOO_LARGE', `Mermaid 图表超过 ${MERMAID_MAX_TEXT_SIZE} 个字符。`);
  }
  return code;
}

function mermaidConfiguration(): Record<string, unknown> {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'dark',
    htmlLabels: false,
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    maxTextSize: MERMAID_MAX_TEXT_SIZE,
    maxEdges: MERMAID_MAX_EDGES,
    suppressErrorRendering: true,
    secure: ['securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'secure'],
    flowchart: { htmlLabels: false, useMaxWidth: false },
    sequence: { useMaxWidth: false },
  };
}

async function loadMermaid(): Promise<MermaidRenderApi> {
  if (!mermaidModulePromise) {
    mermaidModulePromise = mermaidModuleLoader().catch((error: unknown) => {
      // A failed dynamic import must not poison a later retry forever.
      mermaidModulePromise = null;
      throw error;
    });
  }
  return mermaidModulePromise;
}

/** Test-only injection point for exercising dynamic-import failure and retry. */
export function setMermaidModuleLoaderForTests(loader: MermaidModuleLoader | null): void {
  mermaidModuleLoader = loader ?? defaultMermaidModuleLoader;
  mermaidModulePromise = null;
}

function initializeMermaid(api: MermaidRenderApi): void {
  if (configuredApis.has(api as object)) return;
  api.initialize(mermaidConfiguration());
  configuredApis.add(api as object);
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(task, task);
  renderQueue = run.then(() => undefined, () => undefined);
  return run;
}

function nextRenderId(): string {
  renderSequence += 1;
  return `living-memory-mermaid-${renderSequence}`;
}

function normalizedSvgDimensions(viewBox: string): { width: number; height: number } | null {
  const match = SVG_VIEWBOX_PATTERN.exec(viewBox);
  if (!match) return null;

  const width = Number(match[4]);
  const height = Number(match[5]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  // Keep a malformed or unexpectedly huge viewBox from becoming an enormous image. The
  // aspect ratio is preserved when the bounds need to be reduced.
  const scale = Math.min(1, MAX_SVG_INTRINSIC_DIMENSION / width, MAX_SVG_INTRINSIC_DIMENSION / height);
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;
  if (!Number.isFinite(scaledWidth) || !Number.isFinite(scaledHeight) || scaledWidth <= 0 || scaledHeight <= 0) {
    return null;
  }
  return { width: scaledWidth, height: scaledHeight };
}

function formatSvgDimension(value: number): string {
  // A bounded precision keeps a long decimal viewBox from producing a noisy root tag.
  const rounded = Math.round(value * 1000) / 1000;
  return String(Math.max(0.001, rounded));
}

function removeRootSizeStyles(rootTag: string): string {
  const styleMatch = rootTag.match(SVG_STYLE_ATTRIBUTE_PATTERN);
  if (!styleMatch) return rootTag;

  const style = styleMatch[3]
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      const separator = declaration.indexOf(':');
      if (separator < 0) return declaration.length > 0;
      const property = declaration.slice(0, separator).trim().toLowerCase();
      return property !== 'width'
        && property !== 'height'
        && property !== 'max-width'
        && property !== 'max-height';
    })
    .join('; ');

  if (!style) return rootTag.replace(styleMatch[0], '');
  return rootTag.replace(styleMatch[0], `${styleMatch[1]}${styleMatch[2]}${style}${styleMatch[2]}`);
}

/**
 * Mermaid's responsive renderers often emit width="100%" and a max-width style even
 * when the SVG has a useful viewBox. An SVG stored in a Blob and used by an img has no
 * surrounding layout width to resolve those values, so expose bounded pixel dimensions
 * derived from the viewBox. Invalid or absent viewBoxes are left untouched.
 */
export function normalizeSvgDimensions(svg: string): string {
  const rootMatch = SVG_ROOT_PATTERN.exec(svg);
  if (!rootMatch) return svg;

  const dimensions = normalizedSvgDimensions(rootMatch[0]);
  if (!dimensions) return svg;

  let rootTag = rootMatch[0].replace(SVG_DIMENSION_ATTRIBUTE_PATTERN, '');
  rootTag = removeRootSizeStyles(rootTag);
  const dimensionsText = ` width="${formatSvgDimension(dimensions.width)}" height="${formatSvgDimension(dimensions.height)}"`;
  const beforeSelfClosing = rootTag;
  rootTag = rootTag.replace(/\s*\/>$/, `${dimensionsText} />`);
  if (rootTag === beforeSelfClosing) {
    rootTag = rootTag.replace(/>$/, `${dimensionsText}>`);
  }

  return `${svg.slice(0, rootMatch.index)}${rootTag}${svg.slice(rootMatch.index + rootMatch[0].length)}`;
}

function validateSvg(svg: string): string {
  if (!svg || UNSAFE_SVG_TAG_PATTERN.test(svg)) {
    throw new MermaidRenderError('MERMAID_SVG_UNSAFE', 'Mermaid 图表输出未通过安全检查。');
  }
  for (const match of svg.matchAll(SVG_TAG_PATTERN)) {
    if (UNSAFE_SVG_ATTRIBUTE_PATTERN.test(match[0])) {
      throw new MermaidRenderError('MERMAID_SVG_UNSAFE', 'Mermaid 图表输出未通过安全检查。');
    }
  }
  return normalizeSvgDimensions(svg);
}

type RenderContainer = {
  element?: Element;
  cleanup: () => void;
};

function createRenderContainer(id: string): RenderContainer {
  const documentApi = globalThis.document;
  if (!documentApi?.body) return { cleanup: () => undefined };

  try {
    const element = documentApi.createElement('div');
    element.id = `${id}-render-container`;
    element.setAttribute('aria-hidden', 'true');
    Object.assign(element.style, {
      height: '1px',
      left: '-100000px',
      overflow: 'hidden',
      pointerEvents: 'none',
      position: 'fixed',
      top: '0',
      width: '1px',
    });
    documentApi.body.appendChild(element);
    let cleaned = false;
    return {
      element,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        element.parentNode?.removeChild(element);
      },
    };
  } catch {
    return { cleanup: () => undefined };
  }
}

/** Render through a shared queue because Mermaid keeps mutable global config. */
export async function renderMermaidSvg(
  source: string,
  options: MermaidRenderOptions = {},
): Promise<MermaidRenderResult> {
  const code = sanitizeMermaidCode(source);
  return enqueue(async () => {
    const api = options.api ?? await loadMermaid();
    initializeMermaid(api);
    const id = options.id ?? nextRenderId();
    const container = createRenderContainer(id);
    let result: { svg: string; bindFunctions?: unknown };
    try {
      result = await api.render(id, code, container.element);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : 'Mermaid 图表解析失败。';
      throw new MermaidRenderError('MERMAID_RENDER_FAILED', message);
    } finally {
      container.cleanup();
    }
    if (!result || typeof result.svg !== 'string') {
      throw new MermaidRenderError('MERMAID_RENDER_FAILED', 'Mermaid 未返回 SVG 图表。');
    }
    return { id, code, svg: validateSvg(result.svg) };
  });
}

function defaultSvgObjectUrlApi(): SvgObjectUrlApi {
  const urlApi = globalThis.URL;
  if (!urlApi || typeof urlApi.createObjectURL !== 'function' || typeof urlApi.revokeObjectURL !== 'function') {
    throw new MermaidRenderError('MERMAID_OBJECT_URL_UNAVAILABLE', '当前环境不支持图表预览。');
  }
  return urlApi;
}

export function createSvgObjectUrl(svg: string, urlApi?: SvgObjectUrlApi): string {
  const api = urlApi ?? defaultSvgObjectUrlApi();
  return api.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
}

export function revokeSvgObjectUrl(url: string, urlApi?: SvgObjectUrlApi): void {
  if (!url) return;
  try {
    (urlApi ?? defaultSvgObjectUrlApi()).revokeObjectURL(url);
  } catch {
    // Cleanup must not turn an unmount into a visible rendering error.
  }
}
