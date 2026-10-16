/**
 * Accept Obsidian-style display equations whose delimiters touch the first/last
 * equation line. remark-math otherwise treats the first line as fence metadata
 * and can consume the remaining document while waiting for a standalone close.
 * Only normalize a complete, contiguous equation block; never rewrite code.
 */
export function normalizeDisplayMath(content: string): string {
  const lines = content.split(/\r\n|\n|\r/);
  const newline = content.match(/\r\n|\n|\r/)?.[0] ?? '\n';
  const output: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  let mathFence = 0;
  let inlineTicks = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const standaloneMath = line.match(/^ {0,3}(\${2,})[ \t]*$/);
    if (mathFence) {
      output.push(line);
      if (standaloneMath && standaloneMath[1].length >= mathFence) mathFence = 0;
      continue;
    }
    const codeFence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      output.push(line);
      if (codeFence && codeFence[1][0] === fence.marker && codeFence[1].length >= fence.length && !codeFence[2].trim()) fence = null;
      continue;
    }
    if (!inlineTicks && codeFence && (codeFence[1][0] !== '`' || !codeFence[2].includes('`'))) {
      fence = { marker: codeFence[1][0], length: codeFence[1].length };
      output.push(line);
      continue;
    }
    if (!inlineTicks && standaloneMath) {
      mathFence = standaloneMath[1].length;
      output.push(line);
      continue;
    }

    const opening = !inlineTicks && line.match(/^( {0,3})\$\$([^$].*)$/);
    // Standalone fences, single-line double-dollar math and prose stay under
    // remark-math's own grammar. This compatibility path is deliberately narrow.
    if (opening && opening[2].trim() && dollarPairs(opening[2]).length === 0) {
      let closingLine = -1;
      let closingOffset = -1;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const candidate = lines[cursor];
        if (!candidate.trim() || /^ {0,3}(?:#{1,6}\s|`{3,}|~{3,})/.test(candidate)) break;
        const pairs = dollarPairs(candidate);
        if (pairs.length) {
          const offset = pairs[0];
          if (pairs.length === 1 && !candidate.slice(offset + 2).trim()) {
            closingLine = cursor;
            closingOffset = offset;
          }
          break;
        }
      }
      if (closingLine >= 0) {
        const indent = opening[1];
        output.push(`${indent}$$`, `${indent}${opening[2]}`);
        output.push(...lines.slice(index + 1, closingLine));
        const tail = lines[closingLine].slice(0, closingOffset);
        if (tail.trim()) output.push(tail);
        output.push(`${indent}$$`);
        index = closingLine;
        continue;
      }
      // An unfinished nonstandard opener must not hide all subsequent headings
      // and references. Keep it readable as literal text instead.
      output.push(`${opening[1]}\\$\\$${opening[2]}`);
      continue;
    }

    output.push(line);
    // Code spans may continue onto another line. Match delimiter length exactly.
    for (const match of line.matchAll(/`+/g)) {
      if (!inlineTicks && escapedAt(line, match.index)) continue;
      if (!inlineTicks) inlineTicks = match[0].length;
      else if (inlineTicks === match[0].length) inlineTicks = 0;
    }
  }
  return output.join(newline);
}

function escapedAt(value: string, offset: number): boolean {
  let slashes = 0;
  while (offset > 0 && value[--offset] === '\\') slashes += 1;
  return slashes % 2 === 1;
}

function dollarPairs(value: string): number[] {
  return [...value.matchAll(/\$\$/g)]
    .filter((match) => value[match.index - 1] !== '$' && value[match.index + 2] !== '$' && !escapedAt(value, match.index))
    .map((match) => match.index);
}
