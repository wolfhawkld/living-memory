import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFeishuCardCommand as parse } from '../src/integrations/feishu-card-commands.js';

test('card entry commands reuse bounded quoted collection filters and distinguish ordinary text', () => {
  assert.deepEqual(parse('知识 卡片'), { kind: 'list', domainId: null, query: '', sort: 'elapsed', page: 1 });
  assert.deepEqual(parse('知识 卡片 帮助'), { kind: 'help' });
  assert.deepEqual(parse('知识 卡片 领域 2'), { kind: 'domains', page: 2 });
  assert.deepEqual(parse('知识 卡片 搜索 multi agent'), { kind: 'list', domainId: null, query: 'multi agent', sort: 'elapsed', page: 1 });
  assert.deepEqual(parse('知识 卡片 列表 域="AI models" 查="multi \\"agent\\"" 页=3 序=名称'),
    { kind: 'list', domainId: 'AI models', query: 'multi "agent"', sort: 'title', page: 3 });
  for (const text of ['知识', '普通聊天', '知识 卡片x', '确认绑定 LM-test', '知识 阅读 abcdef012345']) assert.equal(parse(text), null);
});

test('due commands express only private domain filtering and a three/five request', () => {
  assert.deepEqual(parse('知识 待复习'), { kind: 'due', domainId: null, limit: 3 });
  assert.deepEqual(parse('知识 待复习 量=5 域="AI models"'), { kind: 'due', domainId: 'AI models', limit: 5 });
  assert.deepEqual(parse(`知识 待复习 域=${JSON.stringify('<'.repeat(512)).replaceAll('<', '\\u003c')} 量=3`),
    { kind: 'due', domainId: '<'.repeat(512), limit: 3 });
  for (const text of ['知识 待复习 量=4', '知识 待复习 量=3 量=5', '知识 待复习 account=owner',
    '知识 待复习 域=""', '知识 待复习 域="bad\\q"', `知识 待复习 域=${'x'.repeat(513)}`]) assert.deepEqual(parse(text), { kind: 'help' });
});

test('malformed card commands give bounded help and cannot issue reads or learning mutations', () => {
  for (const text of ['知识 卡片 保存', '知识 卡片 重温', '知识 卡片 阅读 abcdef012345',
    '知识 卡片 列表 页=100001', '知识 卡片 列表 页=0', '知识 卡片 列表 查=x 查=y',
    '知识 卡片 列表 查="bad', '知识 卡片 列表 root=/private']) assert.deepEqual(parse(text), { kind: 'help' });
  assert.equal(parse('知识 卡片 '.repeat(1000)), null);
});
