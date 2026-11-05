import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withExternalReferenceBudget } from '../src/server/feishu-reference-cards.js';
import { cardButton, cardMarkdown, styledFeishuCard, type NativeCardElement } from '../src/server/feishu-card-style.js';
import { cardButtons, cardElements } from './helpers/feishu-card-elements.js';

const items = Array.from({ length: 3 }, (_, index) => ({ label: `Source ${index + 1}`,
  hostname: 'example.org', href: `https://example.org/${index}?q=${'x'.repeat(980)}` }));
const builder = (body: string) => (id: string, references: readonly NativeCardElement[]) =>
  styledFeishuCard({ title: 'Synthetic reading', elements: [cardMarkdown(body), ...references, cardButton(id, 'a0', '返回原列表')] });
const urls = (card: ReturnType<ReturnType<typeof builder>>) => cardButtons(card).filter(button => button.behaviors[0].type === 'open_url');

test('external references expose real hosts with inert labels and native URL-only buttons', () => {
  const build = withExternalReferenceBudget({ items: [{ ...items[0], label: '<at id=all>[fake](https://other.example)😀\ud800' }], hasMore: false }, builder('required'));
  const card = build('c'.repeat(64));
  assert.deepEqual(urls(card)[0].behaviors, [{ type: 'open_url', default_url: items[0].href }]);
  assert.deepEqual(cardButtons(card).filter(button => button.behaviors[0].type === 'callback').map(button => button.behaviors[0].value.actionId), ['a0']);
  const text = cardElements(card).filter(element => element.tag === 'markdown').map(element => element.content).join('\n');
  assert.match(text, /example\.org/);
  assert.doesNotMatch(text, /<at|\]\(/);
  assert.match(text, /😀�/u);
});

test('reference budget removes optional trailing URLs without changing body or callback navigation', () => {
  const body = 'required'.repeat(2250);
  const build = withExternalReferenceBudget({ items, hasMore: false }, builder(body));
  const card = build('c'.repeat(64));
  assert.ok(urls(card).length > 0 && urls(card).length < 3);
  assert.deepEqual(urls(card).map(button => button.behaviors[0].default_url), items.slice(0, urls(card).length).map(item => item.href));
  assert.equal(cardElements(card).find(element => element.tag === 'markdown')!.content, body);
  assert.equal(cardButtons(card).at(-1)!.behaviors[0].value.actionId, 'a0');
  assert.ok(Buffer.byteLength(JSON.stringify(card)) <= 20 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify({ content: JSON.stringify(card) })) <= 23 * 1024);
  assert.match(JSON.stringify(card), /打开按钮数量有限/);
  assert.deepEqual(urls(build('short-id')).map(button => button.behaviors), urls(card).map(button => button.behaviors), 'selection is fixed with room reserved for a real card ID');
});

test('wire escaping also limits optional references and never removes required content', () => {
  const body = '\\'.repeat(5550);
  const build = withExternalReferenceBudget({ items, hasMore: true }, builder(body));
  const card = build('c'.repeat(64));
  assert.ok(urls(card).length < 3);
  assert.equal(cardElements(card).find(element => element.tag === 'markdown')!.content, body);
  assert.ok(Buffer.byteLength(JSON.stringify({ content: JSON.stringify(card) })) <= 23 * 1024);
});

test('an already oversized base card is preserved for the existing rejection path', () => {
  const original = builder('required'.repeat(3100));
  const build = withExternalReferenceBudget({ items, hasMore: false }, original);
  assert.deepEqual(build('c'.repeat(64)), original('c'.repeat(64), []));
});
