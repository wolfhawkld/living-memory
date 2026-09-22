import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from '../src/web/MarkdownContent.tsx';
import { markdownImageUrl, type MarkdownMediaSource } from '../src/web/markdown-media.ts';

const source: MarkdownMediaSource = { sourceId: 'source-a', conceptId: 'concept/中文', sourceRevision: 'sha256:revision-a' };
const render = (content: string) => renderToStaticMarkup(createElement(MarkdownContent, { content, source }));
function imageUrls(html: string): URL[] {
  return [...html.matchAll(/<img\b[^>]*src="([^"]+)"/g)].map((match) => new URL(match[1].replaceAll('&amp;', '&'), 'http://local.invalid'));
}

test('local image URLs carry source, concept and revision instead of using the app base URL', () => {
  const path = '../附件/数学 图%23一.png';
  const url = new URL(markdownImageUrl(path, source)!, 'http://local.invalid');
  assert.equal(url.pathname, `/api/concepts/${encodeURIComponent(source.conceptId)}/attachment`);
  assert.equal(url.searchParams.get('path'), path);
  assert.equal(url.searchParams.get('sourceId'), source.sourceId);
  assert.equal(url.searchParams.get('sourceRevision'), source.sourceRevision);
  assert.notEqual(markdownImageUrl(path, source), markdownImageUrl(path, { ...source, sourceId: 'source-b' }));
  assert.equal(markdownImageUrl(path), null);
});

test('images permit http/https but refuse scripts, data, absolute drive and UNC references', () => {
  assert.equal(markdownImageUrl('https://example.com/image.png'), 'https://example.com/image.png');
  assert.equal(markdownImageUrl('http://example.com/image.svg'), 'http://example.com/image.svg');
  for (const path of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'file:///tmp/a.png', 'C:\\private\\a.png', '//host/share/a.png', '\\\\host\\share\\a.png', 'https://user:pass@example.com/a.png', 'a\n.png']) {
    assert.equal(markdownImageUrl(path, source), null, path);
  }
});

test('standard Markdown images and Obsidian embeds resolve through the attachment API', () => {
  const html = render('![数学图](<../附件/数学 图.png>)\n\n![[示意图.svg|320]]\n\n![[assets/a.webp|示例图]]');
  const urls = imageUrls(html);
  assert.equal(urls.length, 3);
  assert.ok(urls.every((url) => url.pathname.endsWith('/attachment')));
  assert.deepEqual(urls.map((url) => decodeURIComponent(url.searchParams.get('path')!)), ['../附件/数学 图.png', '![[示意图.svg]]', '![[assets/a.webp]]']);
  assert.match(html, /width="320"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/i);
  assert.match(html, /alt="示例图"/);
  assert.doesNotMatch(html, /!\[\[/);
});

test('external images render directly while wiki syntax inside code stays literal', () => {
  const html = render('![remote](https://example.com/image.png)\n\n`![[private.png]]`\n\n```text\n![[literal.png]]\n```');
  const urls = imageUrls(html);
  assert.equal(urls.length, 1);
  assert.equal(urls[0].href, 'https://example.com/image.png');
  assert.match(html, /!\[\[private\.png\]\]/);
  assert.match(html, /!\[\[literal\.png\]\]/);
});

test('wiki targets preserve literal percent filenames while Markdown keeps URL encoding', () => {
  const urls = imageUrls(render('![[附件/进度%20图.png]]\n\n![百分号](assets/progress%2520.png)'));
  assert.equal(urls.length, 2);
  assert.equal(urls[0].searchParams.get('path'), '![[附件/进度%20图.png]]');
  assert.equal(urls[1].searchParams.get('path'), 'assets/progress%2520.png');
});

test('only Mermaid fences mount the diagram widget; ordinary code and inline code remain code', () => {
  const html = render('```mermaid\nflowchart LR\n A --> B\n```\n\n```js\nconst mermaid = 1;\n```\n\n`mermaid`');
  assert.equal((html.match(/aria-label="Mermaid 图表"/g) ?? []).length, 1);
  assert.match(html, /正在渲染图表/);
  assert.match(html, /显示原代码/);
  assert.match(html, /language-js/);
  assert.match(html, /const mermaid = 1;/);
  assert.doesNotMatch(html, /<pre[^>]*><section/);
});
