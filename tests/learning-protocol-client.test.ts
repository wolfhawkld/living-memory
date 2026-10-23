import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, configureSessionScope, writeJson, subscribeToSessionRecovery } from '../src/web/api.ts';
import { runCli } from '../src/cli/index.js';
import { LEARNING_PROTOCOL_HEADER, supportsLearningProtocol } from '../src/shared/learning-protocol.js';
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('Web refuses missing, old or future server handshake before any protected request, including direct API reads', async () => {
  const original = globalThis.fetch;
  try {
    for (const version of [undefined, 1, 4, '2', '3', [2, 3], null]) {
      configureSessionScope(null);
      const calls: string[] = [];
      globalThis.fetch = async input => { calls.push(String(input)); return response({ writeToken: 'protocol-client-token', sourceId: 'synthetic-source', learningProtocolVersion: version }); };
      await assert.rejects(api.getSnapshot(), { code: 'LEARNING_PROTOCOL_REQUIRED', status: 426 });
      assert.deepEqual(calls, ['/api/session']);
    }
    assert.equal(supportsLearningProtocol(2), true); assert.equal(supportsLearningProtocol('2'), false);
  } finally { globalThis.fetch = original; configureSessionScope(null); }
});

test('Web coalesces handshake, sends protocol on JSON/blob, and never renews or replays 426 writes', async () => {
  const original = globalThis.fetch; configureSessionScope(null);
  const calls: { path: string; headers: Headers }[] = [];
  const session = { writeToken: 'protocol-good-token', sourceId: 'protocol-good-source', learningProtocolVersion: 2 as const };
  try {
    globalThis.fetch = async (input, init) => {
      const path = String(input); calls.push({ path, headers: new Headers(init?.headers) });
      if (path === '/api/session') return response(session);
      if (path === '/api/observations') return response({ error: { code: 'LEARNING_PROTOCOL_REQUIRED', message: 'upgrade required' } }, 426);
      return response({ synthetic: true });
    };
    await Promise.all([api.getSnapshot(), api.getSnapshot()]);
    assert.equal(calls.filter(call => call.path === '/api/session').length, 1);
    configureSessionScope(session);
    await api.getSession(); // Bind confirmed protocol to the committed scope.
    await api.exportData(session.writeToken, session.sourceId);
    const before = calls.length;
    await assert.rejects(writeJson('/observations', {}, session.writeToken, session.sourceId), { code: 'LEARNING_PROTOCOL_REQUIRED', status: 426, retryable: false });
    assert.equal(calls.length, before + 1);
    for (const call of calls) assert.equal(call.headers.get(LEARNING_PROTOCOL_HEADER), call.path === '/api/session' ? null : '2');
  } finally { globalThis.fetch = original; configureSessionScope(null); }
});

test('late coalesced Web handshake cannot release requests after logout or source/instance switch', async () => {
  const original = globalThis.fetch;
  try {
    for (const replacement of [null, { writeToken: 'another-token', sourceId: 'another-source', instanceId: 'another-instance' }]) {
      configureSessionScope(null);
      let resolve!: (response: Response) => void;
      const pending = new Promise<Response>(done => { resolve = done; }); const calls: string[] = [];
      globalThis.fetch = async input => { calls.push(String(input)); return pending; };
      const a = api.getSnapshot(); const b = api.getSnapshot();
      await new Promise<void>(done => setImmediate(done));
      configureSessionScope(replacement);
      resolve(response({ writeToken: 'old-token', sourceId: 'old-source', learningProtocolVersion: 2 }));
      for (const result of await Promise.allSettled([a, b])) {
        assert.equal(result.status, 'rejected');
        if (result.status === 'rejected') assert.equal(result.reason.code, 'INSTANCE_MISMATCH');
      }
      assert.deepEqual(calls, ['/api/session']);
    }
  } finally { globalThis.fetch = original; configureSessionScope(null); }
});

