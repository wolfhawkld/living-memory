import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { inspectLayout } from '../shared/layout';
import type { Concept, GraphLink, Layout, MemoryState, Snapshot } from '../shared/types';
import { calculateNodeFocus } from './graph-focus';
import { collectGraphLayout, graphNodePosition } from './graph-position';
import { accommodateGraphOverview, calculateGraphOverview } from './graph-overview';
import { createIsolatedNodeForce } from './graph-isolation';
import { createGraphLabels } from './graph-labels';
import { readRotationStatus, rotateCameraClockwise, type IdleRotationClock, type RotationStatus } from './graph-rotation';
import { DARK_THEME } from './theme-palette';

export interface GraphViewProps {
  snapshot: Snapshot;
  layout: Layout;
  selectedId: string | null;
  simulated: boolean;
  paused?: boolean;
  twoDimensional: boolean;
  glowEnabled?: boolean;
  autoRotateEnabled?: boolean;
  rotationPaused?: boolean;
  onRotationStatusChange?: (status: RotationStatus) => void;
  rotationClock: IdleRotationClock;
  focusRevision?: number;
  onSelect: (conceptId: string) => void;
  onLayoutChange: (layout: Layout) => void;
}

interface PostProcessingComposer {
  addPass: (pass: UnrealBloomPass | OutputPass) => void;
  removePass: (pass: UnrealBloomPass | OutputPass) => void;
  renderTarget1: THREE.WebGLRenderTarget;
  renderTarget2: THREE.WebGLRenderTarget;
  reset: () => void;
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
  d3Force: (name: string, force: ReturnType<typeof createIsolatedNodeForce>) => GraphInstance;
  warmupTicks: (value: number) => GraphInstance;
  numDimensions: (value: 2 | 3) => GraphInstance;
  onNodeClick: (callback: (node: GraphNode) => void) => GraphInstance;
  onNodeHover: (callback: (node: GraphNode | null) => void) => GraphInstance;
  onNodeDragEnd: (callback: (node: GraphNode) => void) => GraphInstance;
  onEngineStop: (callback: () => void) => GraphInstance;
  scene: () => THREE.Scene;
  camera: () => THREE.PerspectiveCamera;
  controls: () => { target: THREE.Vector3; maxDistance: number; noRotate: boolean; mouseButtons: { LEFT: THREE.MOUSE } };
  renderer: () => THREE.WebGLRenderer;
  lights: (lights: THREE.Light[]) => GraphInstance;
  cameraPosition: (
    position?: { x: number; y: number; z: number },
    lookAt?: { x: number; y: number; z: number },
    transitionMs?: number,
  ) => { x: number; y: number; z: number } | GraphInstance;
  pauseAnimation?: () => GraphInstance;
  resumeAnimation?: () => GraphInstance;
  width: (value: number) => GraphInstance;
  height: (value: number) => GraphInstance;
  _destructor?: () => void;
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
    // White is a neutral alpha mask, not a theme color; tint comes from the material.
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

function nodeSize(_node: GraphNode): number {
  return 2.2;
}

interface NodeVisual {
  sphere: THREE.Mesh<THREE.SphereGeometry, THREE.MeshLambertMaterial>;
  halo: THREE.Sprite;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
}

function updateNodeVisual(node: GraphNode, glowEnabled = true, selected = false): void {
  const visual = node.__mesh?.userData.lmVisual as NodeVisual | undefined;
  if (!visual) return;
  const color = DARK_THEME.memory[node.state.status];
  visual.sphere.material.color.set(color);
  visual.sphere.material.emissive.set(color);
  visual.sphere.material.emissiveIntensity = glowEnabled
    ? DARK_THEME.graph.node.emissiveWithGlow
    : DARK_THEME.graph.node.emissiveWithoutGlow;
  const unknown = node.state.status === 'unknown';
  visual.sphere.visible = !unknown;
  visual.ring.visible = unknown || selected;
  visual.ring.material.color.set(selected ? DARK_THEME.graph.node.selectedRing : color);
  visual.ring.material.opacity = selected
    ? DARK_THEME.graph.node.selectedRingOpacity
    : DARK_THEME.graph.node.ringOpacity;
  const haloMaterial = visual.halo.material as THREE.SpriteMaterial;
  haloMaterial.color.set(color);
  haloMaterial.opacity = unknown ? DARK_THEME.graph.node.unknownHaloOpacity : DARK_THEME.graph.node.haloOpacity;
  visual.halo.visible = glowEnabled;
  const size = nodeSize(node);
  visual.sphere.scale.setScalar(size);
  visual.ring.scale.setScalar(size * (selected ? 1.45 : 1));
  visual.halo.scale.set(size * 6, size * 6, 1);
}

function buildNodeVisual(node: GraphNode, glowEnabled = true, selected = false): THREE.Group {
  const group = new THREE.Group();
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 24),
    new THREE.MeshLambertMaterial(),
  );
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.96, 1.08, 48),
    new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }),
  );
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  group.add(halo, ring, sphere);
  group.userData.lmVisual = { sphere, halo, ring };
  node.__mesh = group;
  updateNodeVisual(node, glowEnabled, selected);
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

