import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKnowledgeGraph } from '../src/server/kg.js';
import { projectMemory } from '../src/core/time-model.js';
import { DAY_MS, MODEL_VERSION } from '../src/shared/types.js';
import type {
  AnchorEvent,
  Concept,
  MemoryState,
  ModelConfig,
} from '../src/shared/types.js';
import { DARK_THEME } from '../src/web/theme-palette.js';

const WIDTH = 1100 as const;
const HEIGHT = 520 as const;
const AS_OF = '2026-10-01T00:00:00.000Z' as const;
const HALF_LIFE_DAYS = 7 as const;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '..');
const FIXTURE_ROOT = resolve(REPOSITORY_ROOT, 'fixtures', 'demo-kg');
const ASSET_DIRECTORY = resolve(REPOSITORY_ROOT, 'docs', 'assets');
const SVG_PATH = resolve(ASSET_DIRECTORY, 'readme-demo.svg');
const JSON_PATH = resolve(ASSET_DIRECTORY, 'readme-demo.json');

/** The public illustration intentionally covers this small, stable Math slice. */
const CONCEPT_SPECS = [
  { title: '向量', path: 'Math/向量.md', elapsedDays: 0 },
  { title: '矩阵', path: 'Math/矩阵.md', elapsedDays: 3 },
  { title: '范数', path: 'Math/范数.md', elapsedDays: 7 },
  { title: '内积', path: 'Math/内积.md', elapsedDays: 14 },
  { title: '余弦相似度', path: 'Math/余弦相似度.md', elapsedDays: null },
  { title: '正交', path: 'Math/正交.md', elapsedDays: 21 },
] as const;

interface NodeLayout {
  x: number;
  y: number;
  labelY: number;
  labelWidth: number;
}

const NODE_LAYOUT: Readonly<Record<string, NodeLayout>> = {
  向量: { x: 160, y: 205, labelY: 165, labelWidth: 58 },
  矩阵: { x: 160, y: 356, labelY: 397, labelWidth: 58 },
  范数: { x: 342, y: 175, labelY: 135, labelWidth: 58 },
  内积: { x: 354, y: 264, labelY: 310, labelWidth: 58 },
  余弦相似度: { x: 558, y: 172, labelY: 132, labelWidth: 104 },
  正交: { x: 548, y: 356, labelY: 397, labelWidth: 58 },
};

const STATUS_LABELS: Readonly<Record<MemoryState['status'], string>> = {
  recent: '近期重温',
  revisit: '建议再看',
  stale: '较久未重温',
  unknown: '未知 · 无重温起点',
  pending: '待确认',
  retained: '长期保持（本人确认）',
};

const LEGEND_STATUSES = ['recent', 'revisit', 'stale', 'unknown'] as const;

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[character] ?? character);
}

function requireConcept(byPath: ReadonlyMap<string, Concept>, path: string, title: string): Concept {
  const concept = byPath.get(path);
  if (!concept || concept.title !== title) {
    throw new Error(`Expected fixture concept ${title} at ${path}.`);
  }
  return concept;
}

function syntheticAnchor(concept: Concept, elapsedDays: number): AnchorEvent {
  const occurredAt = new Date(Date.parse(AS_OF) - elapsedDays * DAY_MS).toISOString();
  return {
    eventId: `synthetic-readme:${concept.source.path}`,
    conceptId: concept.id,
    sourceRevision: concept.source.revision,
    occurredAt,
    recordedAt: AS_OF,
    kind: 'estimated',
  };
}

function formatDecay(value: number | null): string {
  return value === null ? '—' : value.toFixed(3);
}

function formatDays(value: number | null): string {
  return value === null ? '未设时间' : `${value} 天`;
}

function pointOnLine(
  start: { x: number; y: number },
  end: { x: number; y: number },
  distance: number,
): { x: number; y: number } {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (length === 0) return start;
  return {
    x: start.x + ((end.x - start.x) / length) * distance,
    y: start.y + ((end.y - start.y) / length) * distance,
  };
}

