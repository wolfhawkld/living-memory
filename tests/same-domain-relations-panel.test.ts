import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SameDomainRelation } from '../src/core/domain-view.js';
import type { Concept } from '../src/shared/types.js';
import { SameDomainRelationsPanel, type SameDomainRelationsPanelProps } from '../src/web/SameDomainRelationsPanel.js';

function concept(id: string, title = id): Concept {
  return {
    id, title, aliases: [], domain: 'untrusted-frontmatter', summary: 'PRIVATE SUMMARY', body: 'PRIVATE BODY',
    source: { path: `Cognition/Math/${id}.md`, revision: 'v1' },
  };
}
const selected = concept('alpha', '同名概念');
const other = concept('beta', '同名概念');

function relation(direction: SameDomainRelation['direction'] = 'outgoing', description = '原始关系说明'): SameDomainRelation {
  return {
    direction, sourceConcept: direction === 'incoming' ? other : selected,
    targetConcept: direction === 'self' ? selected : direction === 'incoming' ? selected : other,
    link: { id: 'same-id', source: direction === 'incoming' ? other.id : selected.id,
      target: direction === 'self' ? selected.id : direction === 'incoming' ? selected.id : other.id,
      type: '推导', description },
  };
}

function props(overrides: Partial<SameDomainRelationsPanelProps> = {}): SameDomainRelationsPanelProps {
  return { selectedConcept: selected, relations: [relation()], disabled: false,
    onReveal() { throw new Error('render called reveal'); }, onNavigate() { throw new Error('render navigated'); }, ...overrides };
}
function panel(overrides: Partial<SameDomainRelationsPanelProps> = {}): string {
  return renderToStaticMarkup(createElement(SameDomainRelationsPanel, props(overrides)));
}

test('uses a closed native disclosure and complete-index scope without invoking callbacks during rendering', () => {
  const html = panel();
  assert.match(html, /^<details class="same-domain-relations">/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.match(html, /<summary aria-disabled="false">查看同域关系（1条）<\/summary>/);
  assert.match(html, /所属目录：数学/);
  assert.match(html, /Cognition\/Math/);
  assert.match(html, /来自完整知识索引，不受图谱节点上限限制/);
  assert.doesNotMatch(html, /PRIVATE SUMMARY|PRIVATE BODY|untrusted-frontmatter/);
});

test('preserves directed endpoints, duplicate link IDs, full original text and escaped markup', () => {
  const description = '<script>alert("x")</script>\n' + '完整的原文关系说明'.repeat(80);
  const relations = [relation('outgoing', description), relation('incoming', '另一条关系'), relation('self')];
  const before = structuredClone(relations);
  const html = panel({ relations });
  assert.match(html, /查看同域关系（3条）/);
  assert.equal((html.match(/<li>/g) ?? []).length, 3);
  assert.match(html, /出向/);
  assert.match(html, /入向/);
  assert.match(html, /自关联/);
  assert.equal((html.match(/aria-label="指向">→/g) ?? []).length, 3);
  assert.match(html, /关系类型：<span>推导/);
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;\n' + '完整的原文关系说明'.repeat(80)));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Cognition\/Math\/alpha.md/);
  assert.match(html, /Cognition\/Math\/beta.md/);
  assert.equal((html.match(/<button /g) ?? []).length, 2);
  assert.deepEqual(relations, before);
});

test('shows empty and unspecified relation values and gives self relations no navigation', () => {
  assert.match(panel({ relations: [] }), /查看同域关系（0条）.*当前概念没有同域关系/);
  const self = relation('self', '');
  self.link.type = '';
  const html = panel({ relations: [self] });
  assert.match(html, /未标注类型/);
  assert.match(html, /未提供说明/);
  assert.doesNotMatch(html, /<button/);
  const whitespace = relation('self', ' \n\t ');
  whitespace.link.type = '\t  ';
  const whitespaceHtml = panel({ relations: [whitespace] });
  assert.match(whitespaceHtml, /关系类型：<span>未标注类型<\/span>/);
  assert.match(whitespaceHtml, /关系说明：<span>未提供说明<\/span>/);
});

test('disabled state advertises disabled disclosure and disables all navigation buttons', () => {
  const html = panel({ disabled: true, relations: [relation(), relation('incoming')] });
  assert.match(html, /<summary aria-disabled="true">/);
  assert.equal((html.match(/<button type="button" disabled=""/g) ?? []).length, 2);
});

test('reveals only for an interactive open toggle and prevents disabled summary activation', () => {
  let revealed = 0;
  const enabled = SameDomainRelationsPanel(props({ onReveal: () => { revealed++; } }));
  enabled.props.onToggle({ currentTarget: { open: false } });
  assert.equal(revealed, 0);
  enabled.props.onToggle({ currentTarget: { open: true } });
  assert.equal(revealed, 1);
  const disabled = SameDomainRelationsPanel(props({ disabled: true, onReveal: () => { revealed++; } }));
  disabled.props.onToggle({ currentTarget: { open: true } });
  assert.equal(revealed, 1);
  let prevented = false;
  disabled.props.children[0].props.onClick({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
});

test('navigation targets the other endpoint and its handler also respects disabled state', () => {
  const navigated: string[] = [];
  for (const disabled of [false, true]) {
    const tree = SameDomainRelationsPanel(props({
      disabled, relations: [relation('outgoing'), relation('incoming')], onNavigate: (id) => { navigated.push(id); },
    }));
    const rows = tree.props.children[1].props.children[2].props.children;
    for (const row of rows) row.props.children[4].props.onClick();
  }
  assert.deepEqual(navigated, ['beta', 'beta']);
});
