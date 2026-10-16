import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from '../src/web/MarkdownContent.js';
import type { KnowledgeReference } from '../src/shared/knowledge-references.ts';

function render(content: string, compact = false): string {
  return renderToStaticMarkup(createElement(MarkdownContent, { content, compact }));
}

test('renders headings, GFM lists/tasks/tables, quotes, code, and readable wiki labels', () => {
  const html = render([
    '# Overview',
    '',
    'A paragraph with **emphasis** and `inline code`.',
    '',
    '- one',
    '- two',
    '- [x] finished',
    '',
    '> A useful quote.',
    '',
    '| Name | Value |',
    '| --- | ---: |',
    '| alpha | 1 |',
    '',
    '```ts',
    'const veryLongName = "kept as code";',
    '```',
    '',
    'See [[Target note|Target label]] and [[Second note]].',
  ].join('\n'));

  assert.match(html, /<h1[^>]*id="[^"]+-overview"/);
  assert.match(html, /<strong>emphasis<\/strong>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /checked/);
  assert.match(html, /<table>/);
  assert.match(html, /markdown-content-table-wrap/);
  assert.match(html, /<pre class="markdown-content-pre"><code/);
  assert.match(html, /language-ts/);
  assert.match(html, /Target label/);
  assert.match(html, /Second note/);
  assert.doesNotMatch(html, /\[\[Target note\|Target label\]\]/);
});

test('renders KaTeX math and keeps invalid formulas readable without throwing', () => {
  const html = render([
    'Inline formula $x^2 + y^2 = z^2$.',
    '',
    '$$',
    '\\frac{1}{2} + \\sqrt{x}',
    '$$',
    '',
    'Invalid formula $\\notARealCommand{x}$.',
  ].join('\n'));

  assert.match(html, /class="katex/);
  assert.match(html, /katex-display/);
  assert.match(html, /katex-error|notARealCommand/);
});

test('sanitizes HTML, dangerous and relative URLs, while preserving safe link behavior', () => {
  const html = render([
    '<script>alert("xss")</script>',
    '',
    '[danger](javascript:alert(1))',
    '[local](notes/concept.md)',
    '[web](https://example.com/very-long-name)',
    '[mail](mailto:reader@example.com)',
    '[jump](#overview)',
    '',
    '![diagram](../assets/diagram.png)',
  ].join('\n'));

  assert.doesNotMatch(html, /<script|javascript:/i);
  assert.doesNotMatch(html, /href="notes\/concept\.md"/);
  assert.match(html, /danger/);
  assert.match(html, /local/);
  assert.match(html, /链接暂不可用/);
  assert.match(html, /href="https:\/\/example\.com\/very-long-name"[^>]*target="_blank"/);
  assert.match(html, /href="mailto:reader@example\.com"[^>]*target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /href="#overview"/);
  assert.match(html, /href="#[^"]+-overview"/);
  assert.doesNotMatch(html, /<img\b/);
  assert.match(html, /图片：diagram/);
});

test('keeps wiki syntax inside code and math untouched and exposes compact mode', () => {
  const html = render([
    '`[[InlineCode]]`',
    '',
    '```text',
    '[[CodeBlock]]',
    '```',
    '',
    '$[[math-token]]$',
  ].join('\n'), true);

  assert.match(html, /markdown-content markdown-content-compact/);
  assert.match(html, /\[\[InlineCode\]\]/);
  assert.match(html, /\[\[CodeBlock\]\]/);
  assert.match(html, /math-token|katex-error/);
});

test('scopes duplicate SSR instances and keeps local heading links inside their own copy', () => {
  const content = '# Overview\n\n[Jump to overview](#overview)';
  const html = renderToStaticMarkup(createElement('main', null,
    createElement(MarkdownContent, { content }),
    createElement(MarkdownContent, { content }),
  ));
  const headingIds = [...html.matchAll(/<h1[^>]*id="([^"]+)"/g)].map((match) => match[1]);
  const localHrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);

  assert.equal(headingIds.length, 2);
  assert.equal(new Set(headingIds).size, 2);
  assert.deepEqual(localHrefs, headingIds);
  assert.match(headingIds[0] ?? '', /-overview$/);
  assert.match(headingIds[1] ?? '', /-overview$/);
});

