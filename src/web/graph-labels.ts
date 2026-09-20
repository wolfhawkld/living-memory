import * as THREE from 'three';
import { graphNodePosition } from './graph-position';

/** A graph node shape accepted by the screen-label layer. */
export interface GraphLabelNode {
  id: string;
  title: string;
  aliases?: readonly string[];
  x?: number;
  y?: number;
  z?: number;
}

export type GraphLabelKind = 'selected' | 'hovered' | 'neighbor' | 'context';

export interface GraphLabelUpdate {
  nodes: readonly GraphLabelNode[];
  camera: THREE.Camera;
  width: number;
  height: number;
  selectedId?: string | null;
  hoveredId?: string | null;
  neighborIds?: Iterable<string>;
  twoDimensional?: boolean;
}

export interface GraphLabelLayer {
  update: (state: GraphLabelUpdate) => void;
  dispose: () => void;
}

export const MAX_VISIBLE_GRAPH_LABELS = 12;
export const GRAPH_LABEL_FRAME_MS = 1000 / 30;

const LABEL_GAP_PX = 6;
const REGULAR_LABEL_MAX_WIDTH = 168;
const SELECTED_LABEL_MAX_WIDTH = 220;
const LABEL_LINE_HEIGHT = 16;
const LABEL_HORIZONTAL_PADDING = 14; // 6px padding + 1px border on each side
const LABEL_VERTICAL_PADDING = 8;
const MIN_LABEL_WIDTH = 40;
const LABEL_FONT_FAMILY = 'Inter, "Microsoft YaHei", "PingFang SC", sans-serif';

