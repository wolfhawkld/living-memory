import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { loadKnowledgeGraph } from '../src/server/kg.js';
import { getKnowledgeReferences } from '../src/server/knowledge-references.js';

function vault() {
  const root = mkdtempSync(join(tmpdir(), 'lm-reference-vault-'));
  const write = (path: string, title: string, body: string, aliases: string[] = []) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), `---\ntype: concept\ntitle: ${title}\naliases: ${JSON.stringify(aliases)}\n---\n${body}`);
  };
  return { root, write, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('reference resolution keeps distinct sections outside the graph cap without changing graph identities', () => {
  const v = vault();
  try {
    v.write('Math/A.md', 'A', '# A\n[[B#定义]]\n[[B#应用]]\n[[B#定义|再次引用]]');
    v.write('Math/B.md', 'B', '# B\n## 定义\n内容\n## 应用\n内容');
    const source = loadKnowledgeGraph({ root: v.root, limit: 1 });
    const before = JSON.stringify(source);
    const a = source.index.concepts.find((item) => item.title === 'A')!;
    const b = source.index.concepts.find((item) => item.title === 'B')!;
    const result = getKnowledgeReferences(source, a.id, a.source.revision);
    assert.equal(result.references.length, 3);
    assert.equal(new Set(result.references.map((item) => item.referenceId)).size, 3);
    assert.deepEqual(result.references.map((item) => item.sectionId), ['定义', '应用', '定义']);
    assert.ok(result.references.every((item) => item.targetConceptId === b.id && item.targetRevision === b.source.revision && item.status === 'resolved-section'));
    assert.equal(JSON.stringify(source), before);
  } finally { v.close(); }
});

test('wiki duplicate titles stay ambiguous while explicit Markdown slugs and self references locate precisely', () => {
  const v = vault();
  try {
    v.write('A.md', 'A', '# A\n## 重复\n一\n## 重复\n二\n[[#重复]]\n[精确第二章](#重复-2)\n[[#A]]');
    const source = loadKnowledgeGraph({ root: v.root });
    const a = source.index.concepts[0];
    const result = getKnowledgeReferences(source, a.id, a.source.revision);
    assert.deepEqual(result.references.map((item) => [item.status, item.sectionId]), [
      ['ambiguous', undefined], ['resolved-section', '重复-2'], ['resolved-section', 'a'],
    ]);
    assert.ok(result.references.every((item) => item.targetConceptId === a.id));
  } finally { v.close(); }
});

test('missing, ambiguous, block and unsafe targets are retained with explicit reasons', () => {
  const v = vault();
  try {
    v.write('Math/A.md', 'A', '# A\n[[不存在#章]]\n[[同名]]\n[[B#不存在]]\n[[B#^block]]\n[穿越](../../secret.md#章)\n[编码穿越](%2e%2e/%2e%2e/secret.md)');
    v.write('Math/B.md', 'B', '# B');
    v.write('One/C.md', 'C', '# C', ['同名']);
    v.write('Two/D.md', 'D', '# D', ['同名']);
    const source = loadKnowledgeGraph({ root: v.root });
    const a = source.index.concepts.find((item) => item.title === 'A')!;
    const references = getKnowledgeReferences(source, a.id, a.source.revision).references;
    assert.deepEqual(references.map((item) => item.status), [
      'missing-concept', 'ambiguous', 'missing-section', 'unsupported-block', 'unsafe', 'unsafe',
    ]);
    assert.equal(references[3].fragment, '^block');
    assert.equal(references[4].rawTarget, '../../secret.md#章');
    assert.equal(references[5].rawTarget, '%2e%2e/%2e%2e/secret.md');
  } finally { v.close(); }
});

test('a refreshed source updates target revisions and refuses stale origin versions', () => {
  const v = vault();
  try {
    v.write('A.md', 'A', '# A\n[[B#原章节]]');
    v.write('B.md', 'B', '# B\n## 原章节\n旧资料');
    const original = loadKnowledgeGraph({ root: v.root });
    const a = original.index.concepts.find((item) => item.title === 'A')!;
    const first = getKnowledgeReferences(original, a.id, a.source.revision);
    v.write('B.md', 'B', '# B\n## 新章节\n新资料');
    const refreshed = loadKnowledgeGraph({ root: v.root });
    const second = getKnowledgeReferences(refreshed, a.id, a.source.revision);
    assert.equal(second.references[0].status, 'missing-section');
    assert.notEqual(second.references[0].targetRevision, first.references[0].targetRevision);
    assert.equal(first.references[0].status, 'resolved-section');
    assert.throws(() => getKnowledgeReferences(refreshed, a.id, 'old-revision'), { code: 'SOURCE_CHANGED' });
    assert.throws(() => getKnowledgeReferences(refreshed, 'another-account-id', a.source.revision), { code: 'CONCEPT_NOT_FOUND' });
  } finally { v.close(); }
});

test('relative references stay inside the indexed vault and external links remain ordinary links', () => {
  const v = vault();
  try {
    v.write('Math/A.md', 'A', '# A\n[跨目录](../AI/B.md#目标)\n[网站](https://example.com/page#目标)\n![附件](image.png)');
    v.write('AI/B.md', 'B', '# B\n## 目标\n内容');
    const source = loadKnowledgeGraph({ root: v.root });
    const a = source.index.concepts.find((item) => item.title === 'A')!;
    const result = getKnowledgeReferences(source, a.id, a.source.revision);
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].targetPath, 'AI/B.md');
    assert.equal(result.references[0].status, 'resolved-section');
  } finally { v.close(); }
});

test('complete filenames win over another document whose extensionless alias has the same text', () => {
  const v = vault();
  try {
    v.write('Start.md', 'Start', '# Start\n[[A.md]]\n[[A.md.md]]');
    v.write('A.md', 'First', '# First');
    v.write('A.md.md', 'Second', '# Second');
    const source = loadKnowledgeGraph({ root: v.root });
    const start = source.index.concepts.find((item) => item.title === 'Start')!;
    const references = getKnowledgeReferences(source, start.id, start.source.revision).references;
    assert.deepEqual(references.map((item) => item.targetPath), ['A.md', 'A.md.md']);
    assert.notEqual(references[0].targetConceptId, references[1].targetConceptId);
  } finally { v.close(); }
});

test('wiki literal percent names and URL-encoded Markdown paths keep their distinct document meanings', () => {
  const v = vault();
  try {
    v.write('Start.md', 'Start', '# Start\n[[A%20B#字面%20标题]]\n[编码路径](A%20B.md#%E4%B8%AD%E6%96%87)');
    v.write('A%20B.md', 'Literal', '# Literal\n## 字面%20标题');
    v.write('A B.md', 'Decoded', '# Decoded\n## 中文');
    const source = loadKnowledgeGraph({ root: v.root });
    const start = source.index.concepts.find((item) => item.title === 'Start')!;
    const references = getKnowledgeReferences(source, start.id, start.source.revision).references;
    assert.deepEqual(references.map((item) => [item.syntax, item.targetPath, item.status]), [
      ['wiki', 'A%20B.md', 'resolved-section'], ['markdown', 'A B.md', 'resolved-section'],
    ]);
  } finally { v.close(); }
});