test('scopes GFM footnote ids and back references as a working local graph', () => {
  const html = render('A statement with a note.[^1]\n\n[^1]: The footnote stays local.');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const localHrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);

  assert.match(html, /脚注|footnote/i);
  assert.ok([...ids].some((id) => id.endsWith('-user-content-fn-1')));
  assert.ok([...ids].some((id) => id.endsWith('-user-content-fnref-1')));
  assert.ok(localHrefs.length >= 2);
  for (const href of localHrefs) assert.ok(ids.has(href), `missing local target ${href}`);
});

test('assigns stable in-page ids for duplicate long headings without rendering overflow-prone markup', () => {
  const longHeading = 'A very long heading '.repeat(24);
  const html = render(`## ${longHeading}\n\n## ${longHeading}`);

  assert.match(html, /id="[^"]+-a-very-long-heading-/);
  assert.match(html, /id="[^"]+-a-very-long-heading-.*-2"/);
  assert.match(html, /markdown-content/);
});

test('rendered heading section ids match normalized parser metadata across collisions, math and wiki headings', async () => {
  const { parseMarkdownSections } = await import('../src/core/markdown-sections.ts');
  const content = '# A\n\n# A\n\n# A-2\n\n## [[Target|Label]]\n\n$$x\n+y$$\n\n## **格式** $z$';
  const expected = parseMarkdownSections(content).map((section) => section.sectionId);
  const html = render(content);
  const actual = [...html.matchAll(/data-knowledge-section="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(actual, expected);
  assert.equal(new Set(actual).size, actual.length);
});

test('controlled knowledge references render buttons without exposing filesystem or unsafe hrefs', async () => {
  const { parseMarkdownReferenceTokens } = await import('../src/core/markdown-sections.ts');
  const content = '[[Other#Detail|Wiki]] [document](Other.md#Detail) [unsafe](file:///private/secret.md)';
  const references = parseMarkdownReferenceTokens(content).map((token, index) => ({
    referenceId: `r-${index}`, sourceConceptId: 'c', sourceRevision: 'v1', rawTarget: token.rawTarget, syntax: token.syntax,
    label: token.label, bodyRange: token.bodyRange, status: 'unsafe' as const,
  }));
  const html = renderToStaticMarkup(createElement(MarkdownContent, { content, references, onNavigateReference() {} }));
  assert.equal((html.match(/class="markdown-reference-link"/g) ?? []).length, 3);
  assert.doesNotMatch(html, /href=|file:|private\/secret/);
  assert.match(html, />Wiki<\/button>/);
});

test('internal section navigation is controlled while safe external links remain external', () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    content: '# Overview\n\n[jump](#overview) [external](https://example.com)', onNavigateSection() {},
  }));
  assert.match(html, /<button[^>]*class="markdown-reference-link"[^>]*>jump<\/button>/);
  assert.match(html, /href="https:\/\/example.com"[^>]*target="_blank"/);
  assert.doesNotMatch(html, /href="#/);
});

test('controlled chapter navigation preserves scoped GFM footnote links', () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    content: 'A note.[^1]\n\n[^1]: Footnote.', onNavigateSection() {},
  }));
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  assert.ok(hrefs.length >= 2);
  for (const href of hrefs) assert.ok(ids.has(href));
});

test('reference metadata alone never enables uncontrolled local document navigation', async () => {
  const { parseMarkdownReferenceTokens } = await import('../src/core/markdown-sections.ts');
  const content = '[document](Other.md)';
  const token = parseMarkdownReferenceTokens(content)[0]!;
  const html = renderToStaticMarkup(createElement(MarkdownContent, { content, references: [{
    referenceId: 'r', sourceConceptId: 'c', sourceRevision: 'v1', rawTarget: token.rawTarget, syntax: token.syntax,
    label: token.label, bodyRange: token.bodyRange, status: 'resolved-document', targetConceptId: 'other', targetRevision: 'v2',
  }] }));
  assert.doesNotMatch(html, /href=|<button/);
  assert.match(html, /链接暂不可用/);
});

