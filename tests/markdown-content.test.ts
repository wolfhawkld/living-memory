import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from '../src/web/MarkdownContent.js';

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
