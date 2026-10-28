import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFeishuRewarmCommand } from '../src/integrations/feishu-rewarm-commands.js';
test('recovery accepts exactly the two explicit commands', () => {
  assert.deepEqual(parseFeishuRewarmCommand('知识 重温状态'), { kind: 'status' });
  assert.deepEqual(parseFeishuRewarmCommand('知识 重试重温'), { kind: 'retry' });
  for (const input of [' 知识 重温状态', '知识 重试重温 x', '知识 重温', '知识\n重温状态', '知识 重试重温 ']) assert.equal(parseFeishuRewarmCommand(input), null);
});
