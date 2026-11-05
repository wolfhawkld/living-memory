import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { bodyChunks, safeMarkdown } from '../src/server/feishu-body-text.js';

const joined = (s: string) => bodyChunks(s).join('');
const wireBase = Buffer.byteLength(JSON.stringify({ content: JSON.stringify({ text: '' }) }));
function budgets(pages: string[]) {
  for (const page of pages) {
    assert.ok(Buffer.byteLength(page) <= 3000, 'raw byte budget');
    assert.ok(Buffer.byteLength(JSON.stringify({ content: JSON.stringify({ text: page }) })) - wireBase <= 7000, 'double JSON budget');
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(page));
  }
}

test('safeMarkdown preserves its original conservative escaping contract', () => {
  assert.equal(safeMarkdown('<at>[x]</at>😀\ud800\n_*'), '＜at＞［x］＜/at＞😀�\n_*');
});
test('synthetic mean value theorem preserves intervals and readable fractions', () => {
  const output = joined("函数在 $[a,b]$ 连续，在 $(a,b)$ 可导。\n$$\\frac{f(b)-f(a)}{b-a}=f'(\\xi)$$");
  assert.ok(output.includes('` [a,b] `'));
  assert.ok(output.includes('(f(b)−f(a))/(b−a)'));
  assert.ok(output.includes('=f′(ξ)'));
  assert.equal(joined("$f''(c)$"), '` f′′(c) `');
  assert.equal(joined("${a+b}'$"), '` (a+b)′ `');
  assert.ok(!output.includes('公式源码'));
});
test('Greek relations, nested fractions, roots and explicit sub/superscripts', () => {
  assert.equal(joined(String.raw`$\sqrt[3]{\frac{x_i^2}{\alpha}}\le\beta\in[0,1]$`), '` root(3,(((x)_(i)^(2))/(α)))≤β∈[0,1] `');
  assert.equal(joined(String.raw`$\sqrt{\frac{1}{\frac{a}{b}}}$`), '` sqrt(((1)/(((a)/(b))))) `');
});
test('unsupported matrix, bold, binomial, unknown command and syntax errors retain complete source', () => {
  for (const source of [String.raw`$\begin{matrix}a&b\\c&d\end{matrix}$`, String.raw`$\mathbf{x}$`, String.raw`$\binom{n}{k}$`, String.raw`$\unknown{x}$`, String.raw`$\frac{a}{$`]) {
    const output = joined(source);
    assert.ok(output.includes('公式源码'), source);
    assert.ok(output.includes(source), source);
  }
});
test('code, escaped dollars, unclosed math and link destinations remain ordinary source', () => {
  for (const source of [String.raw`code \$x$ and \$y\$`, '`$x_i$`', '```tex\n$\\frac{1}{2}$\n```', '$unclosed', '$$\nx_i', '$$\nx_i $$', '[link](https://example.test/$x$)', '<span>$x$</span>']) {
    assert.equal(joined(source), safeMarkdown(source), source);
  }
});
test('normalization changes only recognized display formulas, preserves surrounding source', () => {
  assert.equal(joined('before\n$$x_i\n+1$$\nafter'), 'before\n\n```\n(x)_(i)+1\n```\n\nafter');
  const source = 'first $x$\r\n\r\n$$unfinished\r\nafter';
  assert.ok(joined(source).endsWith('\r\n\r\n$$unfinished\r\nafter'));
});
test('formula code is independently safe against tags, links, images, backticks and controls', () => {
  for (const source of [String.raw`$\text{<at id=all>}[go](https://example.test)$`, String.raw`$\unknown{![image](https://example.test)}` + '`'.repeat(5) + '$', '$\\unknown{a\u0001b}$']) {
    const output = joined(source);
    assert.ok(!output.includes('<at'));
    assert.ok(!/\]\s*[([]/.test(output));
    assert.ok(!output.includes('\u0001'));
    budgets(bodyChunks(source));
  }
  const source = '$\\unknown{' + '`'.repeat(5) + '}$';
  const tree = unified().use(remarkParse).parse(joined(source));
  const paragraph = tree.children[0];
  assert.ok(paragraph.type === 'paragraph' && paragraph.children.some(node => node.type === 'inlineCode' && node.value === source));
});
test('a formula that fits a page moves intact across the boundary', () => {
  const formula = joined(String.raw`$\frac{x_i^2}{y}$`);
  const pages = bodyChunks('a'.repeat(2990) + String.raw`$\frac{x_i^2}{y}$` + 'tail');
  assert.equal(pages.length, 2);
  assert.equal(pages[0], 'a'.repeat(2990));
  assert.equal(pages[1], formula + 'tail');
  budgets(pages);
});
test('oversized fallback retains every source scalar in independently closed fragments', () => {
  const source = '$\\unknown{' + '😀\\"\u0000'.repeat(1500) + '}$';
  const pages = bodyChunks(source);
  assert.ok(pages.length > 2);
  const recovered = pages.map((page, i) => {
    assert.ok(page.startsWith(i ? '\n公式源码（续）：\n```\n' : '\n公式源码：\n```\n'));
    assert.ok(page.endsWith('\n```\n'));
    return page.slice(page.indexOf('```\n') + 4, -5);
  }).join('');
  assert.equal(recovered, source.replaceAll('\u0000', '\\u0000'));
  budgets(pages);
});
test('plain Unicode/control text uses exactly the original paging contract', () => {
  const source = '😀中文\\"\u0000\r\n'.repeat(900);
  const pages = bodyChunks(source);
  assert.equal(pages.join(''), safeMarkdown(source));
  budgets(pages);
  assert.deepEqual(bodyChunks(''), ['']);
});

test('single-page display fallback places its label and both code fences on separate lines', () => {
  const source = '$$\n\\unknown{x}\n$$';
  const pages = bodyChunks(source);
  assert.equal(pages.length, 1);
  assert.equal(pages[0], '\n公式源码：\n```\n$$\\u000a\\unknown{x}\\u000a$$\n```\n');
  const tree = unified().use(remarkParse).parse(joined(source + '\n\nafter'));
  const codes = tree.children.filter(node => node.type === 'code');
  assert.equal(codes.length, 1);
  assert.equal(codes[0].type === 'code' ? codes[0].value : '', '$$\\u000a\\unknown{x}\\u000a$$');
  assert.ok(JSON.stringify(tree.children.at(-1)).includes('after'));
  assert.equal(tree.children.at(-1)?.type, 'paragraph');
  budgets(pages);
});

test('fractions group the entire quotient for adjacency and nesting', () => {
  assert.equal(joined(String.raw`$\frac{a}{b}\frac{c}{d}$`), '` ((a)/(b))((c)/(d)) `');
  assert.equal(joined(String.raw`$\frac{a}{b+c}x$`), '` ((a)/(b+c))x `');
  assert.equal(joined(String.raw`$\frac{a}{\frac{b}{c}}$`), '` ((a)/(((b)/(c)))) `');
});
test('raw unmatched backticks cannot merge with or consume formula code delimiters', () => {
  for (const source of ['`$[a,b]$', '$[a,b]$`', '``$[a,b]$', 'unmatched ` text $[a,b]$']) {
    const pages = bodyChunks(source);
    const tree = unified().use(remarkParse).parse(pages.join(''));
    const values: string[] = [];
    const walk = (node: { type: string; value?: string; children?: unknown[] }) => {
      if (node.type === 'inlineCode') values.push(node.value!);
      node.children?.forEach(child => walk(child as Parameters<typeof walk>[0]));
    };
    walk(tree);
    assert.ok(values.includes('[a,b]'), JSON.stringify({ source, pages, values }));
    budgets(pages);
  }
});
test('reference definitions in formula text are inert while interval brackets remain readable', () => {
  const output = joined(String.raw`$\text{[ref]: https://x.test}$`);
  assert.ok(output.includes('［ref］:'));
  assert.ok(!output.includes('[ref]:'));
  assert.equal(joined('$[a,b]$'), '` [a,b] `');
});

test('large unrelated raw backtick runs do not inflate formula delimiters', () => {
  const source = '~~~\n' + '`'.repeat(9000) + '\n~~~\n\n$[a,b]$';
  const pages = bodyChunks(source);
  assert.ok(pages.at(-1)!.endsWith('` [a,b] `'));
  budgets(pages);
});
test('exhausted inline delimiter candidates use a closed block and preserve following prose', () => {
  const ticks = Array.from({ length: 32 }, (_, index) => '`'.repeat(index + 1)).join('\n');
  const source = '~~~\n' + ticks + '\n~~~\n\n$[a,b]$ after';
  const pages = bodyChunks(source);
  const tree = unified().use(remarkParse).parse(pages.join(''));
  const code = tree.children.filter(node => node.type === 'code');
  assert.equal(code.length, 2);
  assert.equal(code[1].type === 'code' ? code[1].value : '', '[a,b]');
  const last = tree.children.at(-1)!;
  assert.equal(last.type, 'paragraph');
  assert.ok(JSON.stringify(last).includes('after'));
  budgets(pages);
});