const CJK_CHARACTER = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const ENGLISH_EXPLANATION = /^[A-Za-z][A-Za-z0-9 &'’+./,_-]*$/u;

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function hasChinese(value: string): boolean {
  return CJK_CHARACTER.test(value);
}

/**
 * Returns the Chinese part of a title such as `主成分分析（PCA）`.
 * Parentheses are only removed when their contents look like an English
 * explanation, so mathematical and otherwise meaningful parentheses remain.
 */
export function chineseMainName(title: string): string | null {
  const normalized = cleanText(title);
  const match = normalized.match(/^(.*?)\s*[（(]\s*([^（）()]*)\s*[）)]\s*$/u);
  if (!match || !hasChinese(match[1]) || !ENGLISH_EXPLANATION.test(match[2].trim())) return null;
  return cleanText(match[1]) || null;
}

/** Estimate rendered width without touching the DOM or forcing layout. */
export function estimateGraphLabelWidth(text: string, fontSize = 11): number {
  const value = cleanText(text);
  const scale = fontSize / 11;
  let width = 0;
  for (const character of Array.from(value)) {
    if (/\s/u.test(character)) width += 3.5 * scale;
    else if (CJK_CHARACTER.test(character)) width += 11 * scale;
    else if (/[A-Z]/u.test(character)) width += 7.3 * scale;
    else if (/[ilI.,'`]/u.test(character)) width += 3.5 * scale;
    else width += 6.3 * scale;
  }
  return width;
}

function isUsefulAlias(alias: string, title: string): boolean {
  const normalized = cleanText(alias);
  if (!normalized || normalized === title) return false;
  if (Array.from(normalized).length > 24) return false;
  return estimateGraphLabelWidth(normalized) <= 140;
}

/**
 * Pick the compact text used by ordinary labels.
 *
 * The function intentionally only picks aliases that already exist on the
 * node. It never invents an abbreviation. Selected and hovered labels use the
 * full title in `createGraphLabels`; this helper is for the quiet graph view.
 */
export function shortGraphLabel(node: Pick<GraphLabelNode, 'title' | 'aliases'>): string {
  const title = cleanText(node.title);
  const chineseName = chineseMainName(title);
  if (chineseName) return chineseName;

  const aliases = (node.aliases ?? [])
    .map(cleanText)
    .filter((alias, index, values) => values.indexOf(alias) === index)
    .filter((alias) => isUsefulAlias(alias, title));
  if (aliases.length === 0) return title;

  const titleWidth = estimateGraphLabelWidth(title);
  const [shortest] = aliases
    .map((alias, index) => ({ alias, index, width: estimateGraphLabelWidth(alias) }))
    .sort((left, right) => left.width - right.width || left.index - right.index);
  // An alias should earn its place by being shorter than the title. This keeps
  // a short Chinese title from unexpectedly becoming a longer English label.
  if (shortest && (titleWidth === 0 || shortest.width + 4 < titleWidth)) return shortest.alias;
  return title;
}

export interface LabelSize {
  width: number;
  height: number;
  lines: number;
}

/** Compute stable screen geometry for collision checks, without DOM measurement. */
export function estimateGraphLabelSize(text: string, emphasized = false, measuredWidth?: number): LabelSize {
  const fontSize = emphasized ? 12 : 11;
  const maxWidth = emphasized ? SELECTED_LABEL_MAX_WIDTH : REGULAR_LABEL_MAX_WIDTH;
  const measured = measuredWidth ?? estimateGraphLabelWidth(text, fontSize);
  const width = Math.min(maxWidth, Math.max(MIN_LABEL_WIDTH, Math.ceil(measured + LABEL_HORIZONTAL_PADDING)));
  // Wrapped full titles reserve three lines so whole-word wrapping cannot crop
  // early. Short names stay compact; measuring uses a canvas, never DOM reflow.
  const lines = emphasized && measured > width - LABEL_HORIZONTAL_PADDING ? 3 : 1;
  return {
    width,
    // Include the 1px top and bottom borders from styleLabel in the collision
    // geometry and in the explicit element height.
    height: LABEL_VERTICAL_PADDING + lines * LABEL_LINE_HEIGHT + 2,
    lines,
  };
}

export interface LabelCandidate {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  priority?: number;
  kind?: GraphLabelKind;
  depth?: number;
}

export interface LabelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LabelPlacement extends LabelCandidate {
  left: number;
  top: number;
  candidateIndex: number;
}

function right(rect: LabelRect): number {
  return rect.left + rect.width;
}

function bottom(rect: LabelRect): number {
  return rect.top + rect.height;
}

/** True when two rectangles overlap, including the requested breathing room. */
export function labelRectsOverlap(left: LabelRect, rightRect: LabelRect, gap = 0): boolean {
  if (gap < 0) gap = 0;
  return left.left < right(rightRect) + gap
    && right(left) + gap > rightRect.left
    && left.top < bottom(rightRect) + gap
    && bottom(left) + gap > rightRect.top;
}

function candidateOffsets(width: number, height: number): Array<{ dx: number; dy: number }> {
  return [
    { dx: 8, dy: -height - 8 },
    { dx: 8, dy: 8 },
    { dx: -width - 8, dy: -height - 8 },
    { dx: -width - 8, dy: 8 },
    { dx: 8, dy: -height / 2 },
    { dx: -width - 8, dy: -height / 2 },
    { dx: -width / 2, dy: -height - 8 },
    { dx: -width / 2, dy: 8 },
    { dx: -width / 2, dy: -height / 2 },
  ];
}

function fitsWithin(rect: LabelRect, width: number, height: number): boolean {
  return rect.left >= 0 && rect.top >= 0 && right(rect) <= width && bottom(rect) <= height;
}

/**
 * Place screen-label candidates in priority order using a small set of anchor
 * positions. A candidate is omitted when no in-bounds, non-overlapping spot is
 * available; this is what keeps an overview from turning into a wall of text.
 */
export function placeLabelCandidates(
  candidates: readonly LabelCandidate[],
  width: number,
  height: number,
  maxLabels = MAX_VISIBLE_GRAPH_LABELS,
): LabelPlacement[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || maxLabels <= 0) return [];
  const ordered = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => (
      Number.isFinite(candidate.x)
      && Number.isFinite(candidate.y)
      && Number.isFinite(candidate.width)
      && Number.isFinite(candidate.height)
      && candidate.width > 0
      && candidate.height > 0
    ))
    .sort((left, rightItem) => (
      (rightItem.candidate.priority ?? 0) - (left.candidate.priority ?? 0)
      || (left.candidate.depth ?? Number.POSITIVE_INFINITY) - (rightItem.candidate.depth ?? Number.POSITIVE_INFINITY)
      || left.index - rightItem.index
    ));
  const placements: LabelPlacement[] = [];

  for (const { candidate } of ordered) {
    if (placements.length >= maxLabels) break;
    for (const [candidateIndex, offset] of candidateOffsets(candidate.width, candidate.height).entries()) {
      const rect: LabelRect = {
        left: candidate.x + offset.dx,
        top: candidate.y + offset.dy,
        width: candidate.width,
        height: candidate.height,
      };
      if (!fitsWithin(rect, width, height)) continue;
      if (placements.some((placed) => labelRectsOverlap(rect, placed, LABEL_GAP_PX))) continue;
      placements.push({ ...candidate, left: rect.left, top: rect.top, candidateIndex });
      break;
    }
  }
  return placements;
}

export interface ProjectedGraphLabelPoint {
  x: number;
  y: number;
  depth: number;
}

/** Project a graph coordinate into layer pixels, rejecting behind/off-screen points. */
export function projectGraphLabelPoint(
  node: Pick<GraphLabelNode, 'x' | 'y' | 'z'>,
  camera: THREE.Camera,
  width: number,
  height: number,
  twoDimensional = false,
): ProjectedGraphLabelPoint | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const position = graphNodePosition(node, twoDimensional);
  if (!position) return null;
  const world = new THREE.Vector3(position.x, position.y, position.z);
  const cameraSpace = world.clone().applyMatrix4(camera.matrixWorldInverse);
  if (!Number.isFinite(cameraSpace.z) || cameraSpace.z >= 0) return null;
  const ndc = world.project(camera);
  if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y) || !Number.isFinite(ndc.z)) return null;
  if (ndc.z < -1 || ndc.z > 1) return null;
  const x = (ndc.x + 1) * 0.5 * width;
  const y = (1 - ndc.y) * 0.5 * height;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > width || y < 0 || y > height) return null;
  return { x, y, depth: -cameraSpace.z };
}

