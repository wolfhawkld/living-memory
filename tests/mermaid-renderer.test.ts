import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MermaidDiagram } from '../src/web/MermaidDiagram.js';
import {
  createSvgObjectUrl,
  MERMAID_MAX_TEXT_SIZE,
  MermaidRenderError,
  normalizeSvgDimensions,
  renderMermaidSvg,
  revokeSvgObjectUrl,
  sanitizeMermaidCode,
  setMermaidModuleLoaderForTests,
  type MermaidRenderApi,
  type SvgObjectUrlApi,
} from '../src/web/mermaid-renderer.js';

function fakeApi(
  render: MermaidRenderApi['render'],
  initialize: MermaidRenderApi['initialize'] = () => undefined,
): MermaidRenderApi {
  return { initialize, render };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

test('removes author Mermaid config before applying the fixed safe renderer config', () => {
  const code = sanitizeMermaidCode([
    '---',
    'config:',
    '  securityLevel: loose',
    '---',
    '%%{init: {"securityLevel":"loose"}}%%',
    'graph LR',
    '  A --> B',
  ].join('\n'));

  assert.equal(code, 'graph LR\n  A --> B');
  assert.throws(() => sanitizeMermaidCode('   \n'), /内容为空/);
  assert.throws(() => sanitizeMermaidCode('x'.repeat(MERMAID_MAX_TEXT_SIZE + 1)), /超过/);
  return assert.rejects(renderMermaidSvg('   \n'), /内容为空/);
});

test('serializes concurrent Mermaid renders and initializes each API once', async () => {
  const started = deferred<void>();
  const release = deferred<void>();
  let active = 0;
  let maximumActive = 0;
  const calls: Array<{ id: string; code: string }> = [];
  const configurations: Array<Record<string, unknown>> = [];
  const api = fakeApi(async (id, code) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    calls.push({ id, code });
    if (calls.length === 1) {
      started.resolve();
      await release.promise;
    }
    active -= 1;
    return { svg: `<svg viewBox="0 0 10 10"><text>${id}</text></svg>` };
  }, (config) => configurations.push(config));

  const first = renderMermaidSvg('graph LR\nA --> B', { api, id: 'first' });
  await started.promise;
  const second = renderMermaidSvg('graph LR\nB --> C', { api, id: 'second' });
  await Promise.resolve();
  assert.deepEqual(calls.map((call) => call.id), ['first']);

  release.resolve();
  const results = await Promise.all([first, second]);
  assert.deepEqual(calls.map((call) => call.id), ['first', 'second']);
  assert.equal(maximumActive, 1);
  assert.equal(configurations.length, 1);
  assert.equal(configurations[0]?.securityLevel, 'strict');
  assert.equal(configurations[0]?.startOnLoad, false);
  assert.ok((configurations[0]?.secure as string[]).includes('secure'));
  assert.equal(results[0]?.code, 'graph LR\nA --> B');
});

