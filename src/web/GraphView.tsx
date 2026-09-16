import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { Concept, GraphLink, Layout, MemoryState, Snapshot } from '../shared/types';
import { calculateNodeFocus } from './graph-focus';

export interface GraphViewProps {
  snapshot: Snapshot;
  layout: Layout;
  selectedId: string | null;
  simulated: boolean;
  paused?: boolean;
  twoDimensional: boolean;
  glowEnabled?: boolean;
  focusRevision?: number;
  onSelect: (conceptId: string) => void;
  onLayoutChange: (layout: Layout) => void;
}

interface PostProcessingComposer {
  addPass: (pass: UnrealBloomPass | OutputPass) => void;
  removePass: (pass: UnrealBloomPass | OutputPass) => void;
}

interface GraphNode extends Concept {
  state: MemoryState;
  x?: number;
  y?: number;
  z?: number;
  fx?: number;
  fy?: number;
  fz?: number;
  __mesh?: THREE.Group;
}

interface GraphInstance {
  graphData: (data?: { nodes: GraphNode[]; links: GraphLink[] }) => { nodes: GraphNode[]; links: GraphLink[] } | GraphInstance;
  nodeThreeObject: (callback: (node: GraphNode) => THREE.Object3D) => GraphInstance;
  nodeThreeObjectExtend: (value: boolean) => GraphInstance;
  nodeLabel: (callback: (node: GraphNode) => string) => GraphInstance;
  linkLabel: (callback: (link: GraphLink) => string) => GraphInstance;
  linkColor: (callback: (link: GraphLink) => string) => GraphInstance;
  linkOpacity: (value: number) => GraphInstance;
  linkWidth: (value: number | ((link: GraphLink) => number)) => GraphInstance;
  linkDirectionalArrowLength: (value: number | ((link: GraphLink) => number)) => GraphInstance;
  linkDirectionalArrowColor: (value: string | ((link: GraphLink) => string)) => GraphInstance;
  linkDirectionalArrowRelPos: (value: number) => GraphInstance;
  linkHoverPrecision: (value: number) => GraphInstance;
  postProcessingComposer: () => PostProcessingComposer;
  backgroundColor: (value: string) => GraphInstance;
  showNavInfo: (value: boolean) => GraphInstance;
  enableNodeDrag: (value: boolean) => GraphInstance;
  cooldownTicks: (value: number) => GraphInstance;
  cooldownTime: (value: number) => GraphInstance;
  d3AlphaDecay: (value: number) => GraphInstance;
  warmupTicks: (value: number) => GraphInstance;
  numDimensions: (value: 2 | 3) => GraphInstance;
  onNodeClick: (callback: (node: GraphNode) => void) => GraphInstance;
  onNodeDragEnd: (callback: (node: GraphNode) => void) => GraphInstance;
  onEngineStop: (callback: () => void) => GraphInstance;
  scene: () => THREE.Scene;
  cameraPosition: (
    position?: { x: number; y: number; z: number },
    lookAt?: { x: number; y: number; z: number },
    transitionMs?: number,
  ) => { x: number; y: number; z: number } | GraphInstance;
  zoomToFit: (durationMs?: number, padding?: number) => GraphInstance;
  refresh?: () => GraphInstance;
  pauseAnimation?: () => GraphInstance;
  resumeAnimation?: () => GraphInstance;
  d3ReheatSimulation?: () => GraphInstance;
  width: (value: number) => GraphInstance;
  height: (value: number) => GraphInstance;
  _destructor?: () => void;
}

const STATUS_COLORS: Record<MemoryState['status'], string> = {
  unknown: '#7f8da9',
  recent: '#5ce3d0',
  revisit: '#f4bd70',
  stale: '#ff817d',
  pending: '#a4a9b6',
};

// Relationship colors use a cool blue range, separate from the node memory-status
// colors. This keeps the temporal signal on nodes while making graph structure legible.
const LINK_COLOR = '#668caf';
const LINK_MUTED_COLOR = '#2b4563';
const LINK_SELECTED_COLOR = '#b5edff';

