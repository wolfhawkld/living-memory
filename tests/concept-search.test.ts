import assert from 'node:assert/strict';
import test from 'node:test';
import type { Concept } from '../src/shared/types.js';
import {
  normalizeSearchText,
  searchConcepts,
} from '../src/web/concept-search.js';

function concept(
  id: string,
  title: string,
  options: Partial<Pick<Concept, 'aliases' | 'summary' | 'source'>> = {},
): Concept {
  return {
    id,
    title,
    aliases: options.aliases ?? [],
    domain: 'unused',
    summary: options.summary ?? `${title} 摘要`,
    body: `${title} 正文`,
    source: options.source ?? { path: `Notes/${id}.md`, revision: `rev-${id}` },
  };
}

test('normalizes full-width forms, case, and surrounding whitespace', () => {
  assert.equal(normalizeSearchText('　ＡＢＣ　'), 'abc');
  assert.equal(normalizeSearchText('  Alpha\n  Beta '), 'alpha beta');
});

test('searches titles, aliases, and summaries across the whole library', () => {
  const concepts = [
    concept('title', 'Vector Index'),
    concept('alias', '向量空间', { aliases: ['Vector Indexing'] }),
    concept('summary', '别的标题', { summary: 'A vector index groups nearby points.' }),
  ];

  assert.deepEqual(searchConcepts(concepts, 'vector').items.map((hit) => hit.concept.id), [
    'title',
    'alias',
    'summary',
  ]);
  assert.equal(searchConcepts(concepts, 'vector').totalMatches, 3);
  assert.equal(searchConcepts(concepts, 'indexing').items[0]?.matchedField, 'alias');
  assert.equal(searchConcepts(concepts, 'groups nearby').items[0]?.matchedField, 'summary');
});

test('exact title and alias matches remain ahead of weak matches and current domain breaks ties', () => {
  const concepts = [
    concept('current-weak', '概念甲', { summary: 'contains target in the current domain', source: { path: 'Math/a.md', revision: '1' } }),
    concept('outside-exact', 'Target', { source: { path: 'Model/b.md', revision: '1' } }),
    concept('current-exact', 'TARGET', { source: { path: 'Math/c.md', revision: '1' } }),
    concept('current-alias', '另一个概念', { aliases: ['target'], source: { path: 'Math/d.md', revision: '1' } }),
  ];

  const result = searchConcepts(concepts, 'ｔａｒｇｅｔ', { currentDomainId: 'Math' });
  assert.deepEqual(result.items.map((hit) => hit.concept.id), [
    'current-exact',
    'current-alias',
    'outside-exact',
    'current-weak',
  ]);
  assert.equal(result.items[0]?.isCurrentDomain, true);
});

test('keeps duplicate titles as distinct concepts with stable source ordering', () => {
  const concepts = [
    concept('first', '重复标题', { source: { path: 'Math/first.md', revision: '1' } }),
    concept('second', '重复标题', { source: { path: 'Model/second.md', revision: '1' } }),
  ];
  const result = searchConcepts(concepts, '重复标题');
  assert.deepEqual(result.items.map((hit) => hit.concept.id), ['first', 'second']);
  assert.equal(new Set(result.items.map((hit) => hit.concept.id)).size, 2);
});

test('reports all matches while capping the returned window', () => {
  const concepts = Array.from({ length: 12 }, (_, index) => concept(`hit-${index}`, `Match ${index}`));
  const result = searchConcepts(concepts, 'match', { limit: 100 });
  assert.equal(result.totalMatches, 12);
  assert.equal(result.items.length, 8);
  assert.deepEqual(result.items.map((hit) => hit.concept.id), Array.from({ length: 8 }, (_, index) => `hit-${index}`));
});

test('returns no matches for an empty or unknown query', () => {
  const concepts = [concept('one', 'One')];
  assert.deepEqual(searchConcepts(concepts, '   '), { items: [], totalMatches: 0 });
  assert.deepEqual(searchConcepts(concepts, 'nothing'), { items: [], totalMatches: 0 });
});

test('name matches precede even exact summary matches', () => {
  const concepts = [
    concept('summary', '概率模型', { summary: 'vector' }),
    concept('name', 'Sparse Vector'),
  ];
  assert.deepEqual(searchConcepts(concepts, 'vector').items.map((hit) => hit.concept.id), ['name', 'summary']);
});

test('ranks the entire index before limiting results and leaves source data untouched', () => {
  const concepts = [
    ...Array.from({ length: 12 }, (_, index) => concept(`weak-${index}`, `Other ${index}`, {
      summary: 'target appears in this explanation', source: { path: `Math/${index}.md`, revision: '1' },
    })),
    concept('exact', 'Target', { source: { path: 'Model/target.md', revision: '1' } }),
  ];
  const original = structuredClone(concepts);
  const result = searchConcepts(concepts, 'target', { currentDomainId: 'Math' });
  assert.equal(result.items[0]?.concept.id, 'exact');
  assert.equal(result.totalMatches, 13);
  assert.equal(result.items.length, 8);
  assert.deepEqual(concepts, original);
});