test('CLI requires declared protocol 2 before refresh or local receipts and sends it on successful writes', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'lm-cli-protocol-'));
  try {
    for (const version of [undefined, 1, 4, '2', '3', [2, 3]]) {
      const calls: string[] = [];
      await assert.rejects(runCli(['refresh'], { stateDir, env: {}, fetchImpl: async input => {
        calls.push(new URL(String(input)).pathname); return response({ writeToken: 'token', sourceId: 'source', learningProtocolVersion: version });
      } }), { code: 'LEARNING_PROTOCOL_REQUIRED' });
      assert.deepEqual(calls, ['/api/session']); assert.deepEqual(readdirSync(stateDir), []);
    }
    const calls: { path: string; headers: Headers }[] = [];
    const result = await runCli(['refresh'], { stateDir, env: {}, fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname; calls.push({ path, headers: new Headers(init?.headers) });
      return response(path === '/api/session' ? { writeToken: 'token', sourceId: 'source', learningProtocolVersion: 2 } : { status: 'refreshed' });
    } });
    assert.equal((result as { command: string }).command, 'refresh');
    assert.deepEqual(calls.map(call => call.path), ['/api/session', '/api/refresh']);
    for (const call of calls) assert.equal(call.headers.get(LEARNING_PROTOCOL_HEADER), call.path === '/api/session' ? null : '2');
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('cancelled protected readers leave a shared handshake available for another caller', async () => {
  const original = globalThis.fetch; configureSessionScope(null);
  const controller = new AbortController(); let resolve!: (response: Response) => void;
  const handshake = new Promise<Response>(done => { resolve = done; }); const calls: string[] = [];
  try {
    globalThis.fetch = async input => { const path = String(input); calls.push(path); return path === '/api/session' ? handshake : response({}); };
    const cancelled = api.getLearningOverview('synthetic', controller.signal);
    const remaining = api.getSnapshot();
    await new Promise<void>(done => setImmediate(done)); controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    resolve(response({ writeToken: 'cancel-token', sourceId: 'synthetic', learningProtocolVersion: 2 }));
    await remaining;
    assert.equal(calls.filter(path => path === '/api/session').length, 1);
    assert.deepEqual(calls, ['/api/session', '/api/snapshot']);
  } finally { globalThis.fetch = original; configureSessionScope(null); }
});

test('scope generations own their handshake and late incompatible responses cannot poison a newer confirmation', async () => {
  const original = globalThis.fetch;
  try {
    for (const lateAfterSuccess of [false, true]) {
      configureSessionScope({ writeToken: 'generation-a-token', sourceId: 'generation-a', instanceId: 'generation-a-instance' });
      let aResolve!: (response: Response) => void; let bResolve!: (response: Response) => void;
      const aHandshake = new Promise<Response>(done => { aResolve = done; });
      const bHandshake = new Promise<Response>(done => { bResolve = done; });
      const calls: string[] = []; let sessions = 0;
      globalThis.fetch = async input => { const path = String(input); calls.push(path);
        if (path === '/api/session') return ++sessions === 1 ? aHandshake : bHandshake;
        return response({}); };
      const a = api.getSnapshot(undefined, 'generation-a');
      const aRejected = assert.rejects(a, { code: 'INSTANCE_MISMATCH' });
      await new Promise<void>(done => setImmediate(done));
      configureSessionScope({ writeToken: 'generation-b-token', sourceId: 'generation-b', instanceId: 'generation-b-instance' });
      const b = api.getSnapshot(undefined, 'generation-b');
      await new Promise<void>(done => setImmediate(done));
      if (!lateAfterSuccess) { aResolve(response({ writeToken: 'generation-a-token', sourceId: 'generation-a', learningProtocolVersion: 1 })); await aRejected; }
      const secondB = api.getSnapshot(undefined, 'generation-b');
      assert.equal(sessions, 2, 'old handshake cleanup cannot clear the pending new one');
      bResolve(response({ writeToken: 'generation-b-token', sourceId: 'generation-b', instanceId: 'generation-b-instance', learningProtocolVersion: 2 }));
      await Promise.all([b, secondB]);
      if (lateAfterSuccess) { aResolve(response({ writeToken: 'generation-a-token', sourceId: 'generation-a', learningProtocolVersion: 1 })); await aRejected; }
      await api.getSnapshot(undefined, 'generation-b');
      assert.equal(sessions, 2, 'late old protocol failure cannot invalidate the new confirmation');
      assert.equal(calls.filter(path => path !== '/api/session').length, 3);
    }
  } finally { globalThis.fetch = original; configureSessionScope(null); }
});

