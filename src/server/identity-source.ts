import type { IdentityBinding } from '../shared/identity.js';
import type { KnowledgeGraph } from '../shared/types.js';
import type { KnowledgeSource } from './kg.js';

/** Apply only this namespace's persisted, person-confirmed bindings to a fresh scan. */
export function applyIdentityBindings(source: KnowledgeSource, bindings: IdentityBinding[]): KnowledgeSource {
  if (!bindings.length) return source;
  const bindingsByRaw = new Map(bindings.map(binding => [binding.rawConceptId, binding]));
  const ids = new Map<string, string>();
  const groups = new Map<string, string[]>();
  const blocked = new Set<string>();
  const diagnostics: string[] = [];
  for (const concept of source.index.concepts) {
    const binding = bindingsByRaw.get(concept.id);
    if (binding && (binding.toPath !== concept.source.path || bindingsByRaw.has(binding.conceptId))) {
      blocked.add(concept.id);
      diagnostics.push(`身份登记与文件不一致：${concept.source.path}，暂不显示此节点。`);
      continue;
    }
    const id = binding?.conceptId ?? concept.id;
    ids.set(concept.id, id);
    groups.set(id, [...(groups.get(id) ?? []), concept.id]);
  }
  const paths = new Map(source.index.concepts.map(concept => [concept.id, concept.source.path]));
  for (const rawIds of groups.values()) {
    if (rawIds.length < 2) continue;
    rawIds.forEach(id => blocked.add(id));
    diagnostics.push(`身份冲突：${rawIds.map(id => paths.get(id)).join('、')} 指向同一历史概念，已暂停显示；请核对重复文件后刷新。`);
  }
  const project = (graph: KnowledgeGraph, complete: boolean): KnowledgeGraph => {
    const concepts = graph.concepts.filter(concept => !blocked.has(concept.id))
      .map(concept => ({ ...concept, id: ids.get(concept.id) ?? concept.id }));
    const visible = new Set(concepts.map(concept => concept.id));
    const links = graph.links.filter(link => !blocked.has(link.source) && !blocked.has(link.target))
      .map(link => ({ ...link, source: ids.get(link.source) ?? link.source, target: ids.get(link.target) ?? link.target }))
      .filter(link => visible.has(link.source) && visible.has(link.target));
    return { ...graph, concepts, links, source: { ...graph.source,
      conceptCount: complete ? concepts.length : graph.source.conceptCount - (graph.concepts.length - concepts.length),
      diagnostics: [...graph.source.diagnostics, ...diagnostics],
    } };
  };
  return { ...source, graph: project(source.graph, false), index: project(source.index, true) };
}
