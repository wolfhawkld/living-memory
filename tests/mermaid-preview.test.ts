import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMermaidPreview,
  prepareMermaidImage,
  type DiagramTheme,
  type DiagramImageSize,
  type MermaidPreviewDependencies,
} from '../src/web/mermaid-preview.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  // Let an async load pass through its current render/prepare continuation.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

interface RenderCall {
  code: string;
  theme: DiagramTheme;
  signal: AbortSignal;
  result: Deferred<{ svg: string }>;
}

interface PrepareCall {
  url: string;
  signal: AbortSignal;
  result: Deferred<DiagramImageSize | void>;
}

interface PreviewHarness {
  preview: ReturnType<typeof createMermaidPreview>;
  renders: RenderCall[];
  prepares: PrepareCall[];
  created: string[];
  revoked: string[];
}

interface HarnessOptions {
  failCreateOnCall?: number;
}

function harness(prefix = 'blob:test', options: HarnessOptions = {}): PreviewHarness {
  const renders: RenderCall[] = [];
  const prepares: PrepareCall[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  let serial = 0;
  let createCalls = 0;

  const dependencies: MermaidPreviewDependencies = {
    render(code, options) {
      const result = deferred<{ svg: string }>();
      renders.push({ code, theme: options.theme, signal: options.signal, result });
      return result.promise;
    },
    createUrl(svg) {
      createCalls += 1;
      if (createCalls === options.failCreateOnCall) throw new Error('URL creation failed');
      const url = `${prefix}:${++serial}:${svg}`;
      created.push(url);
      return url;
    },
    revokeUrl(url) {
      revoked.push(url);
    },
    prepareImage(url, signal) {
      const result = deferred<DiagramImageSize | void>();
      prepares.push({ url, signal, result });
      return result.promise;
    },
  };

  return {
    preview: createMermaidPreview(dependencies),
    renders,
    prepares,
    created,
    revoked,
  };
}

async function makeReady(
  h: PreviewHarness,
  code: string,
  theme: DiagramTheme,
  svg: string,
  size?: DiagramImageSize,
): Promise<string> {
  const loading = h.preview.load(code, theme);
  await flush();
  assert.equal(h.renders.length, 1);
  h.renders[0].result.resolve({ svg });
  await flush();
  assert.equal(h.prepares.length, 1);
  h.prepares[0].result.resolve(size);
  await loading;
  const url = h.preview.getSnapshot().url;
  assert.ok(url);
  return url;
}

test('cancels and ignores stale dark/light/dark render and prepare work', async () => {
  const h = harness();

  const first = h.preview.load('graph LR\nA --> B', 'dark');
  await flush();
  h.renders[0].result.resolve({ svg: 'dark-first' });
  await flush();
  assert.equal(h.prepares.length, 1);

  const second = h.preview.load('graph LR\nA --> B', 'light');
  assert.equal(h.prepares[0].signal.aborted, true);
  await flush();
  assert.equal(h.renders[1]?.theme, 'light');

  const third = h.preview.load('graph LR\nA --> B', 'dark');
  assert.equal(h.renders[1]?.signal.aborted, true);
  await flush();
  assert.equal(h.renders[2]?.theme, 'dark');

  // The cancelled first preparation rejects with an old error. The cancelled
  // light render resolves with an old result. Neither may publish state.
  h.prepares[0].result.reject(new Error('old prepare failure'));
  h.renders[1].result.resolve({ svg: 'stale-light' });
  await flush();
  assert.equal(h.created.length, 1);
  assert.equal(h.preview.getSnapshot().status, 'loading');
  assert.equal(h.preview.getSnapshot().theme, 'dark');
  assert.equal(h.preview.getSnapshot().error, null);

  h.renders[2].result.resolve({ svg: 'dark-last' });
  await flush();
  assert.equal(h.prepares.length, 2);
  h.prepares[1].result.resolve();
  await Promise.all([first, second, third]);

  const state = h.preview.getSnapshot();
  assert.equal(state.status, 'ready');
  assert.equal(state.code, 'graph LR\nA --> B');
  assert.equal(state.theme, 'dark');
  assert.equal(state.url, 'blob:test:2:dark-last');
  assert.equal(state.error, null);
  assert.equal(h.renders[0].signal.aborted, true);
  assert.equal(h.renders[1].signal.aborted, true);
  assert.equal(h.renders[2].signal.aborted, false);
  assert.deepEqual(h.created, ['blob:test:1:dark-first', 'blob:test:2:dark-last']);
  assert.deepEqual(h.revoked, ['blob:test:1:dark-first']);
});

test('keeps the displayed URL while preloading and releases it after commitDisplayed', async () => {
  const h = harness();
  const oldSize = { width: 320, height: 200 };
  const newSize = { width: 640, height: 480 };
  const oldUrl = await makeReady(h, 'graph LR\nA --> B', 'dark', 'old', oldSize);

  const replacement = h.preview.load('graph LR\nA --> B', 'light');
  await flush();
  assert.equal(h.preview.getSnapshot().status, 'loading');
  assert.equal(h.preview.getSnapshot().url, oldUrl);
  assert.deepEqual(h.preview.getSnapshot().size, oldSize);

  h.renders[1].result.resolve({ svg: 'new' });
  await flush();
  const newUrl = h.prepares[1]?.url;
  assert.equal(newUrl, 'blob:test:2:new');
  assert.equal(h.preview.getSnapshot().status, 'loading');
  assert.equal(h.preview.getSnapshot().url, oldUrl);
  assert.deepEqual(h.preview.getSnapshot().size, oldSize);
  assert.deepEqual(h.revoked, []);

  h.prepares[1].result.resolve(newSize);
  await replacement;
  assert.equal(h.preview.getSnapshot().status, 'ready');
  assert.equal(h.preview.getSnapshot().url, newUrl);
  assert.deepEqual(h.preview.getSnapshot().size, newSize);
  assert.deepEqual(h.revoked, []);

  h.preview.commitDisplayed(newUrl);
  assert.deepEqual(h.revoked, [oldUrl]);
  h.preview.commitDisplayed(newUrl);
  h.preview.commitDisplayed(null);
  assert.deepEqual(h.revoked, [oldUrl]);
});

test('clear releases displayed and pending URLs exactly once, including repeated cleanup', async () => {
  const h = harness();
  const oldUrl = await makeReady(h, 'graph LR\nA --> B', 'dark', 'old');

  const replacement = h.preview.load('graph LR\nA --> B', 'light');
  await flush();
  h.renders[1].result.resolve({ svg: 'pending' });
  await flush();
  const pendingUrl = h.prepares[1]?.url;
  assert.equal(pendingUrl, 'blob:test:2:pending');

  h.preview.clear();
  assert.equal(h.prepares[1].signal.aborted, true);
  assert.deepEqual([...h.revoked].sort(), [oldUrl, pendingUrl].sort());
  assert.deepEqual(h.preview.getSnapshot(), {
    status: 'idle', code: null, theme: null, url: null, size: null, error: null,
  });

  h.prepares[1].result.resolve();
  await replacement;
  h.preview.clear();
  h.preview.clear();
  assert.deepEqual([...h.revoked].sort(), [oldUrl, pendingUrl].sort());
});

test('can load the same source again after clear, as React StrictMode cleanup requires', async () => {
  const h = harness();
  const firstUrl = await makeReady(h, 'graph LR\nA --> B', 'dark', 'first');
  h.preview.clear();
  assert.deepEqual(h.revoked, [firstUrl]);

  const second = h.preview.load('graph LR\nA --> B', 'dark');
  await flush();
  h.renders[1].result.resolve({ svg: 'second' });
  await flush();
  h.prepares[1].result.resolve();
  await second;

  assert.equal(h.preview.getSnapshot().status, 'ready');
  assert.equal(h.preview.getSnapshot().url, 'blob:test:2:second');
  assert.deepEqual(h.revoked, [firstUrl]);
});

test('never carries an old source URL into a new source load', async () => {
  const h = harness();
  const oldUrl = await makeReady(h, 'graph LR\nA --> B', 'dark', 'source-a', { width: 320, height: 200 });

  const next = h.preview.load('graph LR\nB --> C', 'dark');
  const loading = h.preview.getSnapshot();
  assert.equal(loading.code, 'graph LR\nB --> C');
  assert.equal(loading.status, 'loading');
  assert.equal(loading.url, null);
  assert.equal(loading.size, null);
  assert.deepEqual(h.revoked, [oldUrl]);

  await flush();
  h.renders[1].result.resolve({ svg: 'source-b' });
  await flush();
  assert.equal(h.preview.getSnapshot().url, null);
  h.prepares[1].result.resolve();
  await next;
  assert.equal(h.preview.getSnapshot().url, 'blob:test:2:source-b');
});

test('render, URL creation, and image preparation failures retain the current image and can retry', async () => {
  for (const failure of ['render', 'createUrl', 'prepareImage'] as const) {
    const h = harness(failure, { failCreateOnCall: failure === 'createUrl' ? 2 : undefined });
    const oldSize = { width: 320, height: 200 };
    const retrySize = { width: 640, height: 480 };
    const oldUrl = await makeReady(h, 'graph LR\nA --> B', 'dark', 'stable', oldSize);

    const failed = h.preview.load('graph LR\nA --> B', 'light');
    await flush();
    assert.equal(h.renders.length, 2);
    if (failure === 'render') {
      h.renders[1].result.reject(new Error('render failed'));
    } else {
      h.renders[1].result.resolve({ svg: 'failed-update' });
      await flush();
      if (failure === 'prepareImage') {
        assert.equal(h.prepares.length, 2);
        h.prepares[1].result.reject(new Error('image failed'));
      }
    }
    await failed;

    const errorState = h.preview.getSnapshot();
    assert.equal(errorState.status, 'error');
    assert.equal(errorState.code, 'graph LR\nA --> B');
    assert.equal(errorState.theme, 'light');
    assert.equal(errorState.url, oldUrl);
    assert.deepEqual(errorState.size, oldSize);
    assert.match(errorState.error ?? '', /failed/);
    assert.equal(h.revoked.includes(oldUrl), false);

    const retry = h.preview.load('graph LR\nA --> B', 'light');
    await flush();
    assert.equal(h.renders.length, 3);
    h.renders[2].result.resolve({ svg: 'retry' });
    await flush();
    const retryPreparation = h.prepares.at(-1);
    assert.ok(retryPreparation);
    retryPreparation.result.resolve(retrySize);
    await retry;

    const readyState = h.preview.getSnapshot();
    assert.equal(readyState.status, 'ready');
    assert.equal(readyState.theme, 'light');
    assert.equal(readyState.url, h.created.at(-1));
    assert.deepEqual(readyState.size, retrySize);
    assert.equal(h.created.length, failure === 'prepareImage' ? 3 : 2);
    if (failure === 'prepareImage') {
      assert.equal(h.revoked.filter((url) => url === h.created[1]).length, 1);
    }

    h.preview.commitDisplayed(readyState.url);
    assert.equal(h.revoked.filter((url) => url === oldUrl).length, 1);
  }
});

test('isolates state, cancellation, and URL ownership between same-theme previews', async () => {
  const first = harness('first');
  const second = harness('second');

  const firstLoad = first.preview.load('graph LR\nA --> B', 'dark');
  const secondLoad = second.preview.load('graph LR\nA --> B', 'dark');
  await flush();
  assert.equal(first.renders.length, 1);
  assert.equal(second.renders.length, 1);

  first.renders[0].result.resolve({ svg: 'one' });
  await flush();
  first.prepares[0].result.resolve();
  await firstLoad;
  assert.equal(first.preview.getSnapshot().status, 'ready');
  assert.equal(second.preview.getSnapshot().status, 'loading');

  first.preview.clear();
  assert.equal(first.preview.getSnapshot().status, 'idle');
  assert.equal(second.renders[0].signal.aborted, false);
  assert.equal(second.preview.getSnapshot().status, 'loading');

  second.renders[0].result.resolve({ svg: 'two' });
  await flush();
  second.prepares[0].result.resolve();
  await secondLoad;
  assert.equal(second.preview.getSnapshot().status, 'ready');
  assert.equal(second.preview.getSnapshot().url, 'second:1:two');
  assert.deepEqual(first.revoked, ['first:1:one']);
  assert.deepEqual(second.revoked, []);
});

test('notifies subscribers for state changes and stops after unsubscribe', async () => {
  const h = harness();
  const statuses: string[] = [];
  const unsubscribe = h.preview.subscribe(() => {
    statuses.push(h.preview.getSnapshot().status);
  });

  const loading = h.preview.load('graph LR\nA --> B', 'dark');
  await flush();
  h.renders[0].result.resolve({ svg: 'one' });
  await flush();
  h.prepares[0].result.resolve();
  await loading;
  unsubscribe();
  h.preview.clear();

  assert.deepEqual(statuses, ['loading', 'ready']);
});

class FakeAbortSignal {
  aborted = false;
  readonly added: Array<{ type: string; listener: () => void }> = [];
  readonly removed: Array<{ type: string; listener: () => void }> = [];

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (typeof listener === 'function') this.added.push({ type, listener: listener as () => void });
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (typeof listener === 'function') this.removed.push({ type, listener: listener as () => void });
  }

  abort(): void {
    this.aborted = true;
    for (const entry of [...this.added]) {
      if (entry.type === 'abort') entry.listener();
    }
  }
}

