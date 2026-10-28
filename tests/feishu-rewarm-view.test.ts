import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planFeishuRewarmView } from '../src/server/feishu-rewarm-view.js';
import type { FeishuRewarmIntent } from '../src/shared/feishu-rewarm.js';
test('result views expose recovery only for pending and never expose caller supplied learning data', () => {
 const intent = { id: 'a'.repeat(32), status: 'pending', request: { occurredAt: '2026-10-07T01:00:00.000Z' } } as FeishuRewarmIntent;
 const pending = planFeishuRewarmView(intent, null);
 assert.ok(pending.actions.some(a => a.target.kind === 'rewarm' && a.target.verb === 'retry'));
 assert.match(JSON.stringify(pending.build('card')), /写入结果待确认，请重试原操作/);
 for (const status of ['applied', 'conflict'] as const) assert.ok(!planFeishuRewarmView({ ...intent, status }, null).actions.some(a => a.target.kind === 'rewarm' && a.target.verb === 'retry'));
 assert.match(JSON.stringify(planFeishuRewarmView(null, null).build('card')), /暂无重温操作/);
});

test('restored pending conflicts do not claim the learning record was never saved or invite reconfirmation', () => {
 const intent = { id: 'a'.repeat(32), status: 'conflict', errorCode: 'INSTANCE_RESTORED', request: { occurredAt: '2026-10-07T01:00:00.000Z' } } as FeishuRewarmIntent;
 const plan = planFeishuRewarmView(intent, null);
 const payload = JSON.stringify(plan.build('card'));
 assert.match(payload, /原待确认操作已因实例恢复失效，请查看原学习记录核对/);
 assert.doesNotMatch(payload, /本次重温未保存|重新打开资料后确认/);
 assert.ok(!plan.actions.some(a => a.target.kind === 'rewarm' && a.target.verb === 'retry'));
});

test('blocked confirmation identifies the original concept safely and distinguishes first pending from reused pending', () => {
 const intent = { id: 'a'.repeat(32), status: 'pending', request: { occurredAt: '2026-10-07T01:00:00.000Z' } } as FeishuRewarmIntent;
 const concept = { id: 'original', title: 'Original [title]', source: { revision: 'r1' } } as import('../src/shared/types.js').Concept;
 const payload = JSON.stringify(planFeishuRewarmView(intent, concept, { confirmationBlockedByPending: true }).build('card'));
 assert.match(payload, /原操作概念：Original ［title］/);
 assert.match(payload, /已有待确认操作，本次未创建新的重温记录/);
 assert.doesNotMatch(JSON.stringify(planFeishuRewarmView(intent, concept).build('card')), /本次未创建新的重温记录/);
 const unavailable = JSON.stringify(planFeishuRewarmView(intent, null, { confirmationBlockedByPending: true }).build('card'));
 assert.match(unavailable, /原操作概念：原版本资料当前不可用/);
 assert.doesNotMatch(unavailable, /Original/);
});
