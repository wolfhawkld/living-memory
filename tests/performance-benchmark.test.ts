import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PerformanceBenchmark } from '../src/web/PerformanceBenchmark';

test('benchmark is idle by default with manual fixed-duration controls and receives synthetic data only', () => {
  let rendered = 0;
  const html = renderToStaticMarkup(createElement(PerformanceBenchmark, { renderGraph: (props) => {
    rendered += 1;
    assert.equal(props.snapshot.concepts.length, 300); assert.equal(props.snapshot.links.length, 1000);
    assert.equal(props.snapshot.source.mode, 'demo'); assert.equal(props.paused, false); assert.equal(props.theme, 'dark');
    return createElement('div', null, 'Synthetic graph adapter');
  } }));
  assert.equal(rendered, 1); assert.match(html, /10 秒 × 3 轮/); assert.match(html, /30 秒 × 10 轮/);
  assert.match(html, /尚未开始/); assert.match(html, /disabled="">停止采样/); assert.match(html, /disabled="">导出采样 JSON/);
  assert.match(html, /composer.render/); assert.match(html, /不能据此计算显存/); assert.match(html, /不读取私人知识/);
});
