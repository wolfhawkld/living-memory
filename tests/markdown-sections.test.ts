import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { parseMarkdownReferenceTokens, parseMarkdownSections, parseMarkdownContentBlocks } from '../src/core/markdown-sections';
import { normalizeDisplayMath } from '../src/core/markdown-normalization';
import { scanWikiReferences, assignKnowledgeContentBlocks, remarkKnowledgeContentBlocks } from '../src/shared/knowledge-references';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

test('sections share formatted ATX and Setext titles, hierarchy and current-body coordinates', () => {
  const body = 'Preamble\n\n# **数学** `AI`\nintro\n\n子标题\n------\nbody\n\n# End\ntail';
  const sections = parseMarkdownSections(body);
  assert.deepEqual(sections.map((s) => [s.sectionId, s.parentId, s.headingPath]), [
    ['数学-ai', null, ['数学 AI']], ['子标题', '数学-ai', ['数学 AI', '子标题']], ['end', null, ['End']],
  ]);
  assert.equal(sections[0].bodyRange.startOffset, body.indexOf('# **'));
  assert.equal(sections[0].bodyRange.endOffset, body.indexOf('# End'));
  assert.equal(sections[0].bodyRange.startLine, 3);
  assert.equal(sections[0].bodyRange.coordinateSpace, 'render-markdown-v1');
  assert.equal(sections[0].contentHash, createHash('sha256').update(body.slice(body.indexOf('# **'), body.indexOf('# End'))).digest('hex'));
});

test('duplicate headings avoid natural suffix collisions globally including punctuation-only titles', () => {
  const sections = parseMarkdownSections('# A\n# A\n# A-2\n# A\n# !!!\n# ???\n# section-2');
  assert.deepEqual(sections.map((s) => s.sectionId), ['a', 'a-3', 'a-2', 'a-4', 'section', 'section-3', 'section-2']);
  assert.equal(new Set(sections.map((s) => s.sectionId)).size, sections.length);
});

test('fake headings and references in code, display math and inline math stay excluded', () => {
  const body = '# Real\n\n```md\n# fake\n[[fake]]\n```\n\n`# fake [[fake]]`\n\n$$\n# equation\n[[math]]\n$$\n\n$[[inline-math]]$\n\n[[Actual]]';
  assert.deepEqual(parseMarkdownSections(body).map((s) => s.title), ['Real']);
  assert.deepEqual(parseMarkdownReferenceTokens(body).map((r) => r.rawTarget), ['Actual']);
});

test('range explicitly follows shared display-math normalization rather than original file lines', () => {
  const body = '$$x = 1\ny = 2$$\n\n# After\n[[Target]]';
  const normalized = normalizeDisplayMath(body);
  assert.notEqual(normalized, body);
  const section = parseMarkdownSections(body)[0];
  assert.equal(section.bodyRange.startOffset, normalized.indexOf('# After'));
  assert.equal(section.bodyRange.startLine, 6);
  const token = parseMarkdownReferenceTokens(body)[0];
  assert.equal(token.bodyRange.startOffset, normalized.indexOf('[[Target]]'));
  assert.equal(token.bodyRange.startLine, 7);
});

test('local markdown, wiki, self sections and definition links retain source ranges and decoded targets', () => {
  const body = '[[Note#章节|名字]] [rel](../notes/A%20B.md#Some%20Heading) [self](#章节) [[#^block]]\n\n[ref][n]\n\n[n]: Note.md#Part';
  const tokens = parseMarkdownReferenceTokens(body);
  assert.deepEqual(tokens.map((r) => [r.rawTarget, r.targetPath, r.fragment, r.label, r.unsupportedBlock]), [
    ['Note#章节', 'Note', '章节', '名字', false],
    ['../notes/A%20B.md#Some%20Heading', '../notes/A B.md', 'Some Heading', 'rel', false],
    ['#章节', undefined, '章节', 'self', false],
    ['#^block', undefined, '^block', '#^block', true],
    ['Note.md#Part', 'Note.md', 'Part', 'ref', false],
  ]);
  assert.equal(body.slice(tokens[0].bodyRange.startOffset, tokens[0].bodyRange.endOffset), '[[Note#章节|名字]]');
  assert.equal(body.slice(tokens.at(-1)!.bodyRange.startOffset, tokens.at(-1)!.bodyRange.endOffset), '[ref][n]');
});

test('images, external URLs, escaped wiki syntax and attachment embeds do not become note references', () => {
  const body = '![image](image.png) ![[image.png]] [site](https://example.org/a#b) [mail](mailto:a@b.com) \\[[Escaped]] [[Real]]';
  assert.deepEqual(parseMarkdownReferenceTokens(body).map((r) => r.rawTarget), ['Real']);
});

