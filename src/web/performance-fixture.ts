import type { Concept, GraphLink, Layout, MemoryState, Snapshot } from '../shared/types';

export const PERFORMANCE_FIXTURE_ID = 'synthetic-300n-1000e-v1';
export const PERFORMANCE_NODE_COUNT = 300;
export const PERFORMANCE_EDGE_COUNT = 1000;
const AS_OF = '2026-01-01T00:00:00.000Z';

/** Fresh, fixed synthetic data: never requests the user's knowledge or storage. */
export function createPerformanceFixture(): { snapshot: Snapshot; layout: Layout } {
  const concepts: Concept[] = Array.from({ length: PERFORMANCE_NODE_COUNT }, (_, index) => ({
    id: `performance-node-${String(index).padStart(3, '0')}`, title: `合成概念 ${String(index + 1).padStart(3, '0')}`,
    aliases: [], domain: 'Synthetic', summary: '用于固定规模的图谱渲染测试。', body: '合成性能资料，不对应个人知识或学习记录。',
    source: { path: `Synthetic/node-${String(index).padStart(3, '0')}.md`, revision: 'synthetic-performance-v1' },
  }));
  const links: GraphLink[] = Array.from({ length: PERFORMANCE_EDGE_COUNT }, (_, index) => {
    const from = index % PERFORMANCE_NODE_COUNT;
    const to = (from + 1 + Math.floor(index / PERFORMANCE_NODE_COUNT) * 73) % PERFORMANCE_NODE_COUNT;
    return { id: `performance-edge-${index}`, source: concepts[from].id, target: concepts[to].id,
      type: 'related', description: '固定合成关系' };
  });
  const layout: Layout = {}; const states: Record<string, MemoryState> = {};
  const radius = 220; const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  concepts.forEach((concept, index) => {
    const z = radius * (1 - 2 * (index + .5) / PERFORMANCE_NODE_COUNT);
    const ring = Math.sqrt(radius * radius - z * z);
    layout[concept.id] = { x: Math.cos(index * goldenAngle) * ring, y: Math.sin(index * goldenAngle) * ring, z };
    const stage = index % 4; const days = [0, 1, 7, 30][stage];
    states[concept.id] = { conceptId: concept.id, status: (['unknown', 'recent', 'revisit', 'stale'] as const)[stage],
      decay: stage ? 2 ** (-days / 7) : null, elapsedDays: stage ? days : null,
      anchor: stage ? { eventId: `synthetic-anchor-${index}`, conceptId: concept.id, sourceRevision: concept.source.revision,
        occurredAt: new Date(Date.parse(AS_OF) - days * 86_400_000).toISOString(), recordedAt: AS_OF, kind: 'estimated' } : null,
      reason: '固定合成状态，不写入学习记录。', asOf: AS_OF };
  });
  return { snapshot: { concepts, links, states, source: { name: PERFORMANCE_FIXTURE_ID, mode: 'demo', conceptCount: PERFORMANCE_NODE_COUNT,
    limit: PERFORMANCE_NODE_COUNT, diagnostics: [], initialDomainId: 'Synthetic' }, asOf: AS_OF,
    config: { modelVersion: 'time-only-v0', halfLifeDays: 7, revision: 0 }, observationsCount: 0 }, layout };
}
