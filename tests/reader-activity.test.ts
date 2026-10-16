import assert from 'node:assert/strict';
import test from 'node:test';
import type { KnowledgeContentBlock } from '../src/shared/knowledge-references.ts';
import { isForegroundReader, observeReaderContent, type ReaderContentObserverOptions, type ReaderIntersection, type ReaderVisibilitySource } from '../src/web/reader-activity.ts';

function block(id: string, contentPart: 'body' | 'summary' = 'body'): KnowledgeContentBlock {
  return { blockId: id, contentPart, kind: 'paragraph', bodyRange: { coordinateSpace: 'render-markdown-v1', startOffset: 0, endOffset: 10, startLine: 1, endLine: 1 } };
}
function element(id: string) { return { getAttribute: () => id } as unknown as Element; }
function setup() {
  const first = element('first'), second = element('second'), unknown = element('unknown'), otherPart = element('summary');
  const inside = new Set([first, second, unknown, otherPart]);
  const root = { contains: (target: Element) => inside.has(target), querySelectorAll: () => [...inside] } as unknown as Element;
  const listeners = new Set<() => void>();
  const visibility = { visibilityState: 'visible', addEventListener(_type: string, callback: () => void) { listeners.add(callback); }, removeEventListener(_type: string, callback: () => void) { listeners.delete(callback); } };
  const observers: { callback: (entries: readonly ReaderIntersection[]) => void; observed: Element[]; disconnected: boolean }[] = [];
  const emitted: string[][] = [];
  let active = true;
  const options: ReaderContentObserverOptions = {
    root, contentPart: 'body', blocks: [block('first'), block('second'), block('summary', 'summary')], seen: new Set(), visibility,
    isActive: () => active, onVisible: (blocks) => emitted.push(blocks.map((item) => item.blockId)),
    createObserver(callback, actualRoot) {
      assert.equal(actualRoot, root);
      const observer = { callback, observed: [] as Element[], disconnected: false };
      observers.push(observer);
      return { observe(target) { observer.observed.push(target); }, disconnect() { observer.disconnected = true; } };
    },
  };
  return { first, second, unknown, otherPart, inside, visibility, options, observers, emitted,
    setActive(value: boolean) { active = value; },
    changeVisibility(value: string) { visibility.visibilityState = value; for (const listener of listeners) listener(); },
    focusChange() { for (const listener of listeners) listener(); },
    listeners,
  };
}
function intersection(target: Element, width = 20, height = 10, isIntersecting = true): ReaderIntersection {
  return { target, isIntersecting, intersectionRect: { width, height } };
}

test('observer reports only cataloged real blocks in its own root and content part', () => {
  const h = setup();
  const dispose = observeReaderContent(h.options);
  assert.deepEqual(h.observers[0]?.observed, [h.first, h.second]);
  h.observers[0]!.callback([intersection(h.first), intersection(h.unknown), intersection(h.otherPart), intersection(element('first'))]);
  assert.deepEqual(h.emitted, [['first']]);
  dispose();
  assert.equal(h.listeners.size, 0);
});

test('zero-area edges, non-intersections and invalid area never count as visible', () => {
  const h = setup();
  const dispose = observeReaderContent(h.options);
  const callback = h.observers[0]!.callback;
  callback([intersection(h.first, 0), intersection(h.first, 10, 0), intersection(h.first, -1), intersection(h.first, NaN), intersection(h.first, 10, 10, false)]);
  assert.deepEqual(h.emitted, []);
  callback([intersection(h.first)]);
  assert.deepEqual(h.emitted, [['first']]);
  dispose();
});

test('visibility hiding disconnects and invalidates late notifications; restore reobserves unreported blocks', () => {
  const h = setup();
  const dispose = observeReaderContent(h.options);
  h.observers[0]!.callback([intersection(h.first)]);
  h.changeVisibility('hidden');
  assert.equal(h.observers[0]?.disconnected, true);
  h.observers[0]!.callback([intersection(h.second)]);
  assert.deepEqual(h.emitted, [['first']]);
  h.changeVisibility('visible');
  assert.deepEqual(h.observers[1]?.observed, [h.second]);
  h.observers[0]!.callback([intersection(h.second)]);
  assert.deepEqual(h.emitted, [['first']]);
  h.observers[1]!.callback([intersection(h.second)]);
  assert.deepEqual(h.emitted, [['first'], ['second']]);
  dispose();
});

test('identity, render or tracking invalidation blocks outstanding callbacks and cleanup never invents visibility', () => {
  const h = setup();
  const dispose = observeReaderContent(h.options);
  h.setActive(false);
  h.observers[0]!.callback([intersection(h.first)]);
  assert.deepEqual(h.emitted, []);
  dispose();
  h.setActive(true);
  h.observers[0]!.callback([intersection(h.second)]);
  assert.deepEqual(h.emitted, []);
});

test('seen blocks remain deduplicated across callbacks, visibility cycles and reader observer replacement', () => {
  const h = setup();
  const firstDispose = observeReaderContent(h.options);
  h.observers[0]!.callback([intersection(h.first), intersection(h.first)]);
  h.observers[0]!.callback([intersection(h.first)]);
  firstDispose();
  const secondDispose = observeReaderContent(h.options);
  assert.deepEqual(h.observers[1]?.observed, [h.second]);
  assert.deepEqual(h.emitted, [['first']]);
  secondDispose();
});

test('missing IntersectionObserver or initially hidden document leaves reading untouched and emits no facts', () => {
  const h = setup();
  h.options.createObserver = undefined;
  const dispose = observeReaderContent(h.options);
  assert.deepEqual(h.emitted, []);
  dispose();
  const hidden = setup();
  hidden.visibility.visibilityState = 'hidden';
  const stop = observeReaderContent(hidden.options);
  assert.equal(hidden.observers.length, 0);
  assert.deepEqual(hidden.emitted, []);
  stop();
});

test('a different native modal or unknown focus is never foreground reader content', () => {
  const dialog = { open: true, contains: (target: unknown) => target === ownFocus };
  const ownFocus = { closest: () => dialog } as unknown as Element;
  const otherDialog = {};
  const otherFocus = { closest: () => otherDialog } as unknown as Element;
  assert.equal(isForegroundReader(dialog, { visibilityState: 'visible', activeElement: ownFocus }), true);
  assert.equal(isForegroundReader(dialog, { visibilityState: 'visible', activeElement: otherFocus }), false);
  assert.equal(isForegroundReader(dialog, { visibilityState: 'visible', activeElement: null }), false);
  assert.equal(isForegroundReader(dialog, { visibilityState: 'hidden', activeElement: ownFocus }), false);
  dialog.open = false;
  assert.equal(isForegroundReader(dialog, { visibilityState: 'visible', activeElement: ownFocus }), false);
});

test('modal occlusion discards late IO and focus returning reobserves only unreported blocks', () => {
  const h = setup();
  const dispose = observeReaderContent(h.options);
  h.observers[0]!.callback([intersection(h.first)]);
  h.setActive(false); h.focusChange();
  assert.equal(h.observers[0]?.disconnected, true);
  h.observers[0]!.callback([intersection(h.second)]);
  assert.deepEqual(h.emitted, [['first']]);
  h.setActive(true); h.focusChange();
  assert.deepEqual(h.observers[1]?.observed, [h.second]);
  h.observers[1]!.callback([intersection(h.second)]);
  h.focusChange(); // Moving focus within the same reader never duplicates a reported block.
  assert.equal(h.observers.length, 3);
  assert.deepEqual(h.observers[2]?.observed, []);
  assert.deepEqual(h.emitted, [['first'], ['second']]);
  dispose();
});
