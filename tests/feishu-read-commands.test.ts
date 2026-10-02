import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFeishuReadCommand as parse } from '../src/integrations/feishu-read-commands.js';

test('read command grammar has an all-node default and explicit help', () => {
  assert.deepEqual(parse('知识'), { kind: 'list', domainId: null, query: '', sort: 'elapsed', page: 1 });
  assert.deepEqual(parse('知识 帮助'), { kind: 'help' });
  assert.deepEqual(parse('知识 领域'), { kind: 'domains', page: 1 });
  assert.deepEqual(parse('知识 领域 100000'), { kind: 'domains', page: 100000 });
  assert.deepEqual(parse(' 知识 搜索 multi agent  '), { kind: 'list', domainId: null, query: 'multi agent', sort: 'elapsed', page: 1 });
});

test('combined filters accept JSON quoting and preserve spaces, escaped quotes and exact paths', () => {
  assert.deepEqual(parse('知识 列表 域="AI /模型" 查="multi \\"agent\\"" 序=名称 页=2'),
    { kind: 'list', domainId: 'AI /模型', query: 'multi "agent"', sort: 'title', page: 2 });
  assert.deepEqual(parse('知识 列表 页=3 查=ＡＢＣ 域=Cognition/Math 序=时间'),
    { kind: 'list', domainId: 'Cognition/Math', query: 'ＡＢＣ', sort: 'elapsed', page: 3 });
  assert.deepEqual(parse('知识 列表 查=""'), { kind: 'list', domainId: null, query: '', sort: 'elapsed', page: 1 });
});

test('reading accepts only bounded lower-case digest prefixes and versioned later pages', () => {
  assert.deepEqual(parse('知识 阅读 abcdef012345'), { kind: 'read', reference: 'abcdef012345', page: 1, revision: null });
  assert.deepEqual(parse(`知识 阅读 ${'a'.repeat(64)} 2 012345abcdef`),
    { kind: 'read', reference: 'a'.repeat(64), page: 2, revision: '012345abcdef' });
  assert.deepEqual(parse('知识 阅读 abcdef012345 1 012345abcdef'),
    { kind: 'read', reference: 'abcdef012345', page: 1, revision: '012345abcdef' });
  for (const command of ['知识 阅读 abcdef012345 2', '知识 阅读 ABCDEF012345', '知识 阅读 abc',
    `知识 阅读 ${'a'.repeat(65)}`, '知识 阅读 abcdef012345 2 abc', '知识 阅读 abcdef012345 0',
    '知识 阅读 abcdef012345 100001 012345abcdef']) assert.deepEqual(parse(command), { kind: 'help' });
});

test('recognized malformed commands return help; unrelated and oversized messages are ignored', () => {
  for (const command of ['知识 列表 域=x 域=y', '知识 列表 owner=me', '知识 列表 查="unterminated',
    '知识 列表 查="bad\\q"', '知识 列表 查="valid"garbage', '知识 列表 查=one two',
    '知识 列表 序=概率', '知识 列表 页=01', '知识 列表 页=-1', '知识 列表 页=1.5',
    '知识 列表 页=Infinity', '知识 列表 域=""', '知识 领域 0', '知识 领域 100001',
    `知识 列表 查=${'a'.repeat(121)}`, `知识 列表 域=${'a'.repeat(513)}`, '知识 确认重温',
    '知识 搜索']) assert.deepEqual(parse(command), { kind: 'help' }, command);
  for (const command of ['阅读 abcdef012345', '确认绑定 LM-synthetic', '知识库', '', '普通聊天', '知识 '.repeat(1500)]) {
    assert.equal(parse(command), null);
  }
});

test('wire grammar accepts expanded safe JSON commands while keeping logical value limits', () => {
  const domain = '<'.repeat(512);
  const query = '>'.repeat(120);
  const wire = `知识 列表 域=${JSON.stringify(domain).replaceAll('<', '\\u003c')} 查=${JSON.stringify(query).replaceAll('>', '\\u003e')} 页=2`;
  assert.ok(wire.length > 1024 && wire.length < 4096);
  assert.deepEqual(parse(wire), { kind: 'list', domainId: domain, query, sort: 'elapsed', page: 2 });
  assert.deepEqual(parse(`知识 列表 域=${JSON.stringify('<'.repeat(513))}`), { kind: 'help' });
});

test('all recognized commands are read-only and do not expose arbitrary operation or account fields', () => {
  for (const command of ['知识 列表 account=owner', '知识 列表 root=/private', '知识 保存', '知识 答案 hello', '知识 重温']) {
    assert.deepEqual(parse(command), { kind: 'help' });
  }
});