test('captures each queued theme so concurrent renders never share the wrong config', async () => {
  const started = deferred<void>();
  const release = deferred<void>();
  let activeTheme = '';
  let active = 0;
  let maximumActive = 0;
  const initializedThemes: string[] = [];
  const renderedThemes: string[] = [];
  const api = fakeApi(async (id) => {
    const themeAtRenderStart = activeTheme;
    renderedThemes.push(`${id}:${themeAtRenderStart}`);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (id === 'dark-first') {
      started.resolve();
      await release.promise;
    }
    assert.equal(activeTheme, themeAtRenderStart);
    active -= 1;
    return { svg: `<svg viewBox="0 0 10 10"><text>${id}</text></svg>` };
  }, (config) => {
    activeTheme = String(config.theme);
    initializedThemes.push(activeTheme);
  });

  const first = renderMermaidSvg('graph LR\nA --> B', { api, id: 'dark-first', theme: 'dark' });
  await started.promise;
  const second = renderMermaidSvg('graph LR\nB --> C', { api, id: 'light-second', theme: 'light' });
  const third = renderMermaidSvg('graph LR\nC --> D', { api, id: 'dark-third', theme: 'dark' });
  release.resolve();

  await Promise.all([first, second, third]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(initializedThemes, ['dark', 'default', 'dark']);
  assert.deepEqual(renderedThemes, [
    'dark-first:dark',
    'light-second:default',
    'dark-third:dark',
  ]);
});

test('defaults to dark and reuses initialization for the same API and theme', async () => {
  const initializedThemes: string[] = [];
  const api = fakeApi(async () => ({ svg: '<svg viewBox="0 0 1 1"></svg>' }), (config) => {
    initializedThemes.push(String(config.theme));
  });

  await renderMermaidSvg('graph LR\nA --> B', { api });
  await renderMermaidSvg('graph LR\nB --> C', { api, theme: 'dark' });
  await renderMermaidSvg('graph LR\nC --> D', { api, theme: 'light' });
  await renderMermaidSvg('graph LR\nD --> E', { api, theme: 'light' });

  assert.deepEqual(initializedThemes, ['dark', 'default']);
});

test('does not reuse a previous theme after a changed initialization fails', async () => {
  const initializedThemes: string[] = [];
  const api = fakeApi(async () => ({ svg: '<svg viewBox="0 0 1 1"></svg>' }), (config) => {
    const theme = String(config.theme);
    initializedThemes.push(theme);
    if (theme === 'default') throw new Error('light initialization failed');
  });

  await renderMermaidSvg('graph LR\nA --> B', { api, theme: 'dark' });
  await assert.rejects(
    renderMermaidSvg('graph LR\nB --> C', { api, theme: 'light' }),
    /light initialization failed/,
  );
  await renderMermaidSvg('graph LR\nC --> D', { api, theme: 'dark' });

  assert.deepEqual(initializedThemes, ['dark', 'default', 'dark']);
});

test('captures the theme before options are mutated while waiting in the queue', async () => {
  const started = deferred<void>();
  const release = deferred<void>();
  const initializedThemes: string[] = [];
  const api = fakeApi(async (id) => {
    if (id === 'first') {
      started.resolve();
      await release.promise;
    }
    return { svg: `<svg viewBox="0 0 1 1"><text>${id}</text></svg>` };
  }, (config) => {
    initializedThemes.push(String(config.theme));
  });

  const first = renderMermaidSvg('graph LR\nA --> B', { api, id: 'first', theme: 'dark' });
  await started.promise;
  const secondOptions: import('../src/web/mermaid-renderer.js').MermaidRenderOptions = {
    api,
    id: 'second',
    theme: 'light',
  };
  const second = renderMermaidSvg('graph LR\nB --> C', secondOptions);
  secondOptions.theme = 'dark';
  release.resolve();

  await Promise.all([first, second]);
  assert.deepEqual(initializedThemes, ['dark', 'default']);
});

test('recovers the shared queue after initialization and render failures', async () => {
  let initializeAttempts = 0;
  let renderAttempts = 0;
  const api = fakeApi(async () => {
    renderAttempts += 1;
    if (renderAttempts === 1) throw new Error('render failed');
    return { svg: '<svg viewBox="0 0 1 1"></svg>' };
  }, () => {
    initializeAttempts += 1;
    if (initializeAttempts === 1) throw new Error('initialize failed');
  });

  await assert.rejects(
    renderMermaidSvg('graph LR\nA --> B', { api }),
    /initialize failed/,
  );
  await assert.rejects(
    renderMermaidSvg('graph LR\nB --> C', { api }),
    /render failed/,
  );
  const result = await renderMermaidSvg('graph LR\nC --> D', { api });

  assert.match(result.svg, /viewBox/);
  assert.equal(initializeAttempts, 2);
  assert.equal(renderAttempts, 2);
});

test('skips a cancelled task waiting in the queue and keeps later work usable', async () => {
  const started = deferred<void>();
  const release = deferred<void>();
  const initializedThemes: string[] = [];
  const renderedIds: string[] = [];
  const api = fakeApi(async (id) => {
    renderedIds.push(id);
    if (id === 'first') {
      started.resolve();
      await release.promise;
    }
    return { svg: `<svg viewBox="0 0 1 1"><text>${id}</text></svg>` };
  }, (config) => {
    initializedThemes.push(String(config.theme));
  });

  const first = renderMermaidSvg('graph LR\nA --> B', { api, id: 'first', theme: 'dark' });
  await started.promise;
  const controller = new AbortController();
  const queuedLight = renderMermaidSvg('graph LR\nB --> C', {
    api,
    id: 'queued-light',
    signal: controller.signal,
    theme: 'light',
  });
  controller.abort();
  release.resolve();

  await first;
  await assert.rejects(
    queuedLight,
    (error: unknown) => error instanceof MermaidRenderError && error.code === 'MERMAID_RENDER_ABORTED',
  );
  const later = await renderMermaidSvg('graph LR\nC --> D', { api, id: 'later', theme: 'dark' });

  assert.deepEqual(initializedThemes, ['dark']);
  assert.deepEqual(renderedIds, ['first', 'later']);
  assert.match(later.svg, /later/);
});

test('cancelling an active render still cleans its container and leaves the queue usable', async () => {
  const originalDocument = globalThis.document;
  const appended: Array<{ parentNode: unknown }> = [];
  const removed: unknown[] = [];
  const body = {
    appendChild(element: { parentNode: unknown }) {
      element.parentNode = body;
      appended.push(element);
    },
    removeChild(element: unknown) {
      removed.push(element);
    },
  };
  const fakeDocument = {
    body,
    createElement() {
      return {
        id: '',
        parentNode: null as unknown,
        setAttribute() { /* noop */ },
        style: {} as Record<string, string>,
      };
    },
  };

  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
  try {
    const started = deferred<void>();
    const release = deferred<void>();
    let renderCalls = 0;
    const api = fakeApi(async (_id, _code, container) => {
      renderCalls += 1;
      assert.ok(container);
      if (renderCalls === 1) {
        started.resolve();
        await release.promise;
      }
      return { svg: '<svg viewBox="0 0 1 1"></svg>' };
    });
    const controller = new AbortController();
    const cancelled = renderMermaidSvg('graph LR\nA --> B', {
      api,
      id: 'cancelled',
      signal: controller.signal,
    });
    await started.promise;
    controller.abort();
    release.resolve();

    await assert.rejects(
      cancelled,
      (error: unknown) => error instanceof MermaidRenderError && error.code === 'MERMAID_RENDER_ABORTED',
    );
    assert.equal(renderCalls, 1);
    assert.equal(appended.length, 1);
    assert.equal(removed.length, 1);

    const later = await renderMermaidSvg('graph LR\nB --> C', { api, id: 'after-cancel' });
    assert.match(later.svg, /viewBox/);
    assert.equal(renderCalls, 2);
    assert.equal(appended.length, 2);
    assert.equal(removed.length, 2);
  } finally {
    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    } else {
      delete (globalThis as { document?: Document }).document;
    }
  }
});