test('unsafe schemes, controls, invalid URL encoding and absolute paths remain explicit unsafe tokens', () => {
  const tokens = parseMarkdownReferenceTokens('[[javascript:alert(1)]] [absolute](%2Fprivate.md) [control](a%00b) [bad](bad%ZZ) [[folder\\name]] [[Good.md]]');
  assert.deepEqual(tokens.map((r) => r.unsafe), [true, true, true, true, true, false]);
});

test('CRLF and Unicode coordinates remain JavaScript offsets and one-based rendered-input lines', () => {
  const body = '文字😀\r\n\r\n# 标题\r\n[[目标]]\r\n';
  const [section] = parseMarkdownSections(body);
  const [reference] = parseMarkdownReferenceTokens(body);
  assert.equal(section.bodyRange.startOffset, body.indexOf('# 标题'));
  assert.equal(section.bodyRange.startLine, 3);
  assert.equal(reference.bodyRange.startOffset, body.indexOf('[[目标]]'));
  assert.equal(reference.bodyRange.startLine, 4);
  assert.equal(reference.bodyRange.endLine, 4);
});

test('section hash changes only where its included section content changes', () => {
  const before = parseMarkdownSections('# A\nold\n# B\nstable');
  const after = parseMarkdownSections('# A\nnew\n# B\nstable');
  assert.notEqual(before[0].contentHash, after[0].contentHash);
  assert.equal(before[1].contentHash, after[1].contentHash);
  assert.deepEqual(parseMarkdownSections('no headings'), []);
});

test('percent-encoded hash belongs to the path until a literal fragment delimiter', () => {
  const [token] = parseMarkdownReferenceTokens('[name](A%23B.md#C%23D)');
  assert.equal(token.targetPath, 'A#B.md');
  assert.equal(token.fragment, 'C#D');
  assert.equal(token.rawTarget, 'A%23B.md#C%23D');
});

test('identical wiki and Markdown targets keep syntax and precise source order distinct', () => {
  const body = '\\[[#a]] [[#a]] [heading](#a) [[#a|last]]';
  const tokens = parseMarkdownReferenceTokens(body);
  assert.deepEqual(tokens.map((token) => [token.rawTarget, token.syntax, token.label]), [
    ['#a', 'wiki', '#a'], ['#a', 'markdown', 'heading'], ['#a', 'wiki', 'last'],
  ]);
  assert.deepEqual(tokens.map((token) => body.slice(token.bodyRange.startOffset, token.bodyRange.endOffset)), [
    '[[#a]]', '[heading](#a)', '[[#a|last]]',
  ]);
});

test('shared wiki scanner respects escaped delimiters, preserves embeds and raw target spelling', () => {
  const raw = '\\[[Skip]] \\\\[[Keep%20Name| Label ]] ![[image.png|20]] [[Last]]';
  assert.deepEqual(scanWikiReferences(raw).map(({ target, label, embedded }) => ({ target, label, embedded })), [
    { target: 'Keep%20Name', label: 'Label', embedded: false },
    { target: 'image.png', label: '20', embedded: true },
    { target: 'Last', label: 'Last', embedded: false },
  ]);
});

test('wiki paths and fragments preserve literal percent spelling while Markdown URLs decode once', () => {
  const tokens = parseMarkdownReferenceTokens('[[A%20B.md#C%20D]] [URL](A%20B.md#C%20D) [[bad%ZZ]] [[%2Fprivate.md]]');
  assert.deepEqual(tokens.map((token) => [token.targetPath, token.fragment, token.unsafe]), [
    ['A%20B.md', 'C%20D', false], ['A B.md', 'C D', false], ['bad%ZZ', undefined, false], ['%2Fprivate.md', undefined, false],
  ]);
});

test('content block IDs and section affiliation match normalized Chinese and duplicate section coordinates', () => {
  const markdown = '$$x=1\r\ny=2$$\r\n\r\n# 中文\r\n\r\n正文😀\r\n\r\n## 重复\r\n\r\n一\r\n\r\n## 重复\r\n\r\n二\r\n\r\n## 重复-2\r\n\r\n三';
  const normalized = normalizeDisplayMath(markdown);
  const blocks = parseMarkdownContentBlocks(markdown, 'body');
  assert.deepEqual(blocks.map((block) => [block.kind, block.sectionId]), [
    ['heading', '中文'], ['paragraph', '中文'], ['heading', '重复'], ['paragraph', '重复'],
    ['heading', '重复-3'], ['paragraph', '重复-3'], ['heading', '重复-2'], ['paragraph', '重复-2'],
  ]);
  for (const block of blocks) {
    assert.equal(block.blockId, `block-body-${block.bodyRange.startOffset}-${block.bodyRange.endOffset}`);
    assert.equal(block.bodyRange.coordinateSpace, 'render-markdown-v1');
    assert.ok(normalized.slice(block.bodyRange.startOffset, block.bodyRange.endOffset).trim());
  }
  assert.equal(blocks[0].bodyRange.startLine, 6);
  const summary = parseMarkdownContentBlocks(markdown, 'summary');
  assert.ok(summary.every((block) => block.sectionId === undefined));
  assert.notEqual(summary[0].blockId, blocks[0].blockId);
  assert.deepEqual(summary[0].bodyRange, blocks[0].bodyRange);
});

