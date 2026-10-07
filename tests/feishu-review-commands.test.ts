import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFeishuReviewCommand as parse } from '../src/integrations/feishu-review-commands.js';

test('recall commands accept only exact bounded entry points with no concept identifiers', () => {
  for (const [command, kind] of [['复习', 'start'], ['继续复习', 'continue'], ['暂停复习', 'pause'], ['结束复习', 'finish']]) {
    assert.deepEqual(parse(`  知识   ${command}  `), { kind });
    assert.deepEqual(parse(`知识 ${command} private-concept`), { kind: 'help' });
    assert.deepEqual(parse(`知识 ${command} 域=Math`), { kind: 'help' });
  }
  for (const command of ['知识 复习一下', '知识 自动复习', '知识 继续复习x']) assert.deepEqual(parse(command), { kind: 'help' });
  for (const command of ['普通聊天', '知识', '知识 卡片', '知识 待复习', '知识 待复习 量=5', '知识 阅读 abcdef012345']) assert.equal(parse(command), null);
  assert.equal(parse('知识 复习'.repeat(1000)), null);
});
