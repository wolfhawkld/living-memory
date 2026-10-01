import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GraphSourceContent, type GraphSourceContentProps } from '../src/web/GraphSourceContent.js';

function render(overrides: Partial<GraphSourceContentProps> = {}): string {
  return renderToStaticMarkup(createElement(GraphSourceContent, {
    sourceConceptCount: 0,
    listMode: false,
    refreshing: false,
    refreshDisabled: false,
    onRefresh: () => { throw new Error('Rendering must not refresh the source.'); },
    children: createElement('div', { className: 'existing-content' }, '原有视图'),
    ...overrides,
  }));
}

test('empty knowledge graph explains how to add Markdown without mounting a graph or invoking refresh', () => {
  function MustNotMount(): never { throw new Error('An empty source must not initialize the graph.'); }
  const html = render({ children: createElement(MustNotMount) });
  assert.match(html, /role="status"/);
  assert.match(html, /知识空间还没有概念/);
  assert.match(html, /将知识 Markdown 放入此账号的知识目录，再点击刷新知识源/);
  assert.match(html, /<button type="button"[^>]*>刷新知识源<\/button>/);
  assert.doesNotMatch(html, /disabled|canvas|切换.*域|正在加载|请求失败/);
});

test('nonempty sources, empty filtered views, and list mode keep their existing content', () => {
  for (const props of [
    { sourceConceptCount: 16 },
    { sourceConceptCount: 1, children: createElement('div', null, '筛选后没有可见节点') },
    { listMode: true },
    { listMode: true, sourceConceptCount: 16 },
  ]) {
    const html = render(props);
    assert.match(html, /原有视图|筛选后没有可见节点/);
    assert.doesNotMatch(html, /role="status"|知识空间还没有概念|刷新知识源/);
  }
});

test('empty graph refresh action is unavailable during refresh or when the existing workflow is locked', () => {
  const locked = render({ refreshDisabled: true, refreshHint: '请先点击「查看真实记录」，再刷新知识源。' });
  assert.match(locked, /<button[^>]*disabled=""[^>]*>刷新知识源<\/button>/);
  assert.match(locked, /aria-busy="false"/);
  assert.match(locked, /请先点击「查看真实记录」/);
  const busy = render({ refreshing: true });
  assert.match(busy, /<button[^>]*disabled=""[^>]*>刷新中…<\/button>/);
  assert.match(busy, /aria-busy="true"/);
  assert.match(busy, /知识空间还没有概念/);
});