function focusNode(graph: GraphInstance, node: GraphNode, twoDimensional: boolean, transitionMs: number): boolean {
  const target = graphNodePosition(node, twoDimensional);
  const camera = graphNodePosition(graph.camera().position);
  if (!target || !camera) return false;
  try {
    const focus = calculateNodeFocus(camera, target, nodeSize(node), twoDimensional);
    graph.cameraPosition(focus.position, focus.target, transitionMs);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

function fitOverview(
  graph: GraphInstance, nodes: GraphNode[], links: GraphLink[], host: HTMLElement,
  twoDimensional: boolean, transitionMs: number,
): boolean {
  const camera = graph.camera();
  const overview = calculateGraphOverview(nodes, links, {
    position: camera.position, target: graph.controls().target, up: camera.up,
    fov: camera.fov, zoom: camera.zoom, near: camera.near,
    width: host.clientWidth, height: host.clientHeight, twoDimensional,
  });
  if (!overview) return false;
  accommodateGraphOverview(camera, graph.controls(), overview);
  graph.cameraPosition(overview.position, overview.target, transitionMs);
  return true;
}

export function GraphView(props: GraphViewProps) {
  // A dimension change gets a fresh engine and camera. A live force simulation
  // and its camera tween must not straddle incompatible 2D/3D coordinates.
  return <GraphViewInstance key={props.twoDimensional ? '2d' : '3d'} {...props} />;
}

function GraphViewInstance({
  snapshot,
  layout,
  selectedId,
  simulated,
  paused = false,
  twoDimensional,
  glowEnabled = true,
  autoRotateEnabled = true,
  rotationPaused = false,
  onRotationStatusChange,
  rotationClock,
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
  const hoveredIdRef = useRef<string | null>(null);
  const linksRef = useRef(snapshot.links);
  const onSelectRef = useRef(onSelect);
  const onLayoutChangeRef = useRef(onLayoutChange);
  const simulatedRef = useRef(simulated);
  const glowEnabledRef = useRef(glowEnabled);
  const autoRotateEnabledRef = useRef(autoRotateEnabled);
  const rotationPausedRef = useRef(rotationPaused);
  const onRotationStatusRef = useRef(onRotationStatusChange);
  const pausedRef = useRef(paused);
  const animationPausedRef = useRef(false);
  const graphReadyRef = useRef(false);
  const focusRequestedRef = useRef(false);
  const rotationNotBeforeRef = useRef(0);
  const twoDimensionalRef = useRef(twoDimensional);
  const [graphError, setGraphError] = useState<string | null>(null);

  selectedIdRef.current = selectedId;
  linksRef.current = snapshot.links;
  onSelectRef.current = onSelect;
  onLayoutChangeRef.current = onLayoutChange;
  simulatedRef.current = simulated;
  glowEnabledRef.current = glowEnabled;
  autoRotateEnabledRef.current = autoRotateEnabled;
  rotationPausedRef.current = rotationPaused;
  onRotationStatusRef.current = onRotationStatusChange;
  twoDimensionalRef.current = twoDimensional;
  pausedRef.current = paused;

  const graphData = useMemo(() => {
    const inspectedLayout = inspectLayout(layout);
    const safeLayout = inspectedLayout?.layout ?? {};
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
      const stored = Object.prototype.hasOwnProperty.call(safeLayout, concept.id)
        ? safeLayout[concept.id]
        : undefined;
      const initial = stored ?? hashPosition(concept.id);
      return { ...concept, state, x: initial.x, y: initial.y, z: twoDimensional ? 0 : initial.z };
    });
    return { nodes, links: snapshot.links.map((link) => ({ ...link })) };
  }, [layout, snapshot, twoDimensional]);

  const saveLayout = () => {
    if (!graphRef.current || simulatedRef.current || pausedRef.current || twoDimensionalRef.current) return;
    const positions = collectGraphLayout(nodesRef.current, twoDimensionalRef.current);
    if (Object.keys(positions).length) onLayoutChangeRef.current(positions);
  };

  const scheduleLayoutSave = () => {
    if (!graphRef.current || simulatedRef.current || pausedRef.current || twoDimensionalRef.current) return;
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
      // React development effect replay can construct, destroy, and construct
      // the instance on one fiber; reset its readiness state each time.
      graphReadyRef.current = false;
      focusRequestedRef.current = false;
      rotationNotBeforeRef.current = 0;
      animationPausedRef.current = false;
      hoveredIdRef.current = null;
      const graph = new ForceGraph3D(host) as unknown as GraphInstance;
      const labels = createGraphLabels(host);
      let initialFitDone = false;
      let layoutSettled = false;
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
      const transitionMs = reducedMotion.matches ? 0 : 550;
      graphRef.current = graph;
      // ForceGraph's default TrackballControls otherwise lets a flat graph turn
      // edge-on or leave the camera plane after a drag. Pan and zoom stay enabled.
      graph.controls().noRotate = twoDimensional;
      if (twoDimensional) {
        graph.controls().mouseButtons.LEFT = THREE.MOUSE.PAN;
        graph.camera().up.set(0, 1, 0);
      }
      nodesRef.current = graphData.nodes;
      const fitInitialView = () => {
        if (initialFitDone || !layoutSettled || !nodesRef.current.length || host.clientWidth <= 0 || host.clientHeight <= 0) return;
        const requestedNode = focusRequestedRef.current ? nodesRef.current.find((node) => node.id === selectedIdRef.current) : undefined;
        const focused = requestedNode && focusNode(graph, requestedNode, twoDimensionalRef.current, transitionMs);
        if (!focused && !fitOverview(graph, nodesRef.current, linksRef.current, host, twoDimensionalRef.current, transitionMs)) return;
        initialFitDone = true;
        graphReadyRef.current = true;
        rotationNotBeforeRef.current = performance.now() + transitionMs;
        host.dataset.layoutReady = 'true';
      };
      // A scene background clears in the current render target's color space.
      // Relying only on renderer.clearColor can reuse the prior screen-space
      // clear value when the composer's RenderPass switches to a linear buffer.
      graph.scene().background = new THREE.Color(DARK_THEME.graph.background);
      graph
        .backgroundColor(DARK_THEME.graph.background)
        .showNavInfo(false)
        .enableNodeDrag(true)
        .cooldownTicks(150)
        .cooldownTime(2500)
        .warmupTicks(0)
        .d3AlphaDecay(0.045)
        .numDimensions(twoDimensional ? 2 : 3)
        .nodeThreeObject((node) => buildNodeVisual(node, glowEnabledRef.current, node.id === selectedIdRef.current))
        .nodeThreeObjectExtend(false)
        .nodeLabel((node) => `<strong style="display:inline-block;max-width:280px;white-space:normal;overflow-wrap:anywhere;line-height:1.3">${escapeHtml(node.title)}</strong><br/><span style="display:inline-block;max-width:280px;white-space:normal;overflow-wrap:anywhere;line-height:1.3">${escapeHtml(node.domain)}</span>`)
        .linkLabel((link) => {
          const type = link.type?.trim() || '相关';
          const description = link.description?.trim();
          return `<span style="display:inline-block;max-width:300px;white-space:normal;overflow-wrap:anywhere;line-height:1.35"><strong>关系：${escapeHtml(type)}</strong>${description ? `<br/><span>${escapeHtml(description)}</span>` : ''}</span>`;
        })
        .linkColor((link) => {
          const selected = selectedIdRef.current;
          if (!selected) return DARK_THEME.graph.link;
          return isIncidentLink(link, selected) ? DARK_THEME.graph.linkSelected : DARK_THEME.graph.linkMuted;
        })
        .linkOpacity(DARK_THEME.graph.linkOpacity)
        // Native lines keep a one-pixel footprint while zooming; world-space
        // cylinders and persistent arrows grew into large bars in close views.
        .linkWidth(0)
        .linkDirectionalArrowLength((link) => hoveredIdRef.current && isIncidentLink(link, hoveredIdRef.current) ? 1.4 : 0)
        .linkDirectionalArrowColor((link) => {
          const selected = selectedIdRef.current;
          if (!selected) return DARK_THEME.graph.link;
          return isIncidentLink(link, selected) ? DARK_THEME.graph.linkSelected : DARK_THEME.graph.linkMuted;
        })
        .linkDirectionalArrowRelPos(0.84)
        .linkHoverPrecision(6)
        .onNodeClick((node) => {
          onSelectRef.current(node.id);
        })
        .onNodeHover((node) => {
          hoveredIdRef.current = node?.id ?? null;
          graph.linkDirectionalArrowLength((link) => isIncidentLink(link, hoveredIdRef.current) ? 1.4 : 0);
        })
        .onNodeDragEnd((node) => {
          node.fx = node.x;
          node.fy = node.y;
          if (!twoDimensionalRef.current) node.fz = node.z;
          scheduleLayoutSave();
        })
        .onEngineStop(() => {
          if (graphRef.current !== graph) return;
          layoutSettled = true;
          fitInitialView();
          scheduleLayoutSave();
        });

      // Offscreen bloom bypasses the default framebuffer's antialiasing. MSAA
      // on both composer targets keeps thin links and small node silhouettes clean.
      const composer = graph.postProcessingComposer();
      const samples = Math.min(4, graph.renderer().capabilities.maxSamples);
      composer.renderTarget1.samples = samples;
      composer.renderTarget2.samples = samples;
      composer.reset();
      let bloomPass: UnrealBloomPass | null = null;
      let outputPass: OutputPass | null = null;
      try {
        bloomPass = new UnrealBloomPass(
          new THREE.Vector2(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight)),
          DARK_THEME.graph.bloom.strength,
          DARK_THEME.graph.bloom.radius,
          DARK_THEME.graph.bloom.threshold,
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

      const ambient = new THREE.AmbientLight(
        DARK_THEME.graph.ambientLight.color,
        DARK_THEME.graph.ambientLight.intensity,
      );
      const point = new THREE.DirectionalLight(
        DARK_THEME.graph.directionalLight.color,
        DARK_THEME.graph.directionalLight.intensity,
      );
      point.position.set(0, 80, 140);
      graph.lights([ambient, point]);

      let width = host.clientWidth;
      let height = host.clientHeight;
      let frame = 0;
      let activeLabelId: string | null | undefined;
      let previousLinks: GraphLink[] | undefined;
      let neighborIds = new Set<string>();
      let previousRotationStatus = '';
      const cameraSpace = new THREE.Vector3();
      // Labels live outside the WebGL/bloom scene. ForceGraph has no public
      // post-render hook; this loop also follows the camera after layout settles.
      const updatePresentation = (now: number) => {
        frame = window.requestAnimationFrame(updatePresentation);
        const rotationStatus = readRotationStatus(rotationClock, now, {
          enabled: autoRotateEnabledRef.current,
          ready: graphReadyRef.current && now >= rotationNotBeforeRef.current,
          twoDimensional: twoDimensionalRef.current,
          hidden: document.hidden,
          paused: pausedRef.current || rotationPausedRef.current,
        });
        const rotationAngle = rotationClock.step(now, rotationStatus.kind === 'rotating');
        if (rotationStatus.text !== previousRotationStatus) {
          previousRotationStatus = rotationStatus.text;
          host.dataset.rotationStatus = rotationStatus.kind;
          onRotationStatusRef.current?.(rotationStatus);
        }
        if (document.hidden || pausedRef.current) return;
        const camera = graph.camera();
        if (rotationAngle > 0) {
          const target = graph.controls().target;
          const position = rotateCameraClockwise(camera.position, target, rotationAngle);
          // Keep the controls' existing target, zoom and camera up vector. The
          // normal render loop updates controls; no new camera tween is created.
          camera.position.set(position.x, position.y, position.z);
          camera.lookAt(target);
        }
        camera.updateMatrixWorld();
        const active = hoveredIdRef.current ?? selectedIdRef.current;
        if (active !== activeLabelId || previousLinks !== linksRef.current) {
          activeLabelId = active;
          previousLinks = linksRef.current;
          neighborIds = new Set<string>();
          for (const link of linksRef.current) {
            if (!isIncidentLink(link, active)) continue;
            neighborIds.add(endpointId(link.source));
            neighborIds.add(endpointId(link.target));
          }
        }
        const viewHeightFactor = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        for (const node of nodesRef.current) {
          const group = node.__mesh;
          if (!group) continue;
          const position = graphNodePosition(node, twoDimensionalRef.current);
          group.visible = position !== null;
          if (!position) continue;
          const visual = group.userData.lmVisual as NodeVisual;
          visual.ring.quaternion.copy(camera.quaternion);
          cameraSpace.set(position.x, position.y, position.z).applyMatrix4(camera.matrixWorldInverse);
          // Close foreground nodes retain their color without becoming giant
          // disks that obscure the selected node or its relationships.
          const pixelRadius = node.id === selectedIdRef.current ? 8 : 6;
          const maxWorldRadius = Math.max(0, -cameraSpace.z) * viewHeightFactor * pixelRadius / Math.max(1, height);
          group.scale.setScalar(Math.min(1, maxWorldRadius / nodeSize(node)));
        }
        labels.update({ nodes: nodesRef.current, camera, width, height,
          twoDimensional: twoDimensionalRef.current,
          selectedId: selectedIdRef.current, hoveredId: hoveredIdRef.current, neighborIds });
      };
      frame = window.requestAnimationFrame(updatePresentation);

      const resizeObserver = new ResizeObserver(() => {
        width = host.clientWidth;
        height = host.clientHeight;
        graph.width(width).height(height);
        // A hidden/zero-size host defers its first fit until it can be measured.
        // Later resizes preserve the user's chosen view.
        fitInitialView();
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
      // Domain filtering can leave a node with only hidden, cross-domain links.
      // Keep those nodes near the visible graph without inventing any edges.
      graph.d3Force('isolatedBoundary', createIsolatedNodeForce(graphData.links, twoDimensional));
      graph.graphData({ nodes: graphData.nodes, links: cloneLinks(graphData.links) });

      return () => {
        window.cancelAnimationFrame(frame);
        labels.dispose();
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
    const bloomPass = bloomPassRef.current;
    if (bloomPass) bloomPass.enabled = glowEnabled;
    if (outputPassRef.current) outputPassRef.current.enabled = glowEnabled;
    for (const node of nodesRef.current) updateNodeVisual(node, glowEnabled, node.id === selectedIdRef.current);
  }, [glowEnabled]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const linkColor = (link: GraphLink) => (
      !selectedId
        ? DARK_THEME.graph.link
        : isIncidentLink(link, selectedId) ? DARK_THEME.graph.linkSelected : DARK_THEME.graph.linkMuted
    );
    graph.linkColor(linkColor).linkDirectionalArrowColor(linkColor);
    for (const node of nodesRef.current) updateNodeVisual(node, glowEnabledRef.current, node.id === selectedId);
  }, [selectedId]);

  useEffect(() => {
    nodesRef.current = graphData.nodes;
    const graph = graphRef.current;
    if (!graph) return;
    const previous = graph.graphData() as { nodes: GraphNode[]; links: GraphLink[] };
    const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
    for (const incoming of graphData.nodes) {
      const existing = previousById.get(incoming.id);
      if (existing) {
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
        updateNodeVisual(existing, glowEnabledRef.current, existing.id === selectedIdRef.current);
      }
    }
    const nextNodes = graphData.nodes.map((node) => previousById.get(node.id) ?? node);
    const nodesChanged = nextNodes.length !== previous.nodes.length || nextNodes.some((node) => !previousById.has(node.id));
    const linksChanged = linksSignature(graphData.links) !== linksSignature(previous.links);
    const topologyChanged = nodesChanged || linksChanged;
    nodesRef.current = nextNodes;
    if (topologyChanged) {
      // A source refresh may add/remove concepts. Preserve coordinates for surviving nodes while allowing the engine to add/remove only then.
      // Re-evaluate isolation when a cross-domain neighbor is expanded/removed.
      graph.d3Force('isolatedBoundary', createIsolatedNodeForce(graphData.links, twoDimensionalRef.current));
      graph.graphData({ nodes: nextNodes, links: cloneLinks(graphData.links) });
    }
    if (selectedId && !selectedIdRef.current) selectedIdRef.current = selectedId;
  }, [graphData, selectedId]);

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
    rotationClock.interact(performance.now());
    focusRequestedRef.current = true;
    if (!graphReadyRef.current) return;
    const node = nodesRef.current.find((item) => item.id === selectedId);
    if (!node) return;
    focusNode(graph, node, twoDimensionalRef.current,
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 550,
    );
  }, [focusRevision, rotationClock, selectedId]);

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
            <span className="status-dot" style={{ backgroundColor: DARK_THEME.memory[state?.status ?? 'unknown'] }} />
            <span>{concept.title}</span>
          </button>
        );
      })}
    </div>
  );
}
