import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMath from 'remark-math';
import katex from 'katex';
import { normalizeDisplayMath } from '../core/markdown-normalization.js';

/** Keep ordinary body escaping identical to the card metadata contract. */
export function safeMarkdown(value: string): string {
  return [...value].map(character => {
    if (character === '<') return '＜';
    if (character === '>') return '＞';
    if (character === '[') return '［';
    if (character === ']') return '］';
    const code = character.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff ? '\ufffd' : character;
  }).join('');
}

interface Xml { name: string; attrs: Record<string, string>; children: Xml[]; text: string }
function decode(value: string): string {
  return value.replace(/&([^;]+);/g, (_, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (named[entity]) return named[entity];
    const numeric = entity.match(/^#(?:x([0-9a-f]+)|([0-9]+))$/i);
    const code = numeric ? parseInt(numeric[1] ?? numeric[2], numeric[1] ? 16 : 10) : -1;
    if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw Error('entity');
    return String.fromCodePoint(code);
  });
}
/** Only accepts the small XML dialect emitted by KaTeX, never external XML. */
function parseXml(source: string): Xml {
  if (Buffer.byteLength(source) > 65536) throw Error('XML size');
  const root: Xml = { name: 'root', attrs: {}, children: [], text: '' };
  const stack = [root]; let cursor = 0; let count = 0;
  const tokens = source.match(/<[^>]*>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (source.slice(cursor, cursor + token.length) !== token) throw Error('XML gap');
    cursor += token.length;
    if (token.startsWith('</')) {
      if (token !== `</${stack.at(-1)!.name}>` || stack.length === 1) throw Error('XML close');
      stack.pop();
    } else if (token.startsWith('<')) {
      const match = token.match(/^<([a-z][a-z0-9]*)([\s\S]*?)(\/?)>$/);
      if (!match || ++count > 2048 || stack.length > 64) throw Error('XML limits');
      const attrs: Record<string, string> = {}; let rest = match[2];
      while (rest) {
        const attr = rest.match(/^\s+([a-z][a-z0-9-]*)="([^"<]*)"/);
        if (!attr || Object.hasOwn(attrs, attr[1])) throw Error('XML attribute');
        attrs[attr[1]] = decode(attr[2]); rest = rest.slice(attr[0].length);
      }
      const node: Xml = { name: match[1], attrs, children: [], text: '' };
      stack.at(-1)!.children.push(node);
      if (!match[3]) stack.push(node);
    } else stack.at(-1)!.text += decode(token);
  }
  if (cursor !== source.length || stack.length !== 1 || root.children.length !== 1 || root.text) throw Error('XML root');
  return root.children[0];
}
function plainMath(source: string): string {
  if (Buffer.byteLength(source) > 4096) throw Error('input size');
  const tree = parseXml(katex.renderToString(source, {
    output: 'mathml', trust: false, throwOnError: true, strict: 'error', maxExpand: 100, maxSize: 10,
  }));
  function render(node: Xml): string {
    const { name, attrs, children, text } = node;
    const allowed: Record<string, Record<string, string[]>> = {
      span: { class: ['katex'] }, math: { xmlns: ['http://www.w3.org/1998/Math/MathML'], display: ['block'] },
      mo: { stretchy: ['false', 'true'], fence: ['true', 'false'], separator: ['true', 'false'], mathvariant: ['normal'], lspace: ['0em'], rspace: ['0em'] },
      mi: { mathvariant: ['normal'] }, mstyle: { displaystyle: ['true', 'false'], scriptlevel: ['0'] },
    };
    for (const [key, value] of Object.entries(attrs)) if (!allowed[name]?.[key]?.includes(value)) throw Error('semantic attribute');
    const arity = (n: number) => { if (children.length !== n || text) throw Error('arity'); };
    if (name === 'semantics') {
      if (text || children.length !== 2 || children[1].name !== 'annotation' || children[1].children.length
        || Object.keys(children[1].attrs).length !== 1 || children[1].attrs.encoding !== 'application/x-tex') throw Error('semantics');
      return render(children[0]);
    }
    if (['mi', 'mn', 'mo', 'mtext'].includes(name)) { if (children.length) throw Error('leaf'); return text; }
    if (name === 'span' || name === 'math' || name === 'mstyle') { arity(1); return render(children[0]); }
    if (name === 'mrow') { if (text) throw Error('row'); return children.map(render).join(''); }
    if (name === 'mfrac') { arity(2); return `((${render(children[0])})/(${render(children[1])}))`; }
    if (name === 'msqrt') { arity(1); return `sqrt(${render(children[0])})`; }
    if (name === 'mroot') { arity(2); return `root(${render(children[1])},${render(children[0])})`; }
    if (name === 'msub' || name === 'msup') {
      arity(2); const base = render(children[0]); const exponent = render(children[1]);
      if (name === 'msup' && /^[′″‴⁗]+$/u.test(exponent)) {
        return `${/^[\p{L}\p{N}]$/u.test(base) ? base : `(${base})`}${exponent}`;
      }
      return `(${base})${name === 'msub' ? '_' : '^'}(${exponent})`;
    }
    if (name === 'msubsup') { arity(3); return `(${render(children[0])})_(${render(children[1])})^(${render(children[2])})`; }
    throw Error('unsupported MathML');
  }
  const result = render(tree);
  if (Buffer.byteLength(result) > 8192) throw Error('output size');
  return result;
}