interface LabelEntry {
  element: HTMLDivElement;
  node: GraphLabelNode;
  fullTitle: string;
  shortTitle: string;
  sizeCache: Map<string, LabelSize>;
  lastDisplayText: string;
  styleSignature: string;
}

interface RenderCandidate extends LabelCandidate {
  entry: LabelEntry;
  emphasized: boolean;
  hovered: boolean;
}

function normalizeNeighborIds(value: Iterable<string> | undefined): Set<string> {
  if (!value) return new Set();
  const result = new Set<string>();
  for (const id of value) if (typeof id === 'string') result.add(id);
  return result;
}

function labelPriority(kind: GraphLabelKind): number {
  if (kind === 'selected') return 4;
  if (kind === 'hovered') return 3;
  if (kind === 'neighbor') return 2;
  return 1;
}

function styleLayer(layer: HTMLDivElement): void {
  layer.style.position = 'absolute';
  layer.style.inset = '0';
  layer.style.width = '100%';
  layer.style.height = '100%';
  layer.style.pointerEvents = 'none';
  layer.style.overflow = 'hidden';
  layer.style.zIndex = '5';
  layer.dataset.graphLabelLayer = 'true';
}

function styleLabel(entry: LabelEntry, size: LabelSize, kind: GraphLabelKind, hovered: boolean, width: number): void {
  const element = entry.element;
  const emphasized = kind === 'selected' || kind === 'hovered';
  const constrainedWidth = Math.min(size.width, Math.max(MIN_LABEL_WIDTH, width - 4));
  const styleSignature = `${constrainedWidth}:${size.height}:${kind}:${hovered ? 'hovered' : 'steady'}`;
  if (entry.styleSignature === styleSignature) return;
  entry.styleSignature = styleSignature;
  element.className = `graph-label graph-label-${kind}${hovered ? ' graph-label-hovered' : ''}`;
  element.style.position = 'absolute';
  element.style.boxSizing = 'border-box';
  element.style.width = `${constrainedWidth}px`;
  element.style.maxWidth = `${SELECTED_LABEL_MAX_WIDTH}px`;
  element.style.height = `${size.height}px`;
  element.style.padding = '4px 6px';
  element.style.border = emphasized ? '1px solid rgba(132, 211, 255, 0.72)' : '1px solid rgba(132, 167, 211, 0.24)';
  element.style.borderRadius = '4px';
  element.style.background = emphasized ? 'rgba(5, 15, 31, 0.9)' : 'rgba(7, 14, 27, 0.76)';
  element.style.boxShadow = emphasized ? '0 3px 14px rgba(0, 0, 0, 0.28)' : '0 2px 8px rgba(0, 0, 0, 0.18)';
  element.style.color = emphasized ? '#edf7ff' : '#cfddf2';
  element.style.fontFamily = LABEL_FONT_FAMILY;
  element.style.fontSize = emphasized ? '12px' : '11px';
  element.style.fontWeight = emphasized ? '600' : '500';
  element.style.lineHeight = `${LABEL_LINE_HEIGHT}px`;
  element.style.overflow = 'hidden';
  element.style.pointerEvents = 'none';
  element.style.textOverflow = emphasized ? 'clip' : 'ellipsis';
  element.style.whiteSpace = emphasized ? 'normal' : 'nowrap';
  element.style.wordBreak = 'break-word';
  if (emphasized) {
    element.style.display = '-webkit-box';
    element.style.webkitBoxOrient = 'vertical';
    element.style.webkitLineClamp = '3';
  } else {
    element.style.display = 'block';
    element.style.webkitBoxOrient = '';
    element.style.webkitLineClamp = '';
  }
  element.style.zIndex = kind === 'selected' ? '3' : kind === 'hovered' ? '2' : '1';
}