test('an explicit session from a different source or instance never authorizes the old active scope', async () => {
  const original = globalThis.fetch;
  try {
    for (const changed of [{ sourceId: 'other-source', instanceId: 'active-instance', code: 'SOURCE_MISMATCH' }, { sourceId: 'active-source', instanceId: 'other-instance', code: 'INSTANCE_MISMATCH' }]) {
      configureSessionScope({ writeToken: 'active-token', sourceId: 'active-source', instanceId: 'active-instance' });
      const calls: string[] = [];
      globalThis.fetch = async input => { calls.push(String(input)); return response({ writeToken: `changed-${changed.code}`, sourceId: changed.sourceId, instanceId: changed.instanceId, learningProtocolVersion: 2 }); };
      const session = await api.getSession(); assert.equal(session.sourceId, changed.sourceId, 'loader can inspect the new identity');
      await assert.rejects(api.getSnapshot(undefined, 'active-source'), { code: changed.code });
      assert.deepEqual(calls, ['/api/session']);
    }
  } finally { globalThis.fetch = original; configureSessionScope(null); }
});

test('Web uses the confirmed 2 or 3 on JSON, blob and admin reads/writes; bootstrap declares no version', async () => {
  const original = globalThis.fetch;
  try {
    for (const version of [2, 3] as const) {
      configureSessionScope(null);
      const session = { writeToken: `dual-token-${version}`, sourceId: `dual-source-${version}`, instanceId: `dual-instance-${version}`, learningProtocolVersion: version };
      const calls: Array<{ path: string; headers: Headers; method: string }> = [];
      globalThis.fetch = async (input, init) => {
        const path = String(input); calls.push({ path, headers: new Headers(init?.headers), method: init?.method ?? 'GET' });
        return response(path === '/api/session' ? session : { synthetic: true });
      };
      const confirmed = await api.getSession(); configureSessionScope(confirmed);
      await api.getSnapshot(undefined, session.sourceId);
      await api.exportData(session.writeToken, session.sourceId);
      await api.adminRequest('/admin/users', { method: 'GET' }, session.writeToken, session.sourceId);
      await api.adminRequest('/admin/users', { method: 'POST', body: JSON.stringify({ username: 'synthetic' }) }, session.writeToken, session.sourceId);
      assert.equal(confirmed.learningProtocolVersion, version);
      for (const call of calls) assert.equal(call.headers.get(LEARNING_PROTOCOL_HEADER), call.path === '/api/session' ? null : String(version));
      assert.deepEqual(calls.filter(call => call.path === '/api/admin/users').map(call => call.method), ['GET', 'POST']);
    }
  } finally { globalThis.fetch = original; configureSessionScope(null); }
});

test('same-source protocol switch invalidates late reads and prevents a previously bound token from authorizing v3', async () => {
  const original = globalThis.fetch;
  try {
    const a = { writeToken: 'version-a-token', sourceId: 'version-source', instanceId: 'version-instance', learningProtocolVersion: 2 as const };
    const b = { ...a, writeToken: 'version-b-token', learningProtocolVersion: 3 as const };
    configureSessionScope(a);
    let current: typeof a | typeof b = a;
    let release!: (value: Response) => void;
    const late = new Promise<Response>(resolve => { release = resolve; }); const paths: string[] = [];
    globalThis.fetch = async input => { const path = String(input); paths.push(path); return path === '/api/session' ? response(current) : late; };
    await api.getSession();
    const old = api.adminRequest('/admin/users', {}, a.writeToken, a.sourceId);
    const rejected = assert.rejects(old, { code: 'INSTANCE_MISMATCH' });
    await new Promise<void>(resolve => setImmediate(resolve));
    current = b; const confirmed = await api.getSession(); configureSessionScope(confirmed);
    release(response({ secret: 'OLD_RESPONSE_MUST_NOT_BE_CONSUMED' })); await rejected;
    const count = paths.filter(path => path === '/api/admin/users').length;
    await assert.rejects(api.adminRequest('/admin/users', { method: 'POST', body: '{}' }, a.writeToken, a.sourceId), { code: 'LEARNING_PROTOCOL_REQUIRED' });
    assert.equal(paths.filter(path => path === '/api/admin/users').length, count);
  } finally { globalThis.fetch = original; configureSessionScope(null); }
});

test('a protocol switch while consuming JSON or blob cannot publish the old response', async () => {
  const original = globalThis.fetch;
  try {
    for (const kind of ['json', 'blob'] as const) {
      const a = { writeToken: `consume-${kind}-2`, sourceId: `consume-${kind}`, instanceId: `consume-${kind}`, learningProtocolVersion: 2 as const };
      const b = { ...a, writeToken: `consume-${kind}-3`, learningProtocolVersion: 3 as const };
      configureSessionScope(a);
      let current: typeof a | typeof b = a;
      let consumed!: () => void; const started = new Promise<void>(resolve => { consumed = resolve; });
      let finish!: (value: any) => void; const body = new Promise(resolve => { finish = resolve; });
      globalThis.fetch = async input => {
        if (String(input) === '/api/session') return response(current);
        const result = response({});
        Object.defineProperty(result, kind, { value: () => { consumed(); return body; } });
        return result;
      };
      await api.getSession();
      const pending = kind === 'json' ? api.getSnapshot() : api.exportData(a.writeToken, a.sourceId);
      const rejected = assert.rejects(pending, { code: 'INSTANCE_MISMATCH' });
      await started; current = b; configureSessionScope(await api.getSession());
      finish(kind === 'json' ? { private: 'old-answer' } : new Blob(['old-answer'])); await rejected;
    }
  } finally { globalThis.fetch = original; configureSessionScope(null); }
});

