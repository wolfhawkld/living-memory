import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Concept, MemoryState, MemoryStatus } from '../src/shared/types.js';
import { GraphFallbackList, type GraphFallbackListProps } from '../src/web/GraphFallbackList.js';

function concept(id: string, overrides: Partial<Concept> = {}): Concept {
  return {
    id, title: `概念 ${id}`, aliases: ['内部别名不展示'], domain: 'math',
    summary: '私有摘要不展示', body: '私有正文不展示',
    source: { path: `math/${id}.md`, revision: 'private-revision' },
    ...overrides,
  };
}

function state(conceptId: string, status: MemoryStatus): MemoryState {
  return { conceptId, status, decay: null, elapsedDays: null, anchor: null, reason: '内部判断不展示', asOf: '2026-10-14T00:00:00Z' };
}

function render(overrides: Partial<GraphFallbackListProps> = {}): string {
  return renderToStaticMarkup(createElement(GraphFallbackList, {
    concepts: [concept('a')], states: {}, selectedId: null, onSelect: () => undefined, ...overrides,
  }));
}

test('text list renders all six memory labels with decorative dots and explicit pressed states', () => {
  const cases: [MemoryStatus, string][] = [
    ['unknown', '尚未评估'], ['recent', '近期重温'], ['revisit', '建议再看'],
    ['stale', '较久未重温'], ['pending', '待确认'], ['retained', '长期保持（本人确认）'],
  ];
  const concepts = cases.map(([status]) => concept(status));
  const states = Object.fromEntries(cases.map(([status]) => [status, state(status, status)]));
  const html = render({ concepts, states, selectedId: 'recent' });
  assert.match(html, /<ul class="graph-list-items" aria-label="概念文字列表">/);
  assert.equal((html.match(/<li>/g) ?? []).length, 6);
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-pressed="false"/g) ?? []).length, 5);
  assert.match(html, /class="fallback-node is-selected" aria-pressed="true"/);
  for (const [status, label] of cases) {
    assert.ok(html.includes(label));
    assert.ok(html.includes(`aria-hidden="true" style="background-color:var(--memory-${status})"`));
  }
});

test('missing memory state is explicitly unknown without exposing concept bodies or private state details', () => {
  const html = render();
  assert.match(html, /尚未评估/);
  assert.match(html, /var\(--memory-unknown\)/);
  assert.doesNotMatch(html, /私有摘要|私有正文|内部别名|private-revision|内部判断/);
});

test('domain context marks external concepts and source paths distinguish identical titles', () => {
  const html = render({
    concepts: [concept('a', { title: '同名概念' }), concept('b', {
      title: '同名概念', domain: 'ai', source: { path: 'ai/b.md', revision: 'r' },
    })],
    currentDomainId: 'math',
  });
  assert.equal((html.match(/同名概念/g) ?? []).length, 2);
  assert.match(html, /math\/a.md/);
  assert.match(html, /ai\/b.md/);
  assert.equal((html.match(/跨域 · /g) ?? []).length, 1);
  assert.match(html, /跨域 · ai/);
  assert.doesNotMatch(render({ currentDomainId: null }), /跨域/);
});

test('empty text list remains labelled and provides an explicit empty message', () => {
  const html = render({ concepts: [] });
  assert.match(html, /当前没有可显示的概念。/);
  assert.match(html, /<ul class="graph-list-items" aria-label="概念文字列表"><\/ul>/);
  assert.doesNotMatch(html, /<button/);
});

test('directory domains determine cross-domain labels despite frontmatter and Windows path differences', () => {
  const html = render({ currentDomainId: 'Cognition/Math', concepts: [
    concept('same-directory', { domain: 'unrelated-frontmatter', source: { path: 'Cognition/Math/same.md', revision: 'r' } }),
    concept('windows-directory', { domain: 'ai', source: { path: 'Cognition\\Math\\windows.md', revision: 'r' } }),
    concept('outside-directory', { domain: 'Cognition/Math', source: { path: 'Cognition/Model/outside.md', revision: 'r' } }),
  ] });
  assert.equal((html.match(/跨域 · /g) ?? []).length, 1);
  assert.match(html, /跨域 · AI \/ 模型/);
  assert.doesNotMatch(html, /跨域 · unrelated-frontmatter|跨域 · ai/);
  assert.ok(html.includes('Cognition\\Math\\windows.md'));
});

test('long titles and paths retain their complete escaped text without inline truncation', () => {
  const title = `完整长标题${'超长概念名称'.repeat(40)}<script>正文不执行</script>`;
  const path = `math/${'very-long-path-'.repeat(35)}.md`;
  const html = render({ concepts: [concept('a', { title, source: { path, revision: 'r' } })] });
  assert.ok(html.includes(title.replaceAll('<', '&lt;').replaceAll('>', '&gt;')));
  assert.ok(html.includes(path));
  assert.doesNotMatch(html, /<script>|text-overflow|line-clamp|\.\.\./);
});