function linePath(
  start: { x: number; y: number },
  end: { x: number; y: number },
  radius: number,
): string {
  const trimmedStart = pointOnLine(start, end, radius);
  const trimmedEnd = pointOnLine(end, start, radius);
  return `M ${trimmedStart.x} ${trimmedStart.y} L ${trimmedEnd.x} ${trimmedEnd.y}`;
}

function curvedPath(
  start: { x: number; y: number },
  end: { x: number; y: number },
  radius: number,
  offset: number,
): string {
  const trimmedStart = pointOnLine(start, end, radius);
  const trimmedEnd = pointOnLine(end, start, radius);
  const dx = trimmedEnd.x - trimmedStart.x;
  const dy = trimmedEnd.y - trimmedStart.y;
  const length = Math.hypot(dx, dy);
  const normal = { x: -dy / length, y: dx / length };
  const control = {
    x: (trimmedStart.x + trimmedEnd.x) / 2 + normal.x * offset,
    y: (trimmedStart.y + trimmedEnd.y) / 2 + normal.y * offset,
  };
  return `M ${trimmedStart.x} ${trimmedStart.y} Q ${control.x} ${control.y} ${trimmedEnd.x} ${trimmedEnd.y}`;
}

function relationPairKey(source: string, target: string): string {
  return [source, target].sort((left, right) => left.localeCompare(right)).join('\u0000');
}

function buildData() {
  const loaded = loadKnowledgeGraph({
    root: FIXTURE_ROOT,
    includePrefix: 'Math',
    limit: 20,
  });
  const byPath = new Map(loaded.graph.concepts.map((concept) => [concept.source.path, concept]));
  const selected = CONCEPT_SPECS.map((spec) => ({
    spec,
    concept: requireConcept(byPath, spec.path, spec.title),
  }));
  const selectedIds = new Set(selected.map(({ concept }) => concept.id));
  const selectedById = new Map(selected.map(({ concept }) => [concept.id, concept]));
  const config: ModelConfig = {
    modelVersion: MODEL_VERSION,
    halfLifeDays: HALF_LIFE_DAYS,
    revision: 1,
  };

  const states = selected.map(({ spec, concept }) => {
    const anchor = spec.elapsedDays === null ? null : syntheticAnchor(concept, spec.elapsedDays);
    const state = projectMemory(concept, anchor, config, AS_OF);
    return { spec, concept, state, color: DARK_THEME.memory[state.status] };
  });

  const relations = loaded.graph.links
    .filter((link) => selectedIds.has(link.source) && selectedIds.has(link.target))
    .map((link) => {
      const source = selectedById.get(link.source);
      const target = selectedById.get(link.target);
      if (!source || !target) throw new Error('Selected relation endpoint was not found.');
      return {
        source: source.source.path,
        target: target.source.path,
        sourceTitle: source.title,
        targetTitle: target.title,
        type: link.type,
        description: link.description,
      };
    })
    .sort((left, right) => (
      left.source.localeCompare(right.source) ||
      left.target.localeCompare(right.target) ||
      left.type.localeCompare(right.type) ||
      left.description.localeCompare(right.description)
    ));

  if (states.some(({ state }) => state.status === 'pending' || state.status === 'retained')) {
    throw new Error('The synthetic fixture projection produced an unsupported state.');
  }
  if (relations.length === 0) throw new Error('The selected fixture slice has no resolved relations.');

  const jsonConcepts = states.map(({ spec, concept, state, color }) => {
    const layout = NODE_LAYOUT[spec.title];
    if (!layout) throw new Error(`Missing fixed layout for ${spec.title}.`);
    return {
      title: concept.title,
      path: concept.source.path,
      elapsedDays: spec.elapsedDays,
      status: state.status,
      decay: state.decay,
      color,
      position: { x: layout.x, y: layout.y },
    };
  });

  const legend = LEGEND_STATUSES.map((status) => ({
    status,
    label: STATUS_LABELS[status],
    color: DARK_THEME.memory[status],
    examples: states
      .filter(({ state }) => state.status === status)
      .map(({ spec, state }) => ({
        title: spec.title,
        elapsedDays: spec.elapsedDays,
        decay: state.decay,
      })),
  }));

  const data = {
    kind: 'living-memory-readme-illustration' as const,
    version: 1 as const,
    synthetic: true as const,
    notForLearningImport: true as const,
    asOf: AS_OF,
    halfLifeDays: HALF_LIFE_DAYS,
    layout: {
      width: WIDTH,
      height: HEIGHT,
      positioning: 'fixed' as const,
    },
    source: {
      fixture: 'fixtures/demo-kg',
      scope: 'Math',
      paths: CONCEPT_SPECS.map(({ path }) => path),
    },
    concepts: jsonConcepts,
    relations,
    legend,
    notes: [
      'Synthetic README illustration data derived from the public demo fixture.',
      'This is not a learning import format and contains no persisted learning history.',
      'Decay is a time-only indicator from projectMemory, not a memory or recall percentage.',
    ],
  };
  return { loaded, states, relations, data };
}

