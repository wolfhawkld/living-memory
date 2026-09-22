import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from '../src/web/MarkdownContent.js';
import { normalizeDisplayMath } from '../src/web/markdown-math.js';

function render(content: string): string {
  return renderToStaticMarkup(createElement(MarkdownContent, { content }));
}

test('canonicalizes attached display delimiters at top level and with up to three spaces', () => {
  const content = [
    '$$\\frac{1}{2}',
    '+ \\sqrt{x}$$',
    '',
    '   $$a^2',
    '+b^2=c^2$$',
  ].join('\n');

  assert.equal(normalizeDisplayMath(content), [
    '$$',
    '\\frac{1}{2}',
    '+ \\sqrt{x}',
    '$$',
    '',
    '   $$',
    '   a^2',
    '+b^2=c^2',
    '   $$',
  ].join('\n'));
});

test('preserves canonical display math, inline math, and same-line double-dollar text', () => {
  const content = [
    '$$',
    '\\frac{a}{b}',
    '$$',
    '',
    'Inline $x$ and same-line $$x$$ stay unchanged.',
  ].join('\n');

  assert.equal(normalizeDisplayMath(content), content);
});

test('does not rewrite dollar examples inside backtick, tilde, or multiline inline-code spans', () => {
  const content = [
    '```text',
    '$$backtick fence',
    'formula$$',
    '```',
    '',
    '~~~text',
    '   $$tilde fence',
    'formula$$',
    '~~~',
    '',
    'Use ``a multiline example:',
    '$$multiline inline',
    'code$$',
    'end`` as an example.',
    '',
    '$$real',
    'formula$$',
  ].join('\n');

  assert.equal(normalizeDisplayMath(content), [
    '```text',
    '$$backtick fence',
    'formula$$',
    '```',
    '',
    '~~~text',
    '   $$tilde fence',
    'formula$$',
    '~~~',
    '',
    'Use ``a multiline example:',
    '$$multiline inline',
    'code$$',
    'end`` as an example.',
    '',
    '$$',
    'real',
    'formula',
    '$$',
  ].join('\n'));
});

test('renders a complete attached formula before the reference heading and external source link', () => {
  const content = [
    '# Synthetic concept',
    '',
    '$$\\frac{1}{2}',
    '+\\sqrt{x}$$',
    '',
    '## 参考资料',
    '',
    '- [[raw/human_ai_knowledge/example.md]] | [🌐 HTML](https://example.com/article.html)',
  ].join('\n');
  const html = render(content);

  assert.match(html, /class="katex-display"/);
  assert.match(html, /<mfrac>/);
  assert.match(html, /<msqrt>/);
  assert.doesNotMatch(html, /katex-error/);
  assert.match(html, /<h2[^>]*>参考资料<\/h2>/);
  assert.match(html, /raw\/human_ai_knowledge\/example\.md/);
  assert.match(html, /<a href="https:\/\/example\.com\/article\.html" target="_blank" rel="noopener noreferrer">🌐 HTML<\/a>/);
  assert.doesNotMatch(html, /href="raw\/human_ai_knowledge\/example\.md"/);
});

test('does not let an unmatched attached opener swallow later source links', () => {
  const content = [
    '# Synthetic concept',
    '',
    '$$unmatched display opener',
    '',
    '## 参考资料',
    '',
    '- [[raw/human_ai_knowledge/example.md]] | [🌐 HTML](https://example.com/unmatched.html)',
  ].join('\n');
  const html = render(content);

  assert.match(html, /<h2[^>]*>参考资料<\/h2>/);
  assert.match(html, /<a href="https:\/\/example\.com\/unmatched\.html" target="_blank" rel="noopener noreferrer">🌐 HTML<\/a>/);
});
