import assert from 'node:assert/strict';
import test from 'node:test';
import { Children, createElement, isValidElement } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DomainVisibilitySummary } from '../src/core/domain-visibility.js';
import type { GraphLimitPreference } from '../src/web/graph-display-preference.js';
import { GraphDisplayControls } from '../src/web/GraphDisplayControls.js';
import type { GraphDisplayControlsProps } from '../src/web/GraphDisplayControls.js';

function summary(overrides: Partial<DomainVisibilitySummary> = {}): DomainVisibilitySummary {
  return {
    domainTotalNodes: 18,
    visiblePrimaryNodes: 18,
    hiddenPrimaryNodes: 0,
    visibleCrossDomainNodes: 0,
    totalInternalLinks: 24,
    visibleInternalLinks: 24,
    hiddenInternalLinks: 0,
    ...overrides,
  };
}

function props(overrides: Partial<GraphDisplayControlsProps> = {}): GraphDisplayControlsProps {
  return {
    preference: 'server',
    serverLimit: 50,
    summary: summary(),
    disabled: false,
    onChange: () => {},
    ...overrides,
  };
}

function render(overrides: Partial<GraphDisplayControlsProps> = {}): string {
  return renderToStaticMarkup(createElement(GraphDisplayControls, props(overrides)));
}

test('server selection has a native label and every supported manual limit', () => {
  const html = render();
  assert.match(html, /<label[^>]*for="living-memory-graph-display-limit"[^>]*>当前领域节点上限<\/label>/);
  assert.match(html, /<select[^>]*id="living-memory-graph-display-limit"/);
  assert.match(html, /<option value="server" selected="">跟随默认（50）<\/option>/);
  for (const limit of [20, 50, 100, 200, 300]) {
    assert.match(html, new RegExp(`<option value="${limit}">${limit}<\\/option>`));
  }
  assert.match(html, /aria-describedby="living-memory-graph-display-limit-help"/);
  assert.match(html, /title="每个领域的节点上限；跨域展开仍受总数300限制"/);
  assert.match(html, /仅调整图谱显示范围，不影响学习或查询/);
});

test('manual limits select independently of the service limit', () => {
  for (const preference of [20, 50, 100, 200, 300] as const) {
    const html = render({ preference, serverLimit: 73 });
    assert.match(html, new RegExp(`<option value="${preference}" selected="">${preference}<\\/option>`));
    assert.match(html, /<option value="server">跟随默认（73）<\/option>/);
  }
});

test('real truncation reports hidden primary nodes and internal relations', () => {
  const html = render({ summary: summary({
    domainTotalNodes: 80,
    visiblePrimaryNodes: 50,
    hiddenPrimaryNodes: 30,
    totalInternalLinks: 120,
    visibleInternalLinks: 61,
    hiddenInternalLinks: 59,
  }) });
  assert.match(html, /当前领域节点：50 \/ 80/);
  assert.match(html, /域内关系：61 \/ 120/);
  assert.match(html, /role="status"/);
  assert.match(html, /因节点上限暂未显示：30 个当前领域节点、59 条域内关系/);
  assert.doesNotMatch(html, /丢失/);
});

test('no truncation warning appears when all primary nodes are shown', () => {
  const html = render({ preference: 20 });
  assert.match(html, /当前领域节点：18 \/ 18/);
  assert.doesNotMatch(html, /因节点上限|graph-display-truncation|role="status"/);
});

test('expanded cross-domain counts stay separate from domain totals', () => {
  const html = render({ summary: summary({ visibleCrossDomainNodes: 6 }) });
  assert.match(html, /当前领域节点：18 \/ 18/);
  assert.match(html, /主动展开跨域节点：6/);
  assert.doesNotMatch(html, /跨域关系.*丢失|因节点上限/);
});

type SelectProps = { children?: ReactNode; onChange?: (event: ChangeEvent<HTMLSelectElement>) => void };

function findSelect(node: ReactNode): SelectProps | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<SelectProps>(child)) continue;
    if (child.type === 'select') return child.props;
    const found = findSelect(child.props.children);
    if (found) return found;
  }
  return undefined;
}

test('disabled select also guards its handler; valid enabled changes keep numeric types', () => {
  assert.match(render({ disabled: true }), /<select[^>]*disabled=""/);
  const changes: GraphLimitPreference[] = [];
  const onChange = (value: GraphLimitPreference) => changes.push(value);
  const event = (value: string) => ({ currentTarget: { value } }) as ChangeEvent<HTMLSelectElement>;
  const disabledSelect = findSelect(GraphDisplayControls(props({ disabled: true, onChange })));
  assert.ok(disabledSelect?.onChange);
  disabledSelect.onChange(event('100'));
  disabledSelect.onChange(event('server'));
  assert.deepEqual(changes, []);

  const enabledSelect = findSelect(GraphDisplayControls(props({ onChange })));
  assert.ok(enabledSelect?.onChange);
  enabledSelect.onChange(event('100'));
  enabledSelect.onChange(event('server'));
  enabledSelect.onChange(event('73'));
  assert.deepEqual(changes, [100, 'server']);
});