test('401 recovery cannot replay a frozen write after a protocol change and a token cannot change its declared version', async () => {
  const original = globalThis.fetch;
  try {
    const a = { writeToken: 'renew-version-2', sourceId: 'renew-version-source', instanceId: 'renew-version-instance', learningProtocolVersion: 2 as const };
    configureSessionScope(a); let sessions = 0; let writes = 0;
    globalThis.fetch = async input => {
      if (String(input) === '/api/session') return response(++sessions === 1 ? a : { ...a, writeToken: 'renew-version-3', learningProtocolVersion: 3 });
      writes++; return response({ error: { code: 'TOKEN_REQUIRED', message: 'expired' } }, 401);
    };
    await api.getSession();
    await assert.rejects(writeJson('/observations', { eventId: 'frozen-event' }, a.writeToken, a.sourceId), { code: 'INSTANCE_MISMATCH' });
    assert.equal(writes, 1); assert.equal(sessions, 2);
    configureSessionScope(null);
    globalThis.fetch = async () => response({ ...a, learningProtocolVersion: 3 });
    await assert.rejects(api.getSession(), { code: 'LEARNING_PROTOCOL_REQUIRED' });
  } finally { globalThis.fetch = original; configureSessionScope(null); }
});

test('first write with an unconfirmed scope locks its initial protocol before 401 recovery', async () => {
  const original = globalThis.fetch;
  try {
    const initial = { writeToken: 'unknown-scope-original', sourceId: 'unknown-scope-source' };
    configureSessionScope(initial); let sessions = 0; let writes = 0;
    globalThis.fetch = async input => {
      if (String(input) === '/api/session') return response(++sessions === 1
        ? { ...initial, learningProtocolVersion: 3 }
        : { ...initial, writeToken: 'unknown-scope-renewed', learningProtocolVersion: 2 });
      writes++; return response({ error: { code: 'TOKEN_REQUIRED' } }, 401);
    };
    await assert.rejects(writeJson('/observations', { eventId: 'unknown-frozen' }, initial.writeToken, initial.sourceId), { code: 'LEARNING_PROTOCOL_REQUIRED' });
    assert.equal(writes, 1); assert.equal(sessions, 2);
  } finally { globalThis.fetch = original; configureSessionScope(null); }
});

test('late error bodies cannot notify or sign out a newer scope', async () => {
  const original = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const events: string[] = []; const notices: unknown[] = [];
  const unsubscribe = subscribeToSessionRecovery(event => notices.push(event));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent: (event: Event) => { events.push(event.type); return true; } } });
  try {
    for (const code of ['AUTH_REQUIRED', 'SOURCE_MISMATCH', 'INSTANCE_MISMATCH']) {
      const a = { writeToken: `error-old-${code}`, sourceId: `error-${code}`, learningProtocolVersion: 2 as const };
      const b = { ...a, writeToken: `error-new-${code}`, learningProtocolVersion: 3 as const };
      configureSessionScope(a);
      let started!: () => void; const reading = new Promise<void>(resolve => { started = resolve; });
      let resolve!: (value: unknown) => void; const body = new Promise(done => { resolve = done; });
      globalThis.fetch = async input => {
        if (String(input) === '/api/session') return response(a);
        const result = response({}, 401);
        Object.defineProperty(result, 'json', { value: () => { started(); return body; } }); return result;
      };
      await api.getSession();
      const old = api.adminRequest('/admin/users', {}, a.writeToken, a.sourceId);
      const rejected = assert.rejects(old, { code: 'INSTANCE_MISMATCH' });
      await reading; configureSessionScope(b); resolve({ error: { code } }); await rejected;
    }
    assert.deepEqual(events, []); assert.deepEqual(notices, []);
  } finally {
    unsubscribe(); globalThis.fetch = original; configureSessionScope(null);
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});