test('gives Blob SVGs finite intrinsic dimensions when Mermaid uses responsive sizing', async () => {
  const api = fakeApi(async () => ({
    svg: '<svg width="100%" height="100%" style="width: 100%; max-width: 640px; height: auto; color: red" viewBox="0 0 640 480"><text>diagram</text></svg>',
  }));

  const result = await renderMermaidSvg('classDiagram\nclass A', { api });
  const openingTag = result.svg.match(/<svg\b[^>]*>/i)?.[0] ?? '';
  assert.match(openingTag, /\bwidth="640"/);
  assert.match(openingTag, /\bheight="480"/);
  assert.doesNotMatch(openingTag, /width="100%"|height="100%"|max-width\s*:/i);
  assert.match(openingTag, /color: red/);

  const oversized = normalizeSvgDimensions('<svg viewBox="0 0 100000 50000"></svg>');
  assert.match(oversized, /width="50000"/);
  assert.match(oversized, /height="25000"/);
  assert.equal(normalizeSvgDimensions('<svg viewBox="0 0 0 10"></svg>'), '<svg viewBox="0 0 0 10"></svg>');
});

test('rejects unsafe SVG output and keeps later queue work usable', async () => {
  const unsafeApi = fakeApi(async () => ({ svg: '<svg><script>alert(1)</script></svg>' }));
  await assert.rejects(renderMermaidSvg('graph LR\nA --> B', { api: unsafeApi }), /未通过安全检查/);

  const textApi = fakeApi(async () => ({ svg: '<svg viewBox="0 0 10 10"><text>one=1</text></svg>' }));
  const textResult = await renderMermaidSvg('graph LR\nA --> B', { api: textApi });
  assert.match(textResult.svg, /one=1/);

  const attributeApi = fakeApi(async () => ({ svg: '<svg viewBox="0 0 10 10"><text onclick="alert(1)">safe?</text></svg>' }));
  await assert.rejects(renderMermaidSvg('graph LR\nA --> B', { api: attributeApi }), /未通过安全检查/);

  const safeApi = fakeApi(async () => ({ svg: '<svg viewBox="0 0 1 1"></svg>' }));
  const result = await renderMermaidSvg('graph LR\nA --> B', { api: safeApi });
  assert.match(result.svg, /viewBox/);
});

