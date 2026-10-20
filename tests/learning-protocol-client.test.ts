import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, configureSessionScope, writeJson } from '../src/web/api.ts';
import { runCli } from '../src/cli/index.js';
import { LEARNING_PROTOCOL_HEADER, supportsLearningProtocol } from '../src/shared/learning-protocol.js';
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('Web refuses missing, old or future server handshake before any protected request, including direct API reads', async () => {
  const original = globalThis.fetch;
  try {
    for (const version of [undefined, 1, 3, '2', null]) {
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
    for (const call of calls) assert.equal(call.headers.get(LEARNING_PROTOCOL_HEADER), '2');
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
    for (const version of [undefined, 1, 3, '2']) {
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
    for (const call of calls) assert.equal(call.headers.get(LEARNING_PROTOCOL_HEADER), '2');
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