const LABEL_WIDTH_PX = 512;
const LABEL_MAX_WIDTH_PX = 456;
const LABEL_FONT = '600 26px "Microsoft YaHei", "PingFang SC", sans-serif';
const LABEL_LINE_HEIGHT_PX = 30;
const LABEL_PADDING_Y_PX = 21;
const LABEL_BASE_HEIGHT_PX = 72;
const LABEL_MAX_LINES = 3;
const LABEL_WORLD_WIDTH = 85;
const LABEL_WORLD_HEIGHT_PER_BASE = 12;

interface LabelLayout {
  texture: THREE.Texture;
  heightPx: number;
}

function hashPosition(id: string): { x: number; y: number; z: number } {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const angle = ((hash >>> 0) % 360) * (Math.PI / 180);
  const radius = 80 + ((hash >>> 8) % 100);
  return {
    x: Math.cos(angle) * radius,
    y: ((((hash >>> 16) % 100) / 100) - 0.5) * 130,
    z: Math.sin(angle) * radius,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    };
    return entities[character] ?? character;
  });
}

function endpointId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return String(value ?? '');
}

function linkSignature(link: GraphLink): string {
  return `${link.id}\u0000${endpointId(link.source)}\u0000${endpointId(link.target)}`;
}

function linksSignature(links: GraphLink[]): string {
  return links.map(linkSignature).sort().join('\u0001');
}

function isIncidentLink(link: GraphLink, conceptId: string | null): boolean {
  if (!conceptId) return false;
  return endpointId(link.source) === conceptId || endpointId(link.target) === conceptId;
}

function selectedLinkCount(links: GraphLink[], conceptId: string | null): number {
  if (!conceptId) return 0;
  return links.reduce((count, link) => count + (isIncidentLink(link, conceptId) ? 1 : 0), 0);
}

function cloneLinks(links: GraphLink[]): GraphLink[] {
  return links.map((link) => ({
    ...link,
    source: endpointId(link.source),
    target: endpointId(link.target),
  }));
}

function glowTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(64, 64, 2, 64, 64, 64);
    // Tint only the material so a later time-state change cannot retain the old hue.
    gradient.addColorStop(0, '#ffffffee');
    gradient.addColorStop(0.16, '#ffffff88');
    gradient.addColorStop(0.48, '#ffffff2e');
    gradient.addColorStop(1, '#ffffff00');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function labelUnits(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.match(/[A-Za-z0-9]+(?:[._/'-][A-Za-z0-9]+)*|./gu) ?? (normalized ? [normalized] : ['']);
}

function fitLabelEllipsis(value: string, measure: (text: string) => number, maxWidth: number): string {
  const ellipsis = '…';
  let result = value.trimEnd();
  while (result && measure(`${result}${ellipsis}`) > maxWidth) {
    result = Array.from(result).slice(0, -1).join('');
  }
  return result ? `${result}${ellipsis}` : ellipsis;
}

function wrapLabelLines(text: string, measure: (text: string) => number, maxWidth = LABEL_MAX_WIDTH_PX): string[] {
  const lines: string[] = [];
  let current = '';
  const pushCurrent = () => {
    const line = current.trim();
    if (line) lines.push(line);
    current = '';
  };

  for (const unit of labelUnits(text)) {
    if (/\s/.test(unit)) {
      if (current && !current.endsWith(' ')) current += ' ';
      continue;
    }
    const candidate = `${current}${unit}`;
    if (measure(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    pushCurrent();
    if (measure(unit) <= maxWidth) {
      current = unit;
      continue;
    }
    for (const character of Array.from(unit)) {
      const characterCandidate = `${current}${character}`;
      if (current && measure(characterCandidate) > maxWidth) pushCurrent();
      current += character;
    }
  }
  pushCurrent();
  return lines.length > 0 ? lines : [''];
}

function createLabelLayout(text: string, color: string): LabelLayout {
  const canvas = document.createElement('canvas');
  canvas.width = LABEL_WIDTH_PX;
  const context = canvas.getContext('2d');
  const measure = (value: string) => context ? context.measureText(value).width : Array.from(value).length * 26;
  if (context) context.font = LABEL_FONT;
  const wrapped = wrapLabelLines(text, measure);
  const truncated = wrapped.length > LABEL_MAX_LINES
    ? [...wrapped.slice(0, LABEL_MAX_LINES - 1), fitLabelEllipsis(wrapped[LABEL_MAX_LINES - 1], measure, LABEL_MAX_WIDTH_PX)]
    : wrapped;
  const heightPx = LABEL_PADDING_Y_PX * 2 + truncated.length * LABEL_LINE_HEIGHT_PX;
  canvas.height = heightPx;
  if (context) {
    context.font = LABEL_FONT;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.shadowColor = '#030810';
    context.shadowBlur = 9;
    context.fillStyle = '#030810';
    for (const [index, line] of truncated.entries()) {
      const y = LABEL_PADDING_Y_PX + LABEL_LINE_HEIGHT_PX * (index + 0.5);
      context.fillText(line, LABEL_WIDTH_PX / 2, y);
    }
    context.shadowBlur = 0;
    context.fillStyle = color === STATUS_COLORS.unknown ? '#a5b4cc' : '#dce9fb';
    for (const [index, line] of truncated.entries()) {
      const y = LABEL_PADDING_Y_PX + LABEL_LINE_HEIGHT_PX * (index + 0.5);
      context.fillText(line, LABEL_WIDTH_PX / 2, y);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return { texture, heightPx };
}

function nodeSize(node: GraphNode): number {
  if (node.state.status === 'stale') return 5.8;
  if (node.state.status === 'revisit') return 5.4;
  if (node.state.status === 'recent') return 5.1;
  return 4.7;
}

function updateNodeVisual(node: GraphNode, glowEnabled = true): void {
  const group = node.__mesh;
  if (!group) return;
  const color = STATUS_COLORS[node.state.status];
  const visual = group.userData.lmVisual as
    | { sphere: THREE.Mesh; halo: THREE.Sprite; ring: THREE.Mesh; label: THREE.Sprite }
    | undefined;
  if (!visual) return;
  const sphereMaterial = visual.sphere.material as THREE.MeshBasicMaterial;
  sphereMaterial.color.set(color);
  sphereMaterial.wireframe = node.state.status === 'unknown';
  sphereMaterial.opacity = node.state.status === 'unknown' ? 0.62 : 0.95;
  sphereMaterial.transparent = node.state.status === 'unknown';
  const ringMaterial = visual.ring.material as THREE.MeshBasicMaterial;
  ringMaterial.color.set(color);
  ringMaterial.opacity = node.state.status === 'unknown' ? 0.58 : 0.22;
  const haloMaterial = visual.halo.material as THREE.SpriteMaterial;
  haloMaterial.color.set(color);
  haloMaterial.opacity = glowEnabled ? (node.state.status === 'unknown' ? 0.24 : 0.58) : 0;
  visual.halo.visible = glowEnabled;
  const size = nodeSize(node);
  visual.sphere.scale.setScalar(size / 5);
  visual.ring.scale.setScalar(size / 5);
  visual.halo.scale.set(size * 5.8, size * 5.8, 1);
  visual.label.position.y = size + 7 + (visual.label.scale.y - LABEL_WORLD_HEIGHT_PER_BASE) / 2;
}

function applyLabelLayout(label: THREE.Sprite, layout: LabelLayout, size: number): void {
  const worldHeight = LABEL_WORLD_HEIGHT_PER_BASE * layout.heightPx / LABEL_BASE_HEIGHT_PX;
  label.scale.set(LABEL_WORLD_WIDTH, worldHeight, 1);
  // Keep the bottom of a multi-line label at the same height as the old one-line label.
  label.position.set(0, size + 7 + (worldHeight - LABEL_WORLD_HEIGHT_PER_BASE) / 2, 0);
}

function updateNodeLabel(node: GraphNode): void {
  const visual = node.__mesh?.userData.lmVisual as
    | { label: THREE.Sprite }
    | undefined;
  if (!visual) return;
  const material = visual.label.material as THREE.SpriteMaterial;
  material.map?.dispose();
  const layout = createLabelLayout(node.title, STATUS_COLORS[node.state.status]);
  material.map = layout.texture;
  material.needsUpdate = true;
  applyLabelLayout(visual.label, layout, nodeSize(node));
}

function buildNodeVisual(node: GraphNode, glowEnabled = true): THREE.Group {
  const color = STATUS_COLORS[node.state.status];
  const size = nodeSize(node);
  const group = new THREE.Group();
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(size, 18, 12),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }),
  );
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(size * 1.28, 0.4, 8, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22 }),
  );
  ring.rotation.x = Math.PI / 2;
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture(),
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  const labelLayout = createLabelLayout(node.title, color);
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelLayout.texture, transparent: true, depthWrite: false, opacity: 0.92 }));
  applyLabelLayout(label, labelLayout, size);
  group.add(halo, ring, sphere, label);
  group.userData.lmVisual = { sphere, halo, ring, label };
  node.__mesh = group;
  updateNodeVisual(node, glowEnabled);
  return group;
}

function canUseWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
  } catch {
    return false;
  }
}

function focusNode(graph: GraphInstance, node: GraphNode, twoDimensional: boolean, transitionMs: number): void {
  const target = { x: node.x ?? 0, y: node.y ?? 0, z: node.z ?? 0 };
  const camera = graph.cameraPosition() as { x: number; y: number; z: number };
  const focus = calculateNodeFocus(camera, target, nodeSize(node), twoDimensional);
  graph.cameraPosition(focus.position, focus.target, transitionMs);
}

export function GraphView({
  snapshot,
  layout,
  selectedId,
  simulated,
  paused = false,
  twoDimensional,
  glowEnabled = true,
  focusRevision = 0,
  onSelect,
  onLayoutChange,
}: GraphViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<GraphInstance | null>(null);
  const bloomPassRef = useRef<UnrealBloomPass | null>(null);
  const outputPassRef = useRef<OutputPass | null>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const layoutTimerRef = useRef<number | null>(null);
  const selectedIdRef = useRef(selectedId);
  const onSelectRef = useRef(onSelect);
  const onLayoutChangeRef = useRef(onLayoutChange);
  const simulatedRef = useRef(simulated);
  const glowEnabledRef = useRef(glowEnabled);
  const pausedRef = useRef(paused);
  const animationPausedRef = useRef(false);
  const dimensionsInitializedRef = useRef(false);
  const graphReadyRef = useRef(false);
  const focusRequestedRef = useRef(false);
  const twoDimensionalRef = useRef(twoDimensional);
  const [graphError, setGraphError] = useState<string | null>(null);

  selectedIdRef.current = selectedId;
  onSelectRef.current = onSelect;
  onLayoutChangeRef.current = onLayoutChange;
  simulatedRef.current = simulated;
  glowEnabledRef.current = glowEnabled;
  twoDimensionalRef.current = twoDimensional;
  pausedRef.current = paused;

  const graphData = useMemo(() => {
    const nodes: GraphNode[] = snapshot.concepts.map((concept) => {
      const state = snapshot.states[concept.id] ?? {
        conceptId: concept.id,
        status: 'unknown' as const,
        decay: null,
        elapsedDays: null,
        anchor: null,
        reason: '尚无个人重温历史',
        asOf: snapshot.asOf,
      };
      const initial = layout[concept.id] ?? hashPosition(concept.id);
      return { ...concept, state, x: initial.x, y: initial.y, z: initial.z };
    });
    return { nodes, links: snapshot.links.map((link) => ({ ...link })) };
  }, [layout, snapshot]);

  const saveLayout = () => {
    if (!graphRef.current || simulatedRef.current || pausedRef.current) return;
    const positions: Layout = {};
    for (const node of nodesRef.current) {
      if (typeof node.x === 'number' && typeof node.y === 'number' && typeof node.z === 'number') {
        positions[node.id] = { x: node.x, y: node.y, z: node.z };
      }
    }
    onLayoutChangeRef.current(positions);
  };

  const scheduleLayoutSave = () => {
    if (!graphRef.current || simulatedRef.current || pausedRef.current) return;
    if (layoutTimerRef.current !== null) window.clearTimeout(layoutTimerRef.current);
    layoutTimerRef.current = window.setTimeout(() => {
      layoutTimerRef.current = null;
      saveLayout();
    }, 900);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    if (!canUseWebGL()) {
      setGraphError('当前浏览器没有可用的 WebGL，将使用文字列表继续工作。');
      return undefined;
    }

    try {
      // Each ForceGraph instance needs its own initialization guard. React development
      // effect replay can construct, destroy, and construct the instance on one fiber.
      dimensionsInitializedRef.current = false;
      graphReadyRef.current = false;
      focusRequestedRef.current = false;
      animationPausedRef.current = false;
      const graph = new ForceGraph3D(host) as unknown as GraphInstance;
      let initialFitDone = false;
      const transitionMs = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 550;
      graphRef.current = graph;
      nodesRef.current = graphData.nodes;
      // A scene background clears in the current render target's color space.
      // Relying only on renderer.clearColor can reuse the prior screen-space
      // clear value when the composer's RenderPass switches to a linear buffer.
      graph.scene().background = new THREE.Color('#070c18');
      graph
        .backgroundColor('#070c18')
        .showNavInfo(false)
        .enableNodeDrag(true)
        .cooldownTicks(150)
        .cooldownTime(2500)
        .warmupTicks(0)
        .d3AlphaDecay(0.045)
        .numDimensions(twoDimensional ? 2 : 3)
        .nodeThreeObject((node) => buildNodeVisual(node, glowEnabledRef.current))
        .nodeThreeObjectExtend(false)
        .nodeLabel((node) => `<strong style="display:inline-block;max-width:280px;white-space:normal;overflow-wrap:anywhere;line-height:1.3">${escapeHtml(node.title)}</strong><br/><span style="display:inline-block;max-width:280px;white-space:normal;overflow-wrap:anywhere;line-height:1.3">${escapeHtml(node.domain)}</span>`)
        .linkLabel((link) => {
          const type = link.type?.trim() || '相关';
          const description = link.description?.trim();
          return `<span style="display:inline-block;max-width:300px;white-space:normal;overflow-wrap:anywhere;line-height:1.35"><strong>关系：${escapeHtml(type)}</strong>${description ? `<br/><span>${escapeHtml(description)}</span>` : ''}</span>`;
        })
        .linkColor((link) => {
          const selected = selectedIdRef.current;
          if (!selected) return LINK_COLOR;
          return isIncidentLink(link, selected) ? LINK_SELECTED_COLOR : LINK_MUTED_COLOR;
        })
        .linkOpacity(0.78)
        .linkWidth((link) => {
          const selected = selectedIdRef.current;
          if (!selected) return 1.35;
          return isIncidentLink(link, selected) ? 2.8 : 0.95;
        })
        .linkDirectionalArrowLength((link) => {
          const selected = selectedIdRef.current;
          if (!selected) return 4.2;
          return isIncidentLink(link, selected) ? 6.5 : 3;
        })
        .linkDirectionalArrowColor((link) => {
          const selected = selectedIdRef.current;
          if (!selected) return LINK_COLOR;
          return isIncidentLink(link, selected) ? LINK_SELECTED_COLOR : LINK_MUTED_COLOR;
        })
        .linkDirectionalArrowRelPos(0.84)
        .linkHoverPrecision(6)
        .onNodeClick((node) => {
          onSelectRef.current(node.id);
        })
        .onNodeDragEnd((node) => {
          node.fx = node.x;
          node.fy = node.y;
          node.fz = node.z;
          scheduleLayoutSave();
        })
        .onEngineStop(() => {
          if (graphRef.current !== graph) return;
          if (!initialFitDone) {
            initialFitDone = true;
            graphReadyRef.current = true;
            const requestedNode = focusRequestedRef.current ? nodesRef.current.find((node) => node.id === selectedIdRef.current) : undefined;
            if (requestedNode) focusNode(graph, requestedNode, twoDimensionalRef.current, transitionMs);
            else graph.zoomToFit(transitionMs, 80);
            host.dataset.layoutReady = 'true';
          }
          scheduleLayoutSave();
        });

      // The halo sprites carry most of the glow. This low-strength bloom pass adds
      // a restrained light spread without making dense relationship edges luminous.
      let bloomPass: UnrealBloomPass | null = null;
      let outputPass: OutputPass | null = null;
      try {
        bloomPass = new UnrealBloomPass(
          new THREE.Vector2(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight)),
          0.32,
          0.35,
          0.95,
        );
        // The built-in composer only has RenderPass. Keep the final color-space
        // conversion after Bloom so the dark background retains its original color.
        outputPass = new OutputPass();
        bloomPass.enabled = glowEnabledRef.current;
        outputPass.enabled = glowEnabledRef.current;
        graph.postProcessingComposer().addPass(bloomPass);
        graph.postProcessingComposer().addPass(outputPass);
        bloomPassRef.current = bloomPass;
        outputPassRef.current = outputPass;
      } catch {
        // Browsers without a compatible post-processing path still keep the sprite glow.
        if (bloomPass) graph.postProcessingComposer().removePass(bloomPass);
        if (outputPass) graph.postProcessingComposer().removePass(outputPass);
        bloomPass?.dispose();
        outputPass?.dispose();
        bloomPass = null;
        outputPass = null;
        bloomPassRef.current = null;
        outputPassRef.current = null;
      }

      const ambient = new THREE.AmbientLight('#b6cbff', 0.7);
      const point = new THREE.PointLight('#65a9ff', 1.6, 500);
      point.position.set(0, 80, 140);
      graph.scene().add(ambient, point);

      const resizeObserver = new ResizeObserver(() => {
        graph.width(host.clientWidth).height(host.clientHeight);
      });
      resizeObserver.observe(host);
      const onVisibility = () => {
        if (document.hidden) {
          graph.pauseAnimation?.();
          animationPausedRef.current = true;
        } else if (!pausedRef.current && animationPausedRef.current) {
          graph.resumeAnimation?.();
          animationPausedRef.current = false;
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      if (document.hidden || pausedRef.current) {
        graph.pauseAnimation?.();
        animationPausedRef.current = true;
      }
      graph.graphData({ nodes: graphData.nodes, links: cloneLinks(graphData.links) });

      return () => {
        resizeObserver.disconnect();
        document.removeEventListener('visibilitychange', onVisibility);
        if (layoutTimerRef.current !== null) window.clearTimeout(layoutTimerRef.current);
        graph.pauseAnimation?.();
        animationPausedRef.current = true;
        graphRef.current = null;
        if (bloomPass) {
          graph.postProcessingComposer().removePass(bloomPass);
          bloomPass.dispose();
          if (bloomPassRef.current === bloomPass) bloomPassRef.current = null;
        }
        if (outputPass) {
          graph.postProcessingComposer().removePass(outputPass);
          outputPass.dispose();
          if (outputPassRef.current === outputPass) outputPassRef.current = null;
        }
        graph._destructor?.();
        for (const node of nodesRef.current) {
          node.__mesh?.traverse((object) => {
            const mesh = object as THREE.Mesh;
            if (mesh.geometry) mesh.geometry.dispose();
            const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
            const disposeMaterial = (item: THREE.Material) => {
              const withMap = item as THREE.Material & { map?: THREE.Texture };
              withMap.map?.dispose();
              item.dispose();
            };
            if (Array.isArray(material)) material.forEach(disposeMaterial);
            else if (material) disposeMaterial(material);
          });
        }
      };
    } catch {
      setGraphError('3D 图谱初始化失败，将使用文字列表继续工作。');
      graphRef.current = null;
      return undefined;
    }
    // graphData is the initial data for this graph instance; subsequent updates preserve node objects and positions below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const graph = graphRef.current;
    const bloomPass = bloomPassRef.current;
    if (bloomPass) bloomPass.enabled = glowEnabled;
    if (outputPassRef.current) outputPassRef.current.enabled = glowEnabled;
    for (const node of nodesRef.current) updateNodeVisual(node, glowEnabled);
    graph?.refresh?.();
  }, [glowEnabled]);

  useEffect(() => {
    nodesRef.current = graphData.nodes;
    const graph = graphRef.current;
    if (!graph) return;
    const previous = graph.graphData() as { nodes: GraphNode[]; links: GraphLink[] };
    const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
    for (const incoming of graphData.nodes) {
      const existing = previousById.get(incoming.id);
      if (existing) {
        const titleChanged = existing.title !== incoming.title;
        existing.state = incoming.state;
        existing.title = incoming.title;
        existing.summary = incoming.summary;
        existing.body = incoming.body;
        existing.domain = incoming.domain;
        existing.aliases = incoming.aliases;
        existing.source = incoming.source;
        incoming.x = existing.x;
        incoming.y = existing.y;
        incoming.z = existing.z;
        incoming.fx = existing.fx;
        incoming.fy = existing.fy;
        incoming.fz = existing.fz;
        incoming.__mesh = existing.__mesh;
        updateNodeVisual(existing, glowEnabledRef.current);
        if (titleChanged) updateNodeLabel(existing);
      }
    }
    const nextNodes = graphData.nodes.map((node) => previousById.get(node.id) ?? node);
    const nodesChanged = nextNodes.length !== previous.nodes.length || nextNodes.some((node) => !previousById.has(node.id));
    const linksChanged = linksSignature(graphData.links) !== linksSignature(previous.links);
    const topologyChanged = nodesChanged || linksChanged;
    nodesRef.current = nextNodes;
    if (topologyChanged) {
      // A source refresh may add/remove concepts. Preserve coordinates for surviving nodes while allowing the engine to add/remove only then.
      graph.graphData({ nodes: nextNodes, links: cloneLinks(graphData.links) });
    }
    graph.refresh?.();
    if (selectedId && !selectedIdRef.current) selectedIdRef.current = selectedId;
  }, [graphData, selectedId]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    if (!dimensionsInitializedRef.current) {
      // The initial dimension is already applied during graph construction. Reheating here
      // would mark the engine as running before three-forcegraph has installed its layout.
      dimensionsInitializedRef.current = true;
      return;
    }
    graph.numDimensions(twoDimensional ? 2 : 3);
    graph.d3ReheatSimulation?.();
  }, [twoDimensional]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    if (paused) {
      graph.pauseAnimation?.();
      animationPausedRef.current = true;
    } else if (!document.hidden && animationPausedRef.current) {
      graph.resumeAnimation?.();
      animationPausedRef.current = false;
    }
  }, [paused]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !selectedId || focusRevision === 0) return;
    focusRequestedRef.current = true;
    if (!graphReadyRef.current) return;
    const node = nodesRef.current.find((item) => item.id === selectedId);
    if (!node) return;
    focusNode(graph, node, twoDimensionalRef.current,
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 550,
    );
  }, [focusRevision, selectedId]);

  const edgeCount = snapshot.links.length;
  const selectedEdgeCount = selectedLinkCount(snapshot.links, selectedId);

  return (
    <div className="graph-stage" aria-label="3D 知识图谱">
      <div
        ref={hostRef}
        className={`graph-canvas${graphError ? ' graph-canvas-hidden' : ''}`}
        data-edge-count={edgeCount}
        data-selected-edge-count={selectedEdgeCount}
      />
      {graphError ? (
        <>
          <div className="graph-fallback" role="status">
            <span className="fallback-icon">◎</span>
            <strong>文字列表模式</strong>
            <span>{graphError}</span>
          </div>
          <div className="graph-fallback-items">
            <GraphFallbackList concepts={snapshot.concepts} states={snapshot.states} selectedId={selectedId} onSelect={onSelect} />
          </div>
        </>
      ) : null}
      {simulated ? <div className="simulation-watermark">模拟时间 · 只读</div> : null}
    </div>
  );
}

export function GraphFallbackList({
  concepts,
  states,
  selectedId,
  onSelect,
}: {
  concepts: Concept[];
  states: Record<string, MemoryState>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="graph-list-fallback" aria-label="概念文字列表">
      {concepts.map((concept) => {
        const state = states[concept.id];
        return (
          <button
            type="button"
            className={`fallback-node${selectedId === concept.id ? ' is-selected' : ''}`}
            key={concept.id}
            onClick={() => onSelect(concept.id)}
          >
            <span className="status-dot" style={{ backgroundColor: STATUS_COLORS[state?.status ?? 'unknown'] }} />
            <span>{concept.title}</span>
          </button>
        );
      })}
    </div>
  );
}

export { STATUS_COLORS };