test('selected list items and tables form nonoverlapping blocks without descendant paragraph reports', () => {
  const markdown = '# 目录\n\n- outer\n  - nested\n\n- second\n\n| A | B |\n|---|---|\n| one | two |\n\n```ts\n# fake heading\nconst x = 1;\n```';
  const blocks = parseMarkdownContentBlocks(markdown, 'body');
  assert.deepEqual(blocks.map((block) => block.kind), ['heading', 'list-item', 'list-item', 'table', 'code']);
  for (let index = 1; index < blocks.length; index += 1) assert.ok(blocks[index - 1].bodyRange.endOffset <= blocks[index].bodyRange.startOffset);
  assert.equal(blocks[1].sectionId, '目录');
  assert.match(markdown.slice(blocks[1].bodyRange.startOffset, blocks[1].bodyRange.endOffset), /nested/);
  assert.deepEqual(parseMarkdownSections(markdown).map((section) => section.title), ['目录']);
});

test('Mermaid, HTML, display math, footnotes and pure media paragraphs do not become visible text blocks', () => {
  const markdown = [
    '```MeRmAiD\ngraph TD; A --> B\n```', '<div>HTML only</div>', '$$\nx = 1\n$$',
    '![image](asset.png)', '![[asset.png|20]]', '![[note embed]]', '&nbsp; ![[asset.png]]', '[![image](asset.png)](https://example.org)',
    '[^hidden]: footnote definition', 'Text with ![image](asset.png) and an ordinary sentence.',
  ].join('\n\n');
  const blocks = parseMarkdownContentBlocks(markdown, 'body');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'paragraph');
  assert.match(markdown.slice(blocks[0].bodyRange.startOffset, blocks[0].bodyRange.endOffset), /^Text with/);
  assert.equal(blocks[0].sectionId, undefined);
  assert.equal(parseMarkdownContentBlocks('\\![[literal media spelling]]', 'body').length, 1);
});

test('pure image headings and all-media tables remain navigable structure without reporting text blocks', () => {
  const markdown = '# ![image heading](asset.png)\n\n| ![image cell](asset.png) |\n| --- |\n| ![[image.png]] |';
  assert.deepEqual(parseMarkdownContentBlocks(markdown, 'body'), []);
  assert.deepEqual(parseMarkdownSections(markdown).map((section) => section.title), ['image heading']);
});

test('browser plugin and server parser mark exactly the same nodes using the supplied normalized source', () => {
  const markdown = '# A\n\nText\n\n- first\n  - nested\n\n```js\n42\n```';
  const normalized = normalizeDisplayMath(markdown);
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(normalized);
  const expected = parseMarkdownContentBlocks(markdown, 'body');
  remarkKnowledgeContentBlocks({ contentPart: 'body' })(tree, { value: normalized });
  const actual: string[] = [];
  const walk = (node: any) => {
    if (node.data?.hProperties?.['data-knowledge-block']) actual.push(node.data.hProperties['data-knowledge-block']);
    node.children?.forEach(walk);
  };
  walk(tree);
  assert.deepEqual(actual, expected.map((block) => block.blockId));
  assert.deepEqual(assignKnowledgeContentBlocks(tree, normalized, 'body'), expected);
});

test('invalid or absent positions produce no block and a spanning block is not assigned a partial child section', () => {
  const content = '# A\ntext\n## B\nmore';
  const tree = { type: 'root', children: [
    { type: 'heading', depth: 1, children: [{ type: 'text', value: 'A' }], position: { start: { offset: 0 }, end: { offset: 3 } } },
    { type: 'paragraph', children: [{ type: 'text', value: 'spanning' }], position: { start: { offset: 4 }, end: { offset: content.length } } },
    { type: 'heading', depth: 2, children: [{ type: 'text', value: 'B' }], position: { start: { offset: 9 }, end: { offset: 13 } } },
    { type: 'paragraph', children: [{ type: 'text', value: 'no position' }] },
    { type: 'paragraph', children: [{ type: 'text', value: 'empty range' }], position: { start: { offset: 8 }, end: { offset: 8 } } },
  ] };
  const blocks = assignKnowledgeContentBlocks(tree, content, 'body');
  assert.equal(blocks.length, 3);
  assert.equal(blocks[1].sectionId, 'a'); // The entire block fits A, not its child B.
});
