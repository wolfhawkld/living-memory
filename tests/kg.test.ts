import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadKnowledgeGraph } from '../src/server/kg.js';

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'living-memory-kg-'));
  mkdirSync(join(root, 'Math'), { recursive: true });
  writeFileSync(join(root, 'Math', 'Boolean.md'), `---
type: concept
title: 布尔逻辑
aliases:
  - Boolean logic
summary: 真值与逻辑运算
maturity: draft
updated: 2026-01-01
---

# 布尔逻辑

用于表达真值判断。

## 关系网络
- 应用：[[Math/Decision.md]] — 规则校验
- 相关：[[Missing.md]] — 故意的坏链接
`);
  writeFileSync(join(root, 'Math', 'Decision.md'), `---
type: concept
title: 决策表
aliases: [decision table]
confidence: high
---

把条件组合映射为动作。

## 关系网络
- 相关：[[Boolean|布尔逻辑]]
`);
  writeFileSync(join(root, 'ignored.md'), `---
type: note
title: 不应导入
---
`);
  mkdirSync(join(root, '.obsidian'));
  writeFileSync(join(root, '.obsidian', 'private.md'), '---\ntype: concept\n---\n');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('loads concept pages, aliases, path domains, relations and diagnostics', () => {
  const { root, cleanup } = fixture();
  try {
    const loaded = loadKnowledgeGraph({ root, limit: 20 });
    assert.equal(loaded.graph.source.conceptCount, 2);
    assert.equal(loaded.graph.concepts.length, 2);
    const boolean = loaded.graph.concepts.find((item) => item.title === '布尔逻辑');
    assert.ok(boolean);
    assert.equal(boolean.domain, 'Math');
    assert.deepEqual(boolean.aliases, ['Boolean logic']);
    assert.equal(boolean.body.includes('用于表达真值判断'), true);
    assert.equal(loaded.graph.links.length, 2);
    assert.equal(loaded.graph.links.some((link) => link.type === 'application'), true);
    assert.equal(loaded.graph.links.some((link) => link.type === 'related'), true);
    assert.equal(loaded.graph.source.diagnostics.some((item) => item.includes('Missing.md')), true);
  } finally {
    cleanup();
  }
});

test('scans before applying limit and includes only selected internal links', () => {
  const { root, cleanup } = fixture();
  try {
    const loaded = loadKnowledgeGraph({ root, limit: 1 });
    assert.equal(loaded.graph.source.conceptCount, 2);
    assert.equal(loaded.graph.concepts.length, 1);
    assert.equal(loaded.graph.links.length, 0);
  } finally {
    cleanup();
  }
});

test('content revision excludes learning-irrelevant metadata and changes with readable text', () => {
  const { root, cleanup } = fixture();
  try {
    const first = loadKnowledgeGraph({ root }).graph.concepts.find((item) => item.title === '布尔逻辑');
    assert.ok(first);
    writeFileSync(join(root, 'Math', 'Boolean.md'), `---
type: concept
title: 布尔逻辑
aliases:
  - Boolean logic
summary: 真值与逻辑运算
maturity: reviewed
confidence: low
updated: 2099-01-01
---

# 布尔逻辑

用于表达真值判断。

## 关系网络
- 应用：[[Math/Decision.md]] — 规则校验
- 相关：[[Missing.md]] — 故意的坏链接
`);
    const metadataOnly = loadKnowledgeGraph({ root }).graph.concepts.find((item) => item.title === '布尔逻辑');
    assert.ok(metadataOnly);
    assert.equal(metadataOnly.source.revision, first.source.revision);
    writeFileSync(join(root, 'Math', 'Boolean.md'), `---
type: concept
title: 布尔逻辑
---

内容有实质变化。
`);
    const changed = loadKnowledgeGraph({ root }).graph.concepts.find((item) => item.title === '布尔逻辑');
    assert.ok(changed);
    assert.notEqual(changed.source.revision, first.source.revision);
  } finally {
    cleanup();
  }
});

test('skips excluded directories and symlinks which could escape the source root', () => {
  const { root, cleanup } = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'living-memory-outside-'));
  try {
    writeFileSync(join(outside, 'outside.md'), '---\ntype: concept\ntitle: 外部\n---\n');
    symlinkSync(outside, join(root, 'external-link'), 'dir');
    const loaded = loadKnowledgeGraph({ root });
    assert.equal(loaded.graph.source.conceptCount, 2);
    assert.equal(loaded.graph.concepts.some((item) => item.title === '外部'), false);
  } finally {
    cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test('resolves links outside an include prefix before omitting out-of-view edges', () => {
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, 'Model'));
    writeFileSync(join(root, 'Model', 'Softmax.md'), '---\ntype: concept\ntitle: Softmax\n---\n概率映射\n');
    writeFileSync(join(root, 'Math', 'Cross.md'), '---\ntype: concept\ntitle: Cross\n---\n## 关系网络\n- 应用：[[Model/Softmax.md]] — 模型输出\n');
    const loaded = loadKnowledgeGraph({ root, includePrefix: 'Math', limit: 20 });
    assert.equal(loaded.graph.source.conceptCount, 3);
    assert.equal(loaded.graph.concepts.every((item) => item.source.path.startsWith('Math/')), true);
    assert.equal(loaded.graph.source.diagnostics.some((item) => item.includes('Softmax')), false);
  } finally {
    cleanup();
  }
});

test('builds a complete cross-domain index once while keeping the scoped graph limited', () => {
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, 'Model'));
    writeFileSync(join(root, 'Model', 'Softmax.md'), '---\ntype: concept\ntitle: Softmax\n---\n\n## 关系网络\n- 应用：[[Math/Decision.md]] — 分类规则\n');
    writeFileSync(join(root, 'Math', 'Cross.md'), '---\ntype: concept\ntitle: Cross\n---\n\n## 关系网络\n- 应用：[[Model/Softmax.md]] — 模型输出\n');

    const scoped = loadKnowledgeGraph({ root, includePrefix: 'Math', limit: 1 });
    const complete = scoped.index;
    assert.equal(scoped.graph.concepts.length, 1);
    assert.equal(scoped.graph.source.conceptCount, 3);
    assert.equal(complete.concepts.length, 4);
    assert.equal(complete.source.conceptCount, 4);
    assert.equal(complete.source.initialDomainId, 'Math');
    assert.equal(scoped.graph.source.initialDomainId, 'Math');
    assert.equal(complete.links.some((link) => link.type === 'application'), true);
    assert.equal(scoped.graph.links.length, 0);

    const byPath = new Map(complete.concepts.map((concept) => [concept.source.path, concept.id]));
    assert.equal(byPath.get('Math/Boolean.md'), scoped.graph.concepts[0].id);
    assert.equal(scoped.namespace, loadKnowledgeGraph({ root, includePrefix: 'Model', limit: 20 }).namespace);
    assert.equal(scoped.graph.concepts.some((concept) => concept.source.path.startsWith('Model/')), false);
  } finally {
    cleanup();
  }
});

test('uses a stable root domain identifier for root-level concepts', () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(join(root, 'Root.md'), '---\ntype: concept\ntitle: 根概念\n---\n正文\n');
    const next = loadKnowledgeGraph({ root, includePrefix: 'Root.md' });
    assert.equal(next.index.concepts.find((concept) => concept.title === '根概念')?.source.path, 'Root.md');
    assert.equal(next.index.source.initialDomainId, '__root__');
    assert.equal(next.graph.source.initialDomainId, '__root__');
  } finally {
    cleanup();
  }
});