// Code markup is presentation only: neutralize control syntax independently.
function inertMath(value: string): string {
  let result = [...value].map(c => {
    if (c === '<') return '＜'; if (c === '>') return '＞';
    const code = c.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) return '\ufffd';
    if (code < 32 || (code >= 0x7f && code <= 0x9f)) return `\\u${code.toString(16).padStart(4, '0')}`;
    return c;
  }).join('');
  if (/\]\s*[(\[:]/.test(result)) result = result.replaceAll('[', '［').replaceAll(']', '］');
  return result;
}
function codeText(value: string, block: boolean, label = '', rawTicks = new Set<number>()): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map(m => m[0].length));
  if (block) { const fence = '`'.repeat(Math.max(3, longest + 1)); return `\n${label ? `${label.trimEnd()}\n` : ''}${fence}\n${value}\n${fence}\n`; }
  const contentTicks = new Set([...value.matchAll(/`+/g)].map(match => match[0].length));
  let length = 1;
  while (length <= 32 && (rawTicks.has(length) || contentTicks.has(length))) length++;
  if (length > 32) return codeText(value, true, label);
  const ticks = '`'.repeat(length);
  return `${label}${ticks} ${value} ${ticks}`;
}
const BASE = Buffer.byteLength(JSON.stringify({ content: JSON.stringify({ text: '' }) }));
function cost(value: string): [number, number] {
  return [Buffer.byteLength(value), Buffer.byteLength(JSON.stringify({ content: JSON.stringify({ text: value }) })) - BASE];
}
function fits(value: string): boolean { const [raw, wire] = cost(value); return raw <= 3000 && wire <= 7000; }
interface Ast { type: string; value?: string; children?: Ast[]; position?: { start: { offset?: number }; end: { offset?: number } } }
interface Part { text: string; formula?: { source: string; block: boolean } }

/** Maps normalization's inserted whitespace/backslashes back to the source. */
function sourceOffsets(original: string, normalized: string): number[] {
  const offsets: number[] = []; let i = 0;
  for (let j = 0; j < normalized.length; j++) {
    const c = normalized[j];
    if (c === original[i]) { offsets[j] = i++; continue; }
    if (/\s/.test(c) || (c === '\\' && original[i] === '$')) { offsets[j] = i; continue; }
    while (i < original.length && /\s/.test(original[i])) i++;
    if (original[i] !== c) throw Error('normalization mapping');
    offsets[j] = i++;
  }
  offsets[normalized.length] = original.length;
  return offsets;
}
function parts(body: string): Part[] {
  const normalized = normalizeDisplayMath(body);
  const tree = unified().use(remarkParse).use(remarkMath).parse(normalized) as Ast;
  const maths: Ast[] = [];
  function visit(node: Ast, forbidden = false) {
    const blocked = forbidden || (node.type !== 'root' && !!node.children?.some(child => child.type === 'html')) || ['link', 'image', 'html', 'definition', 'linkReference', 'imageReference', 'code', 'inlineCode'].includes(node.type);
    if (!blocked && ['math', 'inlineMath'].includes(node.type)) maths.push(node);
    else if (!blocked) node.children?.forEach(child => visit(child, blocked));
  }
  visit(tree);
  if (!maths.length) return [{ text: safeMarkdown(body) }];
  const offsets = sourceOffsets(body, normalized); const result: Part[] = []; let cursor = 0;
  // Newly introduced delimiters must not close an unmatched source code opener.
  const rawTicks = new Set([...body.matchAll(/`+/g)].map(match => match[0].length));
  for (const node of maths) {
    const start = offsets[node.position!.start.offset!];
    const normalizedEnd = node.position!.end.offset!;
    const end = offsets[normalizedEnd - 1] + 1;
    // remark accepts an unclosed display fence; leave it as ordinary source.
    const raw = body.slice(start, end);
    let closingStart = end - 1;
    while (closingStart > start && body[closingStart - 1] === '$') closingStart--;
    let slashCount = 0;
    for (let i = closingStart - 1; i >= start && body[i] === '\\'; i--) slashCount++;
    if (slashCount % 2) continue;
    if (node.type === 'math') {
      const normalizedSource = normalized.slice(node.position!.start.offset!, normalizedEnd);
      const lines = normalizedSource.split(/\r\n|\n|\r/);
      if (lines.length < 2 || !/^ {0,3}\${2,}[ \t]*$/.test(lines.at(-1)!)) continue;
    }
    result.push({ text: safeMarkdown(body.slice(cursor, start)) });
    const formula = { source: raw, block: node.type === 'math' };
    let text: string;
    try { text = codeText(inertMath(plainMath(node.value ?? '')), formula.block, '', rawTicks); }
    catch { text = codeText(inertMath(raw), formula.block, '公式源码：', rawTicks); }
    if (body[start - 1] === '`' && text.startsWith('`')) text = ' ' + text;
    if (body[end] === '`' && text.endsWith('`')) text += ' ';
    result.push({ text, formula }); cursor = end;
  }
  result.push({ text: safeMarkdown(body.slice(cursor)) });
  return result;
}

export function bodyChunks(body: string): string[] {
  const chunks: string[] = []; let current = ''; let bytes = 0; let wireBytes = 0;
  const flush = () => { if (current) chunks.push(current); current = ''; bytes = 0; wireBytes = 0; };
  const append = (text: string) => {
    for (const scalar of text) {
      const [raw, wire] = cost(scalar);
      if (bytes + raw > 3000 || wireBytes + wire > 7000) flush();
      current += scalar; bytes += raw; wireBytes += wire;
    }
  };
  let input: Part[];
  try { input = parts(body); } catch { input = [{ text: safeMarkdown(body) }]; }
  for (const part of input) {
    if (!part.formula) { append(part.text); continue; }
    if (fits(part.text)) {
      const [raw, wire] = cost(part.text);
      if (bytes + raw > 3000 || wireBytes + wire > 7000) flush();
      current += part.text; bytes += raw; wireBytes += wire; continue;
    }
    flush();
    const source = inertMath(part.formula.source);
    // Every oversized formula fragment is independently closed and labelled.
    let fragment = ''; let continued = false;
    const wrap = (s: string) => codeText(s, true, continued ? '公式源码（续）：\n' : '公式源码：\n');
    for (const scalar of source) {
      if (!fits(wrap(fragment + scalar))) { chunks.push(wrap(fragment)); fragment = ''; continued = true; }
      fragment += scalar;
    }
    if (fragment) chunks.push(wrap(fragment));
  }
  flush();
  return chunks.length ? chunks : [''];
}