class FakeImage {
  static readonly instances: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 640;
  naturalHeight = 480;
  src = '';

  constructor() {
    FakeImage.instances.push(this);
  }
}

test('prepareMermaidImage cleans image and abort listeners after success, error, and abort', async () => {
  const globals = globalThis as unknown as { Image?: typeof FakeImage };
  const originalImage = globals.Image;
  globals.Image = FakeImage;
  FakeImage.instances.length = 0;

  try {
    const successSignal = new FakeAbortSignal();
    const success = prepareMermaidImage('blob:success', successSignal as unknown as AbortSignal);
    const successImage = FakeImage.instances[0];
    assert.ok(successImage);
    assert.equal(successImage.src, 'blob:success');
    successImage.onload?.();
    assert.deepEqual(await success, { width: 640, height: 480 });
    assert.equal(successImage.onload, null);
    assert.equal(successImage.onerror, null);
    assert.equal(successSignal.added.length, 1);
    assert.equal(successSignal.removed.length, 1);

    const errorSignal = new FakeAbortSignal();
    const failure = prepareMermaidImage('blob:error', errorSignal as unknown as AbortSignal);
    const errorImage = FakeImage.instances[1];
    assert.ok(errorImage);
    errorImage.onerror?.();
    await assert.rejects(failure, /预览加载失败/);
    assert.equal(errorImage.src, '');
    assert.equal(errorImage.onload, null);
    assert.equal(errorImage.onerror, null);
    assert.equal(errorSignal.removed.length, 1);

    const abortSignal = new FakeAbortSignal();
    const cancelled = prepareMermaidImage('blob:abort', abortSignal as unknown as AbortSignal);
    const abortImage = FakeImage.instances[2];
    assert.ok(abortImage);
    abortSignal.abort();
    await assert.rejects(cancelled, /渲染已取消/);
    assert.equal(abortImage.src, '');
    assert.equal(abortImage.onload, null);
    assert.equal(abortImage.onerror, null);
    assert.equal(abortSignal.removed.length, 1);

    const alreadyAborted = new FakeAbortSignal();
    alreadyAborted.abort();
    const immediate = prepareMermaidImage('blob:already-aborted', alreadyAborted as unknown as AbortSignal);
    await assert.rejects(immediate, /渲染已取消/);
    const immediateImage = FakeImage.instances[3];
    assert.ok(immediateImage);
    assert.equal(immediateImage.src, '');
    assert.equal(alreadyAborted.added.length, 0);
    assert.equal(alreadyAborted.removed.length, 1);
  } finally {
    if (originalImage) globals.Image = originalImage;
    else delete globals.Image;
  }
});
