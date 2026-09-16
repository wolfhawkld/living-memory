import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import type { Concept, GraphLink, Layout, MemoryState, Snapshot } from '../shared/types';

export interface GraphViewProps {
  snapshot: Snapshot;
  layout: Layout;
  selectedId: string | null;
  simulated: boolean;
  paused?: boolean;
  twoDimensional: boolean;
  onSelect: (conceptId: string) => void;
  onLayoutChange: (layout: Layout) => void;
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

function glowTexture(color: string): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(64, 64, 2, 64, 64, 64);
    gradient.addColorStop(0, `${color}ee`);
    gradient.addColorStop(0.16, `${color}88`);
    gradient.addColorStop(0.48, `${color}2e`);
    gradient.addColorStop(1, `${color}00`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function labelTexture(text: string, color: string): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 72;
  const context = canvas.getContext('2d');
  if (context) {
    context.font = '600 26px "Microsoft YaHei", "PingFang SC", sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.shadowColor = '#030810';
    context.shadowBlur = 9;
    context.fillStyle = '#030810';
    context.fillText(text, 256, 36);
    context.shadowBlur = 0;
    context.fillStyle = color === STATUS_COLORS.unknown ? '#a5b4cc' : '#dce9fb';
    context.fillText(text, 256, 36);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function nodeSize(node: GraphNode): number {
  if (node.state.status === 'stale') return 5.8;
  if (node.state.status === 'revisit') return 5.4;
  if (node.state.status === 'recent') return 5.1;
  return 4.7;
}

function updateNodeVisual(node: GraphNode): void {
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
  haloMaterial.opacity = node.state.status === 'unknown' ? 0.16 : 0.42;
  const size = nodeSize(node);
  visual.sphere.scale.setScalar(size / 5);
  visual.ring.scale.setScalar(size / 5);
  visual.halo.scale.set(size * 4.6, size * 4.6, 1);
}

function updateNodeLabel(node: GraphNode): void {
  const visual = node.__mesh?.userData.lmVisual as
    | { label: THREE.Sprite }
    | undefined;
  if (!visual) return;
  const material = visual.label.material as THREE.SpriteMaterial;
  material.map?.dispose();
  material.map = labelTexture(node.title, STATUS_COLORS[node.state.status]);
  material.needsUpdate = true;
  visual.label.scale.set(85, 12, 1);
}

function buildNodeVisual(node: GraphNode): THREE.Group {
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
      map: glowTexture(color),
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  halo.scale.set(size * 4.6, size * 4.6, 1);
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(node.title, color), transparent: true, depthWrite: false, opacity: 0.92 }));
  label.position.set(0, size + 7, 0);
  label.scale.set(85, 12, 1);
  group.add(halo, ring, sphere, label);
  group.userData.lmVisual = { sphere, halo, ring, label };
  node.__mesh = group;
  updateNodeVisual(node);
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

export function GraphView({
  snapshot,
  layout,
  selectedId,
  simulated,
  paused = false,
  twoDimensional,
  onSelect,
  onLayoutChange,
}: GraphViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<GraphInstance | null>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const layoutTimerRef = useRef<number | null>(null);
  const selectedIdRef = useRef(selectedId);
  const onSelectRef = useRef(onSelect);
  const onLayoutChangeRef = useRef(onLayoutChange);
  const simulatedRef = useRef(simulated);
  const pausedRef = useRef(paused);
  const animationPausedRef = useRef(false);
  const dimensionsInitializedRef = useRef(false);
  const [graphError, setGraphError] = useState<string | null>(null);

  selectedIdRef.current = selectedId;
  onSelectRef.current = onSelect;
  onLayoutChangeRef.current = onLayoutChange;
  simulatedRef.current = simulated;
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
      animationPausedRef.current = false;
      const graph = new ForceGraph3D(host) as unknown as GraphInstance;
      let initialFitDone = false;
      const transitionMs = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 550;
      graphRef.current = graph;
      nodesRef.current = graphData.nodes;
      graph
        .backgroundColor('#070c18')
        .showNavInfo(false)
        .enableNodeDrag(true)
        .cooldownTicks(150)
        .cooldownTime(2500)
        .warmupTicks(0)
        .d3AlphaDecay(0.045)
        .numDimensions(twoDimensional ? 2 : 3)
        .nodeThreeObject(buildNodeVisual)
        .nodeThreeObjectExtend(false)
        .nodeLabel((node) => `<strong>${escapeHtml(node.title)}</strong><br/><span>${escapeHtml(node.domain)}</span>`)
        .linkLabel((link) => {
          const type = link.type?.trim() || '相关';
          const description = link.description?.trim();
          return `<strong>关系：${escapeHtml(type)}</strong>${description ? `<br/><span>${escapeHtml(description)}</span>` : ''}`;
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
          const x = node.x ?? 0;
          const y = node.y ?? 0;
          const z = node.z ?? 0;
          const magnitude = Math.sqrt(x * x + y * y + z * z) || 1;
          const distance = 80;
          graph.cameraPosition(
            { x: x + (x / magnitude) * distance, y: y + (y / magnitude) * distance, z: z + (z / magnitude) * distance },
            { x, y, z },
            transitionMs,
          );
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
            graph.zoomToFit(transitionMs, 80);
            host.dataset.layoutReady = 'true';
          }
          scheduleLayoutSave();
        });

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
        updateNodeVisual(existing);
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
    if (!graph || !selectedId) return;
    const node = nodesRef.current.find((item) => item.id === selectedId);
    if (!node) return;
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const z = node.z ?? 0;
    const magnitude = Math.sqrt(x * x + y * y + z * z) || 1;
    graph.cameraPosition(
      { x: x + (x / magnitude) * 80, y: y + (y / magnitude) * 80, z: z + (z / magnitude) * 80 },
      { x, y, z },
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 550,
    );
  }, [selectedId]);

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
