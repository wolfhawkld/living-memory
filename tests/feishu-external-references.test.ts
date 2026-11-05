import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractFeishuExternalReferences as extract } from '../src/server/feishu-external-references.js';

test('extracts synthetic HTML reference beside wiki links without guessing wiki targets', () => {
  assert.deepEqual(extract('[[Topic]] [🌐HTML](https://example.org/topic.html)'), {
    items: [{ label: '🌐HTML', href: 'https://example.org/topic.html', hostname: 'example.org' }], hasMore: false,
  });
});

test('resolves full, collapsed and shortcut references in occurrence order using first definitions', () => {
  const source = '[Second][b] [a][] [b]\n\n[a]: https://a.example/path\n[b]: https://b.example/path\n[b]: https://ignored.example/';
  assert.deepEqual(extract(source).items.map(({ label, hostname }) => [label, hostname]), [
    ['Second', 'b.example'], ['a', 'a.example'],
  ]);
  assert.deepEqual(extract('[unused]: https://unused.example/'), { items: [], hasMore: false });
});

test('ignores code, math, raw HTML, images and bare URL text', () => {
  const source = [
    '`[code](https://code.example/)`', '```md\n[fenced](https://fenced.example/)\n```',
    '$[math](https://math.example/)$', '$$[display](https://display.example/)\n+x$$',
    '<a href="https://html.example/">HTML</a>', '<span>text</span> [same paragraph](https://same.example/)',
    '![alt](https://image.example/)', '![ref][image]\n\n[image]: https://image-ref.example/',
    '[![nested alt](https://image.example/)](https://wrapped.example/)',
    '[**![nested format](https://image.example/)**](https://wrapped-format.example/)', 'https://bare.example/',
  ].join('\n\n');
  assert.deepEqual(extract(source), { items: [], hasMore: false });
});

test('label includes visible AST text and formatting while excluding code, math and image descriptions', () => {
  const source = '[**Hello** &amp; \\[world\\] `hidden` $x$ ![hidden image](https://image.example/)](https://example.org/)';
  assert.equal(extract(source).items[0].label, 'Hello & [world]');
  assert.equal(extract('[](https://example.org/) [ ](https://example.org/)').items.length, 0);
  assert.equal(extract('[<b>HTML</b>](https://example.org/)').items.length, 0);
});

test('requires HTTPS absolute URLs and rejects credentials, whitespace, controls and backslashes', () => {
  for (const url of ['http://example.org/', 'javascript:alert(1)', '/local/path', '//example.org/',
    'https://user:password@example.org/', 'https://user@example.org/', 'https://@example.org/', 'https://:@example.org/', 'https://example.org/a&#32;b',
    'https://example.org/a&#9;b', 'https://example.org/a&#1;b', String.raw`https://example.org/a\\b`]) {
    assert.deepEqual(extract(`[bad](<${url}>)`), { items: [], hasMore: false }, url);
  }
});

test('requires an explicit nonempty HTTPS authority without WHATWG slash repair', () => {
  for (const url of ['https:example.org', 'https:/example.org', 'https:///example.org',
    'https:////example.org', 'https://', 'https://?example.org', 'https://#example.org']) {
    assert.deepEqual(extract(`[bad](<${url}>)`), { items: [], hasMore: false }, url);
  }
  assert.equal(extract('[valid](HTTPS://EXAMPLE.ORG:443/path)').items[0].href, 'https://example.org/path');
});

test('rejects empty hostname labels after allowing one final DNS dot', () => {
  for (const host of ['foo.local..', 'foo.localhost..', '.example.org', 'example..org', 'example.org..']) {
    assert.deepEqual(extract(`[bad](https://${host}/)`), { items: [], hasMore: false }, host);
  }
  assert.equal(extract('[valid](https://example.org./path)').items[0].href, 'https://example.org./path');
});

test('rejects local names, IP addresses and alternate numeric IP spellings after URL normalization', () => {
  for (const host of ['localhost', 'localhost.', 'service', 'a.local', 'a.local.', 'a.localhost', 'a.localhost.',
    '127.0.0.1', '192.168.1.1', '8.8.8.8', '[::1]', '[2001:4860:4860::8888]', '2130706433',
    '0x7f000001', '0177.0.0.1', '127.1', '127.0.0.1.']) {
    assert.equal(extract(`[bad](https://${host}/)`).items.length, 0, host);
  }
});

test('preserves canonical path, query and hash including signed parameters and decoded entities', () => {
  const href = 'https://EXAMPLE.org:443/a/../topic.html?token=abc&amp;x=1#part';
  assert.equal(extract(`[reference](${href})`).items[0].href, 'https://example.org/topic.html?token=abc&x=1#part');
  assert.equal(extract(String.raw`[escaped](https://example.org/a\(b\))`).items[0].href, 'https://example.org/a(b)');
});

test('deduplicates canonical URLs, preserves first label and caps at three distinct eligible targets', () => {
  const first = '[first](https://EXAMPLE.org:443/a) [duplicate](https://example.org/a)';
  const three = `${first} [second](https://second.example/) [third](https://third.example/)`;
  assert.deepEqual(extract(three).items.map(item => item.label), ['first', 'second', 'third']);
  assert.equal(extract(`${three} [duplicate](https://third.example/) [bad](http://fourth.example/)`).hasMore, false);
  const capped = extract(`${three} [fourth](https://fourth.example/)`);
  assert.equal(capped.items.length, 3);
  assert.equal(capped.hasMore, true);
});

test('enforces UTF8 byte limits for both decoded and canonical URLs', () => {
  const prefix = 'https://example.org/';
  assert.equal(extract(`[ok](${prefix}${'a'.repeat(1024 - prefix.length)})`).items.length, 1);
  assert.equal(extract(`[long](${prefix}${'a'.repeat(1025 - prefix.length)})`).items.length, 0);
  assert.equal(extract(`[unicode](${prefix}${'中'.repeat(200)})`).items.length, 0, 'canonical percent encoding exceeds 1024 bytes');
  assert.equal(extract(`[unicode](${prefix}${'😀'.repeat(300)})`).items.length, 0, 'input UTF8 exceeds 1024 bytes');
});

test('handles lone surrogates, oversized input and invalid runtime inputs without throwing', () => {
  assert.deepEqual(extract('[bad](https://example.org/\ud800)'), { items: [], hasMore: false });
  assert.deepEqual(extract('[bad](https://example.org/\u0000)'), { items: [], hasMore: false });
  assert.deepEqual(extract('[bad](https://example.org/\ufffd)'), { items: [], hasMore: false });
  assert.equal(extract('[label\ud800](https://example.org/)').items[0].label, 'label\ud800');
  assert.deepEqual(extract('x'.repeat(1024 * 1024 + 1)), { items: [], hasMore: false });
  assert.deepEqual(extract(null as unknown as string), { items: [], hasMore: false });
});