test('source positions and syntax bind repeated identical targets to their own resolver result', async () => {
  const { parseMarkdownReferenceTokens } = await import('../src/core/markdown-sections.ts');
  const content = '# A\n\n# A\n\n[[#a|wiki]] [slug](#a) [[#a|again]]';
  const references: KnowledgeReference[] = parseMarkdownReferenceTokens(content).map((token, index) => ({
    referenceId: `ref-${index}`, sourceConceptId: 'c', sourceRevision: 'v', rawTarget: token.rawTarget,
    syntax: token.syntax, label: token.label, bodyRange: token.bodyRange,
    status: token.syntax === 'wiki' ? 'ambiguous' : 'resolved-section',
  }));
  const html = renderToStaticMarkup(createElement(MarkdownContent, { content, references, onNavigateReference() {} }));
  const bound = [...html.matchAll(/data-reference-id="([^"]+)"[^>]*>([^<]+)<\/button>/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(bound, [['ref-0', 'wiki'], ['ref-1', 'slug'], ['ref-2', 'again']]);
});

test('wiki source matching preserves escaped syntax, entities, Chinese and CRLF offsets', async () => {
  const { parseMarkdownReferenceTokens } = await import('../src/core/markdown-sections.ts');
  const content = '# 中文\r\n\r\n&amp; 前缀 \\[[Same]] [[Same|真实]]\r\n后面 [[Same|再次]]';
  const references: KnowledgeReference[] = parseMarkdownReferenceTokens(content).map((token, index) => ({
    referenceId: `ref-${index}`, sourceConceptId: 'c', sourceRevision: 'v', rawTarget: token.rawTarget,
    syntax: token.syntax, label: token.label, bodyRange: token.bodyRange, status: 'resolved-document',
  }));
  const html = renderToStaticMarkup(createElement(MarkdownContent, { content, references, onNavigateReference() {} }));
  assert.match(html, /&amp; 前缀 \[\[Same\]\]/);
  assert.match(html, /data-reference-id="ref-0"[^>]*>真实<\/button>/);
  assert.match(html, /data-reference-id="ref-1"[^>]*>再次<\/button>/);
  assert.equal((html.match(/data-reference-id=/g) ?? []).length, 2);
});

test('generated footnote headings never enter the source chapter coordinate space', async () => {
  const { parseMarkdownSections } = await import('../src/core/markdown-sections.ts');
  const content = '# Heading\n\nA note.[^1]\n\n[^1]: Note.';
  const html = render(content);
  const sections = [...html.matchAll(/data-knowledge-section="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(sections, parseMarkdownSections(content).map((section) => section.sectionId));
  assert.match(html, /footnote-label/);
});

test('source headings never collide with generated footnote ids or ARIA references', () => {
  const html = render('# footnote-label\n\n# user-content-fn-1\n\n[chapter](#footnote-label) [other chapter](#user-content-fn-1) A note.[^1]\n\n[^1]: Note.');
  const allIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const ids = new Set(allIds);
  assert.equal(ids.size, allIds.length);
  const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  for (const href of hrefs) assert.ok(ids.has(href), `missing link target ${href}`);
  for (const match of html.matchAll(/aria-(?:describedby|labelledby)="([^"]+)"/g)) {
    for (const target of match[1]!.split(/\s+/)) assert.ok(ids.has(target), `missing ARIA target ${target}`);
  }
  assert.match(html, /href="#[^"]+-section-footnote-label"[^>]*>chapter<\/a>/);
  assert.match(html, /href="#[^"]+-section-user-content-fn-1"[^>]*>other chapter<\/a>/);
  assert.match(html, /data-knowledge-section="footnote-label"/);
});

test('native encoded Chinese chapter fragments use the source heading namespace', () => {
  const html = render('# 中文章节\n\n[jump](#%E4%B8%AD%E6%96%87%E7%AB%A0%E8%8A%82)');
  const id = html.match(/<h1 id="([^"]+)"/)?.[1];
  const href = html.match(/href="#([^"]+)"/)?.[1];
  assert.equal(href, id);
  assert.match(id ?? '', /-section-中文章节$/);
});