test('creates and revokes SVG object URLs through an injectable browser API', async () => {
  const blobs: Blob[] = [];
  const revoked: string[] = [];
  const urlApi: SvgObjectUrlApi = {
    createObjectURL(blob) {
      blobs.push(blob);
      return 'blob:test-mermaid';
    },
    revokeObjectURL(url) {
      revoked.push(url);
    },
  };

  const url = createSvgObjectUrl('<svg></svg>', urlApi);
  assert.equal(url, 'blob:test-mermaid');
  assert.equal(blobs[0]?.type, 'image/svg+xml;charset=utf-8');
  revokeSvgObjectUrl(url, urlApi);
  assert.deepEqual(revoked, ['blob:test-mermaid']);
});

test('allows a failed dynamic import to be retried with a fresh module promise', async () => {
  let attempts = 0;
  const api = fakeApi(async () => ({ svg: '<svg viewBox="0 0 1 1"></svg>' }));
  setMermaidModuleLoaderForTests(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary module failure');
    return api;
  });

  try {
    await assert.rejects(renderMermaidSvg('graph LR\nA --> B'), /temporary module failure/);
    const result = await renderMermaidSvg('graph LR\nA --> B');
    assert.match(result.svg, /viewBox/);
    assert.equal(attempts, 2);
  } finally {
    setMermaidModuleLoaderForTests(null);
  }
});

test('cleans the temporary Mermaid container when parsing rejects', async () => {
  const originalDocument = globalThis.document;
  const appended: Array<{ parentNode: unknown }> = [];
  const removed: unknown[] = [];
  const body = {
    appendChild(element: { parentNode: unknown }) {
      element.parentNode = body;
      appended.push(element);
    },
    removeChild(element: unknown) {
      removed.push(element);
    },
  };
  const fakeDocument = {
    body,
    createElement() {
      const element = {
        id: '',
        parentNode: null as unknown,
        setAttribute() { /* noop */ },
        style: {} as Record<string, string>,
      };
      Object.defineProperty(element, 'parentNode', {
        configurable: true,
        get() { return elementParent; },
        set(value: unknown) { elementParent = value; },
      });
      let elementParent: unknown = null;
      return element;
    },
  };

  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
  try {
    const api = fakeApi(async (_id, _code, container) => {
      assert.ok(container);
      throw new Error('parse failed');
    });
    await assert.rejects(renderMermaidSvg('graph LR\nA --> B', { api }), /parse failed/);
    assert.equal(appended.length, 1);
    assert.equal(removed.length, 1);
  } finally {
    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    } else {
      delete (globalThis as { document?: Document }).document;
    }
  }
});

test('SSR renders a safe loading shell without importing Mermaid or creating an image URL', () => {
  const html = renderToStaticMarkup(createElement(MermaidDiagram, { code: 'graph LR\nA --> B' }));
  assert.match(html, /mermaid-diagram/);
  assert.match(html, /正在渲染图表/);
  assert.match(html, /显示原代码/);
  assert.doesNotMatch(html, /<img\b/);
});
