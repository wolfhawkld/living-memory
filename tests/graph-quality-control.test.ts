import assert from 'node:assert/strict';
import test from 'node:test';
import { Children, createElement, isValidElement } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GraphRenderQuality } from '../src/web/graph-render-quality.js';
import { GraphQualityControl } from '../src/web/GraphQualityControl.js';
import type { GraphQualityControlProps } from '../src/web/GraphQualityControl.js';

function props(overrides: Partial<GraphQualityControlProps> = {}): GraphQualityControlProps {
  return { quality: 'standard', disabled: false, onChange: () => {}, ...overrides };
}

function render(overrides: Partial<GraphQualityControlProps> = {}): string {
  return renderToStaticMarkup(createElement(GraphQualityControl, props(overrides)));
}

test('native label and options expose default quality and explain the resolution setting', () => {
  const html = render();
  assert.match(html, /<label[^>]*for="living-memory-graph-render-quality"[^>]*>渲染清晰度<\/label>/);
  assert.match(html, /<select[^>]*id="living-memory-graph-render-quality"/);
  assert.match(html, /<option value="standard" selected="">默认<\/option>/);
  assert.match(html, /<option value="low">较低<\/option>/);
  assert.match(html, /title="较低档降低高分屏画布分辨率，不减少文字标签、节点或关系数量；光效单独设置。"/);
  assert.doesNotMatch(html, /更快|FPS/);
});

test('low quality is selected when requested', () => {
  const html = render({ quality: 'low' });
  assert.match(html, /<option value="standard">默认<\/option>/);
  assert.match(html, /<option value="low" selected="">较低<\/option>/);
});

type SelectProps = { children?: ReactNode; onChange?: (event: ChangeEvent<HTMLSelectElement>) => void };

function selectHandler(value: GraphQualityControlProps) {
  const element = GraphQualityControl(value);
  const select = Children.toArray(element.props.children).find((child) => (
    isValidElement(child) && child.type === 'select'
  ));
  assert.ok(isValidElement<SelectProps>(select));
  assert.ok(select.props.onChange);
  return select.props.onChange;
}

function event(value: string): ChangeEvent<HTMLSelectElement> {
  return { currentTarget: { value } } as ChangeEvent<HTMLSelectElement>;
}

test('disabled quality control guards changes as well as disabling the select', () => {
  assert.match(render({ disabled: true }), /<select[^>]*disabled=""/);
  const changes: GraphRenderQuality[] = [];
  const handler = selectHandler(props({ disabled: true, onChange: (value) => changes.push(value) }));
  handler(event('low'));
  handler(event('standard'));
  assert.deepEqual(changes, []);
});

test('enabled quality changes accept supported values and reject invalid values', () => {
  const changes: GraphRenderQuality[] = [];
  const handler = selectHandler(props({ onChange: (value) => changes.push(value) }));
  handler(event('low'));
  handler(event('standard'));
  handler(event('high'));
  handler(event(''));
  assert.deepEqual(changes, ['low', 'standard']);
});