function hideLabel(entry: LabelEntry): void {
  entry.element.style.display = 'none';
  entry.element.dataset.visible = 'false';
}

function setLabelVisible(entry: LabelEntry, placement: LabelPlacement): void {
  entry.element.style.left = `${Math.round(placement.left)}px`;
  entry.element.style.top = `${Math.round(placement.top)}px`;
  const emphasized = placement.kind === 'selected' || placement.kind === 'hovered';
  // styleLabel uses -webkit-box for the three-line clamp. Restoring `block`
  // here would silently disable the clamp every time a label became visible.
  entry.element.style.display = emphasized ? '-webkit-box' : 'block';
  entry.element.dataset.visible = 'true';
  entry.element.dataset.candidateIndex = String(placement.candidateIndex);
}

function createEntry(documentRef: Document, node: GraphLabelNode): LabelEntry {
  const element = documentRef.createElement('div');
  const fullTitle = cleanText(node.title) || shortGraphLabel(node) || node.id;
  const shortTitle = shortGraphLabel(node) || fullTitle;
  element.dataset.conceptId = node.id;
  element.dataset.fullTitle = fullTitle;
  element.dataset.kind = 'context';
  element.setAttribute('aria-label', fullTitle);
  element.title = fullTitle;
  element.textContent = shortTitle;
  const entry: LabelEntry = {
    element,
    node,
    fullTitle,
    shortTitle,
    sizeCache: new Map(),
    lastDisplayText: shortTitle,
    styleSignature: '',
  };
  hideLabel(entry);
  return entry;
}

function getEntrySize(entry: LabelEntry, text: string, emphasized: boolean, context: CanvasRenderingContext2D | null): LabelSize {
  const key = `${emphasized ? 'emphasis' : 'regular'}:${text}`;
  const cached = entry.sizeCache.get(key);
  if (cached) return cached;
  if (context) context.font = `${emphasized ? 600 : 500} ${emphasized ? 12 : 11}px ${LABEL_FONT_FAMILY}`;
  const size = estimateGraphLabelSize(text, emphasized, context?.measureText(text).width);
  entry.sizeCache.set(key, size);
  return size;
}

function updateEntryText(entry: LabelEntry, node: GraphLabelNode, emphasized: boolean): string {
  const fullTitle = cleanText(node.title) || shortGraphLabel(node) || node.id;
  const shortTitle = shortGraphLabel(node) || fullTitle;
  if (entry.fullTitle !== fullTitle || entry.shortTitle !== shortTitle) entry.sizeCache.clear();
  entry.node = node;
  entry.fullTitle = fullTitle;
  entry.shortTitle = shortTitle;
  const displayText = emphasized ? fullTitle : shortTitle;
  if (entry.lastDisplayText !== displayText) {
    entry.element.textContent = displayText;
    entry.lastDisplayText = displayText;
  }
  entry.element.dataset.fullTitle = fullTitle;
  entry.element.setAttribute('aria-label', fullTitle);
  entry.element.title = fullTitle;
  return displayText;
}

/**
 * Create an absolutely positioned, screen-space label layer for a Three.js
 * graph. Updates are coalesced and rendered at no more than 30 frames/second.
 */
