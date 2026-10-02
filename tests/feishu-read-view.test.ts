import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseFeishuReadCommand } from '../src/integrations/feishu-read-commands.js';
import { buildFeishuReadReferences, renderFeishuReadReply as render, type FeishuReadContext } from '../src/server/feishu-read-view.js';
import type { AnchorEvent, Concept, MemoryState } from '../src/shared/types.js';

const asOf = '2026-10-02T10:00:00.000Z';
function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }
function concept(id: string, path = 'Cognition/Math/note.md'): Concept {
  return { id, title: id, aliases: [], domain: 'untrusted-frontmatter', summary: '', body: `正文 ${id}`,
    source: { path, revision: `revision-${id}` } };
}
function state(id: string, status: MemoryState['status'], elapsedDays: number | null, anchor: AnchorEvent | null = null): MemoryState {
  return { conceptId: id, status, elapsedDays, decay: null, anchor, reason: null, asOf };
}
function context(concepts: Concept[]): FeishuReadContext { return { concepts, states: {}, anchors: [], asOf }; }
const all = { kind: 'list', domainId: null, query: '', sort: 'elapsed', page: 1 } as const;
function nextCommand(reply: string) { return reply.split('下一页：').at(-1)!; }

test('full index is paged by five and directory domains override metadata; filters and aliases compose', () => {
  const concepts = Array.from({ length: 13 }, (_, index) => concept(`id-${String(index).padStart(2, '0')}`, index < 11 ? 'AI models/note.md' : 'Math/note.md'));
  concepts.forEach((node) => { node.title = '同名'; node.aliases = ['Ａgent']; });
  const ctx = context(concepts);
  const command = { ...all, domainId: 'AI models', query: 'agent', sort: 'title' } as const;
  let reply = render(command, ctx);
  assert.match(reply, /11 节点/);
  assert.equal((reply.match(/阅读：知识 阅读/g) ?? []).length, 5);
  assert.match(reply, /目录域：AI models/);
  assert.doesNotMatch(reply, /untrusted-frontmatter/);
  const second = parseFeishuReadCommand(nextCommand(reply));
  assert.deepEqual(second, { ...command, page: 2 });
  reply = render(second!, ctx);
  assert.equal((reply.match(/阅读：知识 阅读/g) ?? []).length, 5);
  const third = parseFeishuReadCommand(nextCommand(reply));
  assert.deepEqual(third, { ...command, page: 3 });
  assert.equal((render(third!, ctx).match(/阅读：知识 阅读/g) ?? []).length, 1);
  assert.match(render({ ...command, page: 4 }, ctx), /超出范围/);
});

test('time sorting puts finite nonnegative values first, with stable IDs and all statuses visible', () => {
  const concepts = ['unknown', 'retained', 'pending', 'stale', 'recent'].map((id) => concept(id));
  const ctx = context(concepts);
  ctx.states = {
    unknown: state('unknown', 'unknown', null), retained: state('retained', 'retained', Infinity),
    pending: state('pending', 'pending', -1), stale: state('stale', 'stale', 20), recent: state('recent', 'recent', 2),
  };
  const reply = render(all, ctx);
  assert.ok(reply.indexOf('\n\nstale\n') < reply.indexOf('\n\nrecent\n'));
  assert.ok(reply.indexOf('\n\nrecent\n') < reply.indexOf('\n\npending\n'));
  for (const label of ['尚无时间锚点', '人工长期保持', '版本或时间待确认', '时间记录较久', '近期时间记录']) assert.ok(reply.includes(label));
  assert.match(reply, /距时间锚点 20.0 天/);
  assert.match(reply, /无有效时间记录/);
  assert.doesNotMatch(reply, /概率|Infinity/);
});

test('confirmed review uses current revision and both nonfuture timestamps, never an estimate', () => {
  const node = concept('node');
  const base: AnchorEvent = { eventId: 'real', conceptId: node.id, sourceRevision: node.source.revision,
    occurredAt: '2026-09-20T00:00:00.000Z', recordedAt: '2026-09-20T00:00:00.000Z', kind: 'review' };
  const estimated: AnchorEvent = { ...base, eventId: 'estimated', occurredAt: '2026-10-01T00:00:00.000Z', kind: 'estimated' };
  const ctx = context([node]);
  ctx.states = { node: state('node', 'recent', 1, estimated) };
  ctx.anchors = [base, estimated, { ...base, sourceRevision: 'old', occurredAt: '2026-10-01T01:00:00.000Z' },
    { ...base, occurredAt: '2026-10-03T00:00:00.000Z' }, { ...base, recordedAt: '2026-10-03T00:00:00.000Z' },
    { ...base, conceptId: 'other', occurredAt: '2026-10-01T00:00:00.000Z' }];
  const reply = render(all, ctx);
  assert.match(reply, /距估算时间锚点 1.0 天/);
  assert.match(reply, /最近确认重温：2026-09-20T00:00:00.000Z/);
  ctx.anchors = [estimated];
  assert.match(render(all, ctx), /无确认重温记录/);
});

