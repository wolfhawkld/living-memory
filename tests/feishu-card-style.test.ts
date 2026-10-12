import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardButton, cardButtonRows, styledFeishuCard } from '../src/server/feishu-card-style.js';
import { cardButtons } from './helpers/feishu-card-elements.js';

test('mobile action rows keep long confirmations separate and preserve opaque callback ids', () => {
  const buttons = [
    cardButton('opaque-card', 'a4', '阅读'), cardButton('opaque-card', 'a1', '回忆'),
    cardButton('opaque-card', 'a5', '请核对本条内容后确认已完成重温'),
    cardButton('opaque-card', 'a2', '下一条'),
    cardButton('opaque-card', 'a0', '开始本轮', 'primary_filled'),
  ];
  const rows = cardButtonRows(buttons);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].tag, 'column_set');
  assert.equal(rows[1], buttons[2]);
  assert.equal(rows[2], buttons[3]);
  assert.equal(rows[3], buttons[4]);
  const rendered = cardButtons(styledFeishuCard({ title: '操作', elements: rows }));
  assert.deepEqual(rendered, buttons);
  assert.deepEqual(rendered.map(button => button.behaviors[0].value),
    ['a4', 'a1', 'a5', 'a2', 'a0'].map(actionId => ({ kind: 'lm.nav.v1', cardId: 'opaque-card', actionId })));
});

test('three self-reports have equal width and no visually preferred answer', () => {
  const buttons = ['清楚', '模糊', '想不起'].map((caption, index) => cardButton('opaque-card', `a${index}`, caption));
  const rows = cardButtonRows(buttons, 3);
  assert.equal(rows.length, 1);
  const columns = rows[0].columns as Array<{ width: string; weight: number; elements: unknown[] }>;
  assert.deepEqual(columns.map(column => [column.width, column.weight]),
    [['weighted', 1], ['weighted', 1], ['weighted', 1]]);
  assert.deepEqual(columns.flatMap(column => column.elements), buttons);
  assert.deepEqual(buttons.map(button => button.type), ['default', 'default', 'default']);
});