export function createGraphLabels(host: HTMLElement): GraphLabelLayer {
  const documentRef = host.ownerDocument ?? document;
  const layer = documentRef.createElement('div');
  styleLayer(layer);
  host.appendChild(layer);
  const measureContext = documentRef.createElement('canvas').getContext('2d');

  const entries = new Map<string, LabelEntry>();
  let disposed = false;
  let pending: GraphLabelUpdate | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRenderAt = Number.NEGATIVE_INFINITY;

  const now = (): number => (
    typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
  );

  const render = (state: GraphLabelUpdate): void => {
    if (disposed) return;
    const width = Math.max(0, Number.isFinite(state.width) ? state.width : 0);
    const height = Math.max(0, Number.isFinite(state.height) ? state.height : 0);
    const selectedId = state.selectedId ?? null;
    const hoveredId = state.hoveredId ?? null;
    const neighborIds = normalizeNeighborIds(state.neighborIds);
    const activeIds = new Set<string>();
    const candidates: RenderCandidate[] = [];

    // Force one camera matrix refresh per render, rather than once per node.
    state.camera.updateMatrixWorld();

    for (const node of state.nodes) {
      if (!node || typeof node.id !== 'string' || activeIds.has(node.id)) continue;
      activeIds.add(node.id);
      let entry = entries.get(node.id);
      if (!entry) {
        entry = createEntry(documentRef, node);
        entries.set(node.id, entry);
        layer.appendChild(entry.element);
      }

      const isSelected = node.id === selectedId;
      const isHovered = node.id === hoveredId;
      const isNeighbor = neighborIds.has(node.id);
      const kind: GraphLabelKind = isSelected ? 'selected' : isHovered ? 'hovered' : isNeighbor ? 'neighbor' : 'context';
      const emphasized = kind === 'selected' || kind === 'hovered';
      const displayText = updateEntryText(entry, node, emphasized);
      const projected = projectGraphLabelPoint(node, state.camera, width, height, state.twoDimensional);
      const baseSize = getEntrySize(entry, displayText, emphasized, measureContext);
      const size: LabelSize = {
        ...baseSize,
        width: Math.min(baseSize.width, Math.max(MIN_LABEL_WIDTH, width - 4)),
      };
      styleLabel(entry, size, kind, isHovered, width);
      entry.element.dataset.conceptId = node.id;
      entry.element.dataset.kind = kind;
      entry.element.dataset.priority = String(labelPriority(kind));
      entry.element.dataset.hovered = isHovered ? 'true' : 'false';
      entry.element.dataset.selected = isSelected ? 'true' : 'false';
      hideLabel(entry);
      if (projected) {
        entry.element.dataset.anchorX = projected.x.toFixed(2);
        entry.element.dataset.anchorY = projected.y.toFixed(2);
      } else {
        delete entry.element.dataset.anchorX;
        delete entry.element.dataset.anchorY;
      }
      if (!projected || size.width >= width || size.height >= height) continue;
      candidates.push({
        id: node.id,
        x: projected.x,
        y: projected.y,
        width: size.width,
        height: size.height,
        priority: labelPriority(kind),
        kind,
        depth: projected.depth,
        entry,
        emphasized,
        hovered: isHovered,
      });
    }

    for (const [id, entry] of entries) {
      if (!activeIds.has(id)) {
        entry.element.remove();
        entries.delete(id);
      }
    }

    if (width <= 0 || height <= 0) return;
    const placements = placeLabelCandidates(candidates, width, height, MAX_VISIBLE_GRAPH_LABELS);
    for (const placement of placements) {
      const candidate = candidates.find((item) => item.id === placement.id);
      if (!candidate) continue;
      setLabelVisible(candidate.entry, placement);
    }
  };

  const flush = (): void => {
    timer = null;
    if (disposed || !pending) return;
    const next = pending;
    pending = null;
    lastRenderAt = now();
    render(next);
  };

  const schedule = (): void => {
    if (timer !== null || disposed) return;
    const wait = Math.max(0, GRAPH_LABEL_FRAME_MS - (now() - lastRenderAt));
    timer = setTimeout(flush, wait);
  };

  return {
    update(state: GraphLabelUpdate): void {
      if (disposed) return;
      pending = state;
      const elapsed = now() - lastRenderAt;
      if (lastRenderAt === Number.NEGATIVE_INFINITY || elapsed >= GRAPH_LABEL_FRAME_MS) flush();
      else schedule();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      pending = null;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      entries.clear();
      layer.remove();
    },
  };
}