test('own-index digest lookup accepts unique 12..64 prefixes and never falls back on a missing reference', () => {
  const node = concept('private-own');
  const ctx = context([node]);
  const hash = digest(node.id);
  for (const length of [12, 20, 64]) assert.match(render({ kind: 'read', reference: hash.slice(0, length), page: 1, revision: null }, ctx), /正文 private-own/);
  assert.match(render({ kind: 'read', reference: digest('other-private-node').slice(0, 12), page: 1, revision: null }, ctx), /不存在或不唯一/);
  const allocation = buildFeishuReadReferences([
    { id: 'one', digest: 'a'.repeat(12) + 'b'.repeat(52) }, { id: 'two', digest: 'a'.repeat(12) + 'c'.repeat(52) },
    { id: 'three', digest: 'd'.repeat(64) },
  ]);
  assert.equal(allocation.get('one'), 'a'.repeat(12) + 'b'.repeat(52));
  assert.equal(allocation.get('two'), 'a'.repeat(12) + 'c'.repeat(52));
  assert.equal(allocation.get('three'), 'd'.repeat(12));
  assert.match(render({ kind: 'read', reference: hash.slice(0, 12), page: 1, revision: null }, context([node, node])), /不存在或不唯一/);
});

test('Unicode Markdown body is fully recoverable across bounded versioned pages, with inert angles', () => {
  const node = concept('unicode');
  node.title = '<at user_id="all">' + '超长标题😀'.repeat(300);
  node.source.path = `${'领域😀'.repeat(300)}/note.md`;
  node.body = '# 原始 Markdown\n' + ('中文😀e\u0301 <tag>\n```mermaid\na-->b\n```\n![图](image.png)\n').repeat(210);
  const ctx = context([node]);
  const original = JSON.stringify(ctx);
  let command = { kind: 'read', reference: digest(node.id).slice(0, 12), page: 1, revision: null } as const;
  let joined = '';
  let count = 0;
  while (true) {
    const reply = render(command, ctx);
    assert.ok(Buffer.byteLength(reply) <= 8000);
    assert.doesNotMatch(reply, /<at|<tag>/);
    const body = reply.split('浏览不会更新记忆。尖括号以全角显示。\n\n')[1].split('\n\n下一页：')[0];
    assert.ok(Buffer.byteLength(body) <= 3000);
    assert.doesNotMatch(body, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    joined += body; count++;
    if (!reply.includes('下一页：')) break;
    const next = parseFeishuReadCommand(nextCommand(reply));
    assert.equal(next?.kind, 'read');
    command = next as typeof command;
  }
  assert.ok(count > 3);
  assert.equal(joined, node.body.replaceAll('<', '＜').replaceAll('>', '＞'));
  assert.equal(JSON.stringify(ctx), original);
});

test('changed source revision invalidates a continued body page, and range errors do not reset to page one', () => {
  const node = concept('versions'); node.body = '文'.repeat(2000);
  const ctx = context([node]);
  const first = render({ kind: 'read', reference: digest(node.id).slice(0, 12), page: 1, revision: null }, ctx);
  const next = parseFeishuReadCommand(nextCommand(first))!;
  node.source.revision = 'new-version';
  assert.match(render(next, ctx), /资料已变化或分页标识失效/);
  assert.match(render({ kind: 'read', reference: digest(node.id).slice(0, 12), page: 2, revision: null }, ctx), /分页标识失效/);
  assert.match(render({ kind: 'read', reference: digest(node.id).slice(0, 12), page: 100000,
    revision: digest(node.source.revision).slice(0, 12) }, ctx), /超出范围/);
});

test('domain pages include at most ten full-index domains, deterministic root handling, and bounded huge metadata', () => {
  const nodes = Array.from({ length: 12 }, (_, index) => concept(`domain-${index}`, `${'超长域😀'.repeat(80)}${index}/note.md`));
  nodes.push(concept('root', 'root.md'));
  const ctx = context(nodes);
  const reply = render({ kind: 'domains', page: 1 }, ctx);
  assert.match(reply, /13 个/);
  assert.ok((reply.match(/目录域：/g) ?? []).length <= 10);
  assert.ok(Buffer.byteLength(reply) <= 8000);
  assert.match(reply, /下一页：知识 领域 2/);
  let final = reply;
  while (final.includes('下一页：')) final = render(parseFeishuReadCommand(nextCommand(final))!, ctx);
  assert.match(final, /根目录/);
  assert.match(render({ kind: 'domains', page: 100000 }, ctx), /超出范围/);
  assert.match(render({ ...all, domainId: 'missing' }, ctx), /没有匹配节点/);
});

test('maximum logical domain/query remain usable through safe quoted continuation and serialized budgets', () => {
  for (const [domain, query] of [
    ['<'.repeat(512), '>'.repeat(120)],
    ['<>"\n'.repeat(128), '"\\<>\n'.repeat(24)],
  ]) {
    const nodes = Array.from({ length: 6 }, (_, index) => {
      const node = concept(`extreme-${index}`, `${domain}/note.md`);
      node.title = '"\\'.repeat(1000); node.aliases = [query]; return node;
    });
    const ctx = context(nodes);
    const command = { ...all, domainId: domain, query };
    const reply = render(command, ctx);
    assert.equal((reply.match(/阅读：知识 阅读/g) ?? []).length, 5);
    assert.ok(Buffer.byteLength(reply) <= 8000);
    assert.ok(Buffer.byteLength(JSON.stringify({ content: JSON.stringify({ text: reply }) })) <= 11000);
    const next = parseFeishuReadCommand(nextCommand(reply));
    assert.deepEqual(next, { ...command, page: 2 });
    assert.equal((render(next!, ctx).match(/阅读：知识 阅读/g) ?? []).length, 1);
  }
});

test('adaptive domain paging keeps every complete long-domain command selectable', () => {
  const nodes = Array.from({ length: 15 }, (_, index) => concept(`long-domain-${index}`, `${'<'.repeat(509)}${String(index).padStart(3, '0')}/note.md`));
  const ctx = context(nodes);
  const seen: string[] = [];
  let command = { kind: 'domains', page: 1 } as const;
  while (true) {
    const reply = render(command, ctx);
    assert.ok(Buffer.byteLength(reply) <= 8000);
    assert.ok(Buffer.byteLength(JSON.stringify({ content: JSON.stringify({ text: reply }) })) <= 11000);
    const commands = reply.split('\n').filter((line) => line.startsWith('查看：')).map((line) => line.slice(3));
    assert.ok(commands.length > 0 && commands.length <= 10);
    for (const wire of commands) {
      const parsed = parseFeishuReadCommand(wire);
      assert.equal(parsed?.kind, 'list');
      if (parsed?.kind === 'list') {
        seen.push(parsed.domainId!);
        assert.match(render(parsed, ctx), /1 节点/);
      }
    }
    if (!reply.includes('下一页：')) break;
    command = parseFeishuReadCommand(nextCommand(reply)) as typeof command;
  }
  assert.equal(seen.length, nodes.length);
  assert.equal(new Set(seen).size, nodes.length);
});

test('quote, backslash and control-heavy Markdown pages satisfy final JSON limits without losing content', () => {
  const node = concept('escaped-body');
  node.title = '"\\'.repeat(300);
  node.source.path = `${'"'.repeat(512)}/body.md`;
  node.body = '"\\\n\t\r\b\f'.repeat(1800);
  const ctx = context([node]);
  let command = { kind: 'read', reference: digest(node.id).slice(0, 12), page: 1, revision: null } as const;
  let joined = '';
  while (true) {
    const reply = render(command, ctx);
    assert.ok(Buffer.byteLength(reply) <= 8000);
    assert.ok(Buffer.byteLength(JSON.stringify({ content: JSON.stringify({ text: reply }) })) <= 11000);
    const body = reply.split('浏览不会更新记忆。尖括号以全角显示。\n\n')[1].split('\n\n下一页：')[0];
    assert.ok(Buffer.byteLength(body) <= 3000);
    joined += body;
    if (!reply.includes('下一页：')) break;
    command = parseFeishuReadCommand(nextCommand(reply)) as typeof command;
  }
  assert.equal(joined, node.body);
});

test('continued quoted filters keep exact angle-containing parameters without at markup', () => {
  const ctx = context(Array.from({ length: 6 }, (_, index) => {
    const node = concept(`angle-${index}`, '<domain>/note.md'); node.aliases = ['<query>']; return node;
  }));
  const command = { ...all, domainId: '<domain>', query: '<query>' };
  const reply = render(command, ctx);
  assert.doesNotMatch(reply, /<domain>|<query>/);
  assert.deepEqual(parseFeishuReadCommand(nextCommand(reply)), { ...command, page: 2 });
});

test('unsupported source domains explicitly explain the logical limit without broken commands or empty first page', () => {
  const node = concept('overlong-domain', `${'x'.repeat(513)}/note.md`);
  const reply = render({ kind: 'domains', page: 1 }, context([node]));
  assert.match(reply, /第 1\/1 页/);
  assert.match(reply, /超过 512 字元/);
  assert.doesNotMatch(reply, /查看：/);
  assert.match(render({ ...all, query: node.title }, context([node])), /阅读：知识 阅读/);
});
