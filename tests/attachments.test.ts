import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ATTACHMENT_MAX_BYTES } from '../src/server/attachments.js';
import { closeApp, createApp, type LivingMemoryApp } from '../src/server/app.js';

interface ResponseData {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  json: <T>() => T;
}

interface RunningApp {
  app: LivingMemoryApp;
  root: string;
  request: (path: string, options?: { headers?: Record<string, string> }) => Promise<ResponseData>;
  stop: () => Promise<void>;
}

interface Fixture {
  root: string;
  dataDir: string;
  outside: string;
  cleanup: () => void;
}

function conceptFile(title: string, summary: string): string {
  return [
    '---',
    'type: concept',
    `title: ${title}`,
    `summary: ${summary}`,
    '---',
    '',
    summary,
    '',
  ].join('\n');
}

function sourceFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'living-memory-attachment-source-'));
  const outside = mkdtempSync(join(tmpdir(), 'living-memory-attachment-outside-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-attachment-data-'));
  const noteDirectory = join(root, 'Cognition', 'Math');
  mkdirSync(join(noteDirectory, 'assets'), { recursive: true });
  mkdirSync(join(root, 'vault'), { recursive: true });
  mkdirSync(join(root, 'wiki'), { recursive: true });
  mkdirSync(join(root, 'duplicates', 'one'), { recursive: true });
  mkdirSync(join(root, 'duplicates', 'two'), { recursive: true });
  mkdirSync(join(root, '.hidden'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });

  writeFileSync(join(noteDirectory, 'Note.md'), conceptFile('附件概念', '用于测试图片附件。'));
  writeFileSync(join(noteDirectory, 'assets', '图 片.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(join(noteDirectory, 'assets', '名字 #.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(join(noteDirectory, 'assets', 'literal%20.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(join(noteDirectory, 'assets', 'literal%.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(join(root, 'Cognition', 'shared.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  writeFileSync(join(root, 'vault', 'root.webp'), Buffer.from('RIFF0000WEBP', 'ascii'));
  writeFileSync(join(root, 'wiki', 'unique.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(join(root, 'duplicates', 'one', 'duplicate.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(join(root, 'duplicates', 'two', 'duplicate.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(join(root, '.hidden', 'hidden.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(join(root, '.git', 'ignored.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(join(noteDirectory, 'fake.png'), Buffer.from('this is not a png', 'utf8'));
  writeFileSync(join(noteDirectory, 'notes.txt'), Buffer.from('plain text', 'utf8'));
  writeFileSync(join(noteDirectory, 'safe.svg'), Buffer.from('<svg><script>alert(1)</script></svg>', 'utf8'));
  writeFileSync(join(noteDirectory, 'large.bmp'), Buffer.alloc(0));
  truncateSync(join(noteDirectory, 'large.bmp'), ATTACHMENT_MAX_BYTES + 1);
  writeFileSync(join(outside, 'escape.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  symlinkSync(join(outside, 'escape.png'), join(noteDirectory, 'assets', 'escape.png'));

  return {
    root,
    dataDir,
    outside,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function running(): Promise<RunningApp> {
  const fixture = sourceFixture();
  const app = createApp({
    root: fixture.root,
    dataDir: fixture.dataDir,
    port: 4317,
    staticDir: join(fixture.dataDir, 'no-dist'),
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  let stopped = false;

  const request = (path: string, options: { headers?: Record<string, string> } = {}) => new Promise<ResponseData>((resolveResponse, reject) => {
    const requestObject = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: {
        host: '127.0.0.1:4317',
        ...(options.headers ?? {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        resolveResponse({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body,
          json: <T>() => JSON.parse(body.toString('utf8')) as T,
        });
      });
    });
    requestObject.once('error', reject);
    requestObject.end();
  });

  return {
    app,
    root: fixture.root,
    request,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
      closeApp(app);
      fixture.cleanup();
    },
  };
}

async function attachmentContext(client: RunningApp): Promise<{ conceptId: string; sourceId: string; sourceRevision: string }> {
  const session = (await client.request('/api/session')).json<{ sourceId: string }>();
  const snapshot = (await client.request('/api/snapshot?scope=all')).json<{ concepts: Array<{ id: string; title: string; source: { revision: string } }> }>();
  const concept = snapshot.concepts.find((item) => item.title === '附件概念');
  assert.ok(concept);
  return { conceptId: concept.id, sourceId: session.sourceId, sourceRevision: concept.source.revision };
}

function attachmentPath(
  context: { conceptId: string; sourceId: string; sourceRevision: string },
  path: string,
  extra = '',
): string {
  return `/api/concepts/${encodeURIComponent(context.conceptId)}/attachment?sourceId=${encodeURIComponent(context.sourceId)}&sourceRevision=${encodeURIComponent(context.sourceRevision)}&path=${encodeURIComponent(path)}${extra}`;
}

function errorCode(response: ResponseData): string {
  return response.json<{ error?: { code?: string } }>().error?.code ?? '';
}

test('attachment API serves note-relative, vault-root, and SVG images with safe headers', async () => {
  const client = await running();
  try {
    const context = await attachmentContext(client);
    const relative = await client.request(attachmentPath(context, 'assets/图 片.png'));
    assert.equal(relative.status, 200);
    assert.deepEqual([...relative.body], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(relative.headers['content-type'], 'image/png');
    assert.equal(relative.headers['cache-control'], 'no-store');
    assert.equal(relative.headers['x-content-type-options'], 'nosniff');
    assert.equal(relative.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(relative.headers['content-length'], '8');

    const encodedFilename = await client.request(attachmentPath(context, 'assets/名字%20%23.png'));
    assert.equal(encodedFilename.status, 200);
    assert.equal(encodedFilename.headers['content-type'], 'image/png');

    const literalPercent = await client.request(attachmentPath(context, 'assets/literal%2520.png'));
    assert.equal(literalPercent.status, 200);
    const barePercent = await client.request(attachmentPath(context, 'assets/literal%.png'));
    assert.equal(barePercent.status, 200);
    const literalWikiPercent = await client.request(attachmentPath(context, '![[assets/literal%20.png]]'));
    assert.equal(literalWikiPercent.status, 200);
    const standardSuffix = await client.request(attachmentPath(context, 'assets/图%20片.png?size=1#preview'));
    assert.equal(standardSuffix.status, 200);

    const parent = await client.request(attachmentPath(context, '../shared.jpg'));
    assert.equal(parent.status, 200);
    assert.equal(parent.headers['content-type'], 'image/jpeg');

    const rootImage = await client.request(attachmentPath(context, '/vault/root.webp'));
    assert.equal(rootImage.status, 200);
    assert.equal(rootImage.headers['content-type'], 'image/webp');

    const wikiImage = await client.request(attachmentPath(context, '![[unique.png]]'));
    assert.equal(wikiImage.status, 200);
    assert.equal(wikiImage.headers['content-type'], 'image/png');
    const wikiPathImage = await client.request(attachmentPath(context, '![[assets/图 片.png]]'));
    assert.equal(wikiPathImage.status, 200);
    assert.equal(wikiPathImage.headers['content-type'], 'image/png');

    const svg = await client.request(attachmentPath(context, 'safe.svg'));
    assert.equal(svg.status, 200);
    assert.equal(svg.headers['content-type'], 'image/svg+xml');
    assert.equal(svg.headers['content-security-policy'], "default-src 'none'; sandbox");
    assert.match(svg.body.toString('utf8'), /<script>/);
  } finally {
    await client.stop();
  }
});

test('attachment API validates source/version, ambiguity, image signatures, and path safety', async () => {
  const client = await running();
  try {
    const context = await attachmentContext(client);
    const valid = attachmentPath(context, 'assets/图 片.png');

    for (const query of [
      `/api/concepts/${context.conceptId}/attachment?sourceId=${encodeURIComponent(context.sourceId)}&sourceRevision=${encodeURIComponent(context.sourceRevision)}`,
      `/api/concepts/${context.conceptId}/attachment?sourceId=${encodeURIComponent(context.sourceId)}&path=x.png`,
      `/api/concepts/${context.conceptId}/attachment?sourceRevision=${encodeURIComponent(context.sourceRevision)}&path=x.png`,
    ]) {
      const response = await client.request(query);
      assert.equal(response.status, 400);
      assert.equal(errorCode(response), 'INVALID_ATTACHMENT_QUERY');
    }

    const repeated = await client.request(`${valid}&path=other.png`);
    assert.equal(repeated.status, 400);
    assert.equal(errorCode(repeated), 'INVALID_ATTACHMENT_QUERY');

    const wrongSource = await client.request(attachmentPath({ ...context, sourceId: 'wrong-source' }, 'assets/图 片.png'));
    assert.equal(wrongSource.status, 409);
    assert.equal(errorCode(wrongSource), 'SOURCE_MISMATCH');

    const wrongRevision = await client.request(attachmentPath({ ...context, sourceRevision: 'wrong-revision' }, 'assets/图 片.png'));
    assert.equal(wrongRevision.status, 409);
    assert.equal(errorCode(wrongRevision), 'SOURCE_REVISION_MISMATCH');

    const unknown = await client.request(attachmentPath({ ...context, conceptId: 'concept_missing' }, 'assets/图 片.png'));
    assert.equal(unknown.status, 404);
    assert.equal(errorCode(unknown), 'CONCEPT_NOT_FOUND');

    const ambiguous = await client.request(attachmentPath(context, '![[duplicate.png]]'));
    assert.equal(ambiguous.status, 409);
    assert.equal(errorCode(ambiguous), 'ATTACHMENT_AMBIGUOUS');

    for (const path of ['fake.png', 'notes.txt']) {
      const response = await client.request(attachmentPath(context, path));
      assert.equal(response.status, 415, path);
      assert.equal(errorCode(response), 'ATTACHMENT_NOT_IMAGE', path);
    }

    const tooLarge = await client.request(attachmentPath(context, 'large.bmp'));
    assert.equal(tooLarge.status, 413);
    assert.equal(errorCode(tooLarge), 'ATTACHMENT_TOO_LARGE');

    for (const path of ['../../outside.png', 'assets/escape.png', 'file:///etc/passwd', 'C:\\Windows\\win.ini', '//server/share/image.png']) {
      const response = await client.request(attachmentPath(context, path));
      assert.ok(response.status === 400 || response.status === 404, path);
      assert.notEqual(errorCode(response), 'INTERNAL_ERROR', path);
      assert.equal(response.body.includes(Buffer.from(client.root)), false, path);
    }

    const hidden = await client.request(attachmentPath(context, '![[hidden.png]]'));
    assert.equal(hidden.status, 404);
    assert.equal(errorCode(hidden), 'ATTACHMENT_NOT_FOUND');
  } finally {
    await client.stop();
  }
});

test('attachment reads do not change learning records', async () => {
  const client = await running();
  try {
    const context = await attachmentContext(client);
    const before = (await client.request('/api/export')).json<Record<string, unknown>>();
    assert.equal((await client.request(attachmentPath(context, 'assets/图 片.png'))).status, 200);
    assert.equal((await client.request(attachmentPath(context, '![[unique.png]]'))).status, 200);
    assert.equal((await client.request(attachmentPath(context, '![[missing.png]]'))).status, 404);
    const after = (await client.request('/api/export')).json<Record<string, unknown>>();
    for (const key of ['anchors', 'observations', 'config', 'layout']) {
      assert.deepEqual(after[key], before[key], key);
    }
  } finally {
    await client.stop();
  }
});