function renderSvg(
  states: ReturnType<typeof buildData>['states'],
  relations: ReturnType<typeof buildData>['relations'],
): string {
  const theme = DARK_THEME;
  const nodeByPath = new Map(states.map(({ concept }) => [concept.source.path, concept]));
  const stateByPath = new Map(states.map((item) => [item.concept.source.path, item]));
  const pairCounts = new Map<string, number>();
  for (const relation of relations) {
    const key = relationPairKey(relation.source, relation.target);
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  const relationPaths = relations.map((relation) => {
    const source = nodeByPath.get(relation.source);
    const target = nodeByPath.get(relation.target);
    if (!source || !target) throw new Error('Cannot draw relation without selected endpoints.');
    const sourceLayout = NODE_LAYOUT[source.title];
    const targetLayout = NODE_LAYOUT[target.title];
    const reciprocal = (pairCounts.get(relationPairKey(relation.source, relation.target)) ?? 0) > 1;
    const sourceBeforeTarget = relation.source.localeCompare(relation.target) < 0;
    const d = reciprocal
      ? curvedPath(sourceLayout, targetLayout, 23, sourceBeforeTarget ? 10 : -10)
      : linePath(sourceLayout, targetLayout, 23);
    return `<path d="${d}" fill="none" stroke="${theme.graph.link}" stroke-width="1.7" stroke-linecap="round" opacity="${theme.graph.linkOpacity}" marker-end="url(#arrow)"/>`;
  });

  const nodeMarkup = states.map(({ concept, state, color }) => {
    const layout = NODE_LAYOUT[concept.title];
    const labelX = layout.x - layout.labelWidth / 2;
    const labelY = layout.labelY - 17;
    const unknown = state.status === 'unknown';
    return [
      `<g data-concept="${escapeXml(concept.title)}">`,
      `<circle cx="${layout.x}" cy="${layout.y}" r="25" fill="${color}" opacity="0.13" filter="url(#node-glow)"/>`,
      `<circle cx="${layout.x}" cy="${layout.y}" r="18" fill="${unknown ? theme.graph.background : color}" stroke="${color}" stroke-width="${unknown ? 2 : 1.5}" opacity="0.96"/>`,
      unknown
        ? `<circle cx="${layout.x}" cy="${layout.y}" r="8" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="2 3"/>`
        : `<circle cx="${layout.x - 5}" cy="${layout.y - 5}" r="4" fill="#ffffff" opacity="0.42"/>`,
      `<rect x="${labelX}" y="${labelY}" width="${layout.labelWidth}" height="26" rx="8" fill="${theme.graph.label.background}" stroke="${color}" stroke-opacity="0.48"/>`,
      `<text x="${layout.x}" y="${layout.labelY}" text-anchor="middle" fill="${theme.graph.label.text}" font-size="16" font-weight="600">${escapeXml(concept.title)}</text>`,
      '</g>',
    ].join('');
  });

  const statusRows = LEGEND_STATUSES.map((status, index) => {
    const y = 152 + index * 60;
    const examples = states.filter(({ state }) => state.status === status);
    const detail = examples.map(({ spec }) => `${formatDays(spec.elapsedDays)} · ${spec.title}`).join('   ');
    const decay = examples.map(({ state }) => formatDecay(state.decay)).join(' / ');
    const color = theme.memory[status];
    return [
      `<rect x="736" y="${y}" width="316" height="50" rx="10" fill="${theme.ui.panelSoft}" stroke="${theme.ui.border}"/>`,
      `<circle cx="756" cy="${y + 23}" r="6" fill="${color}" opacity="0.96"/>`,
      `<text x="772" y="${y + 20}" fill="${theme.ui.text}" font-size="16" font-weight="650">${escapeXml(STATUS_LABELS[status])}</text>`,
      `<text x="772" y="${y + 40}" fill="${theme.ui.textMuted}" font-size="13">${escapeXml(detail)}</text>`,
      `<text x="1035" y="${y + 27}" text-anchor="end" fill="${color}" font-size="12" font-weight="600">D ${escapeXml(decay)}</text>`,
    ].join('');
  });

  const uniquePairCount = new Set(relations.map((relation) => relationPairKey(relation.source, relation.target))).size;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="title desc">`,
    '<title id="title">Living Memory synthetic README illustration</title>',
    '<desc id="desc">A fixed dark illustration of six Math concepts and their resolved fixture relations, alongside synthetic time states.</desc>',
    '<defs>',
    `<filter id="node-glow" x="-100%" y="-100%" width="300%" height="300%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
    `<marker id="arrow" viewBox="0 0 7 7" refX="6" refY="3.5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 7 3.5 L 0 7 z" fill="${theme.graph.link}" opacity="${theme.graph.linkOpacity}"/></marker>`,
    '</defs>',
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${theme.graph.background}"/>`,
    `<rect width="${WIDTH}" height="4" fill="${theme.ui.accent}" opacity="0.72"/>`,
    `<rect x="32" y="28" width="650" height="424" rx="18" fill="${theme.ui.panel}" stroke="${theme.ui.borderStrong}"/>`,
    `<rect x="708" y="28" width="360" height="424" rx="18" fill="${theme.ui.panel}" stroke="${theme.ui.borderStrong}"/>`,
    `<text x="58" y="66" fill="${theme.ui.text}" font-size="20" font-weight="700">知识关系</text>`,
    `<text x="58" y="89" fill="${theme.ui.textMuted}" font-size="12">Math · 六个概念 · ${relations.length} 条有向关系 / ${uniquePairCount} 个可见节点对</text>`,
    `<text x="734" y="66" fill="${theme.ui.text}" font-size="20" font-weight="700">时间状态</text>`,
    `<text x="734" y="89" fill="${theme.ui.textMuted}" font-size="14">时间基线 · H = ${HALF_LIFE_DAYS} 天</text>`,
    `<rect x="736" y="105" width="316" height="38" rx="10" fill="${theme.ui.panelRaised}" stroke="${theme.ui.border}"/>`,
    `<text x="756" y="129" fill="${theme.ui.text}" font-size="14" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">D(t) = 2^(−t / H)</text>`,
    relationPaths.join(''),
    nodeMarkup.join(''),
    statusRows.join(''),
    `<text x="736" y="408" fill="${theme.ui.textMuted}" font-size="13">颜色按同一时间规则计算。</text>`,
    `<text x="736" y="430" fill="${theme.ui.textMuted}" font-size="13">没有重温起点的概念保持未知。</text>`,
    `<line x1="40" y1="474" x2="1060" y2="474" stroke="${theme.ui.border}"/>`,
    `<text x="40" y="498" fill="${theme.ui.textMuted}" font-size="14">合成示意 · 虚构日期 2026-10-01 · 固定布局 · 不是记忆百分比</text>`,
    '</svg>',
  ].join('\n');
  // Keep this lookup in the rendering path so an accidental missing state cannot
  // produce a visually plausible but semantically incomplete legend.
  if (stateByPath.size !== states.length) throw new Error('Duplicate concept path in rendered state.');
  return `${svg}\n`;
}

function main(): void {
  const { states, relations, data } = buildData();
  mkdirSync(ASSET_DIRECTORY, { recursive: true });
  writeFileSync(JSON_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  writeFileSync(SVG_PATH, renderSvg(states, relations), 'utf8');
  process.stdout.write(`Generated ${JSON_PATH} and ${SVG_PATH} from six synthetic Math concepts.\n`);
}

main();
