import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { previewSourceReconnect } from '../src/integrations/source-reconnect-preview.js';
import { runSourceReconnectPreviewCli, sourceReconnectPreviewMain } from '../scripts/source-reconnect-preview.js';
import { loadKnowledgeGraph } from '../src/server/kg.js';
import { applyHookInstall, planHookInstall } from '../src/integrations/install-kg-hook.js';

const instanceId = 'e296df78-0c09-4dcb-9086-47174adecf0e';
const memberId = '47d676d7-cff9-4aa7-99d1-4fb06c431a6e';
const url = 'http://127.0.0.1:4329';
const secret = 'SYNTHETIC_SECRET_DO_NOT_PRINT_20261021';
const body = 'SYNTHETIC_PRIVATE_KNOWLEDGE_BODY_20261021';
const ownerHash = 'a'.repeat(64);
const memberHash = 'b'.repeat(64);
function privateJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}
function note(root: string, name: string, content = body) {
  writeFileSync(join(root, name + '.md'), `---\ntype: concept\ntitle: ${name}\n---\n# ${name}\n\n${content}\n`);
}
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'lm-source-reconnect '));
  const instanceRoot = join(base, 'instance'), data = join(instanceRoot, 'data');
  const before = join(instanceRoot, 'knowledge/owner'), after = join(base, 'original kg');
  const member = join(data, 'users', memberId, 'knowledge');
  for (const directory of [data, before, after, member, join(instanceRoot, 'cli'), join(instanceRoot, 'config')]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  for (const root of [before, after]) {
    mkdirSync(join(root, '_system'));
    writeFileSync(join(root, 'AGENTS.md'), '# Synthetic agent instructions\n');
    writeFileSync(join(root, 'SCHEMA.md'), '# Synthetic schema\n');
    writeFileSync(join(root, '_system/OPERATIONS.md'), '# Synthetic operations\n');
    note(root, 'Alpha', body + '\n\n## 关系网络\n- 相关：[[Beta]] — Synthetic relation');
    note(root, 'Beta');
  }
  const registry = { format: 'living-memory-source-identities', version: 1,
    entries: [{ physicalRoot: before, identityHash: ownerHash, displayName: 'Synthetic owner' },
      { physicalRoot: member, identityHash: memberHash, displayName: 'Synthetic member' }] };
  const report = { format: 'living-memory-restore-report', version: 1, restoredAt: '2026-10-21T03:04:12.000Z', instanceId,
    files: 12, sources: 2, invalidated: { sessions: 0, pendingBindingCodes: 0, activeCards: 0,
      activeReviews: 0, pendingReviewIntents: 0, unknownReadReceipts: 0 }, schemaMigrations: ['learning-schema-v2'],
    connectorsBlocked: true, browserState: 'not-included', startup: { dataDir: data, kgRoot: before,
      cliStateDir: join(instanceRoot, 'cli'), envArchive: join(instanceRoot, 'config/environment.env') } };
  privateJson(join(data, 'source-identities.json'), registry);
  privateJson(join(data, 'instance-identity.json'), { format: 'living-memory-instance-identity', version: 1, instanceId });
  privateJson(join(data, 'restore-quarantine.json'), { format: 'living-memory-restore-quarantine', version: 1,
    restoredAt: report.restoredAt, connectorsBlocked: true });
  privateJson(join(instanceRoot, 'restore-report.json'), report);
  // Deliberately invalid credentials/config: preview must not interpret these.
  writeFileSync(join(data, 'cli-session.json'), secret, { mode: 0o600 });
  writeFileSync(join(instanceRoot, 'config/environment.env'), `API_KEY=${secret}\n`, { mode: 0o600 });
  return { base, instanceRoot, data, before, after, member, registry, report,
    options: { instanceRoot, kgRoot: after, serverUrl: url, projectRoot: process.cwd() },
    close: () => rmSync(base, { recursive: true, force: true }) };
}
function inventory(root: string): string[] {
  const result: string[] = [];
  function visit(directory: string, prefix: string) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), relative = prefix + name, stat = lstatSync(path);
      if (stat.isSymbolicLink()) result.push(`${relative}:link:${readlinkSync(path)}`);
      else if (stat.isDirectory()) { result.push(`${relative}:dir:${stat.mode}`); visit(path, relative + '/'); }
      else result.push(`${relative}:file:${stat.mode}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
    }
  }
  visit(root, '');
  return result;
}
function assertCode(operation: () => unknown, code: string) {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error && typeof error === 'object' && 'code' in error);
    assert.equal(error.code, code);
    return true;
  });
}
function safeOutput(text: string) {
  for (const forbidden of [secret, body, 'before":"#', 'after":"#', 'sessionToken', 'password_hash']) {
    assert.ok(!text.includes(forbidden), 'preview output must contain metadata only');
  }
}

test('reconnect preview preserves cross-root concept IDs and member identities without writing any fixture file', () => {
  const f = fixture();
  try {
    const initial = inventory(f.base);
    const result = previewSourceReconnect(f.options);
    assert.equal(result.format, 'living-memory-source-reconnect-preview');
    assert.equal(result.version, 1);
    assert.equal(result.status, 'reviewable');
    assert.equal(result.source.namespace, `kg_${ownerHash.slice(0, 48)}`);
    assert.equal(result.source.identityHash, ownerHash);
    assert.equal(result.source.fromRoot, f.before);
    assert.equal(result.source.toRoot, f.after);
    assert.notEqual(result.source.fromFingerprint, result.source.toFingerprint);
    assert.equal(result.source.displayName, 'Synthetic owner');
    assert.deepEqual(result.proposedRegistry.entries, [
      { ...f.registry.entries[0], physicalRoot: f.after }, f.registry.entries[1],
    ]);
    assert.deepEqual(result.knowledge.before, { concepts: 2, links: 1 });
    assert.deepEqual(result.knowledge.after, { concepts: 2, links: 1 });
    assert.equal(result.knowledge.commonConcepts, 2);
    assert.equal(result.knowledge.addedConcepts, 0);
    assert.equal(result.knowledge.missingConcepts, 0);
    assert.equal(result.knowledge.changedVersions, 0);
    assert.equal(result.knowledge.stableIdsPreserved, true);
    const oldSource = loadKnowledgeGraph({ root: f.before, identityHash: ownerHash });
    const newSource = loadKnowledgeGraph({ root: f.after, identityHash: result.source.identityHash });
    assert.deepEqual(newSource.index.concepts.map(concept => concept.id), oldSource.index.concepts.map(concept => concept.id));
    assert.equal(result.hook.status, 'planned');
    assert.equal(result.hook.runtimeDirectoriesSupported, true);
    assert.equal(result.hook.runtimeConfiguration, 'planned');
    assert.ok(result.hook.files.some(file => file.path === '_system/living-memory.local.json' && file.localOnly));
    assert.deepEqual(result.runtime, { LM_DATA_DIR: f.data, LM_CLI_STATE_DIR: join(f.instanceRoot, 'cli'),
      LM_CLI_SESSION_FILE: join(f.data, 'cli-session.json'), LM_SERVER_URL: url, LM_KG_ROOT: f.after, LM_FEISHU_ENABLED: '0', LM_LEARNING_SCHEMA_VERSION: '2' });
    assert.ok(result.limitations.length > 0);
    safeOutput(JSON.stringify(result));
    assert.deepEqual(inventory(f.base), initial);
  } finally { f.close(); }
});

test('reconnect preview counts added, missing and changed material independently of preserved IDs', () => {
  const f = fixture();
  try {
    note(f.after, 'Alpha', 'Changed synthetic material');
    rmSync(join(f.after, 'Beta.md'));
    note(f.after, 'Gamma');
    const initial = inventory(f.base), result = previewSourceReconnect(f.options);
    assert.equal(result.knowledge.before.concepts, 2);
    assert.equal(result.knowledge.after.concepts, 2);
    assert.equal(result.knowledge.commonConcepts, 1);
    assert.equal(result.knowledge.addedConcepts, 1);
    assert.equal(result.knowledge.missingConcepts, 1);
    assert.equal(result.knowledge.changedVersions, 1);
    assert.equal(result.knowledge.stableIdsPreserved, true);
    assert.deepEqual(inventory(f.base), initial);
  } finally { f.close(); }
});

test('preview never reads archived environment values or CLI credentials', t => {
  const f = fixture();
  const originalRead = fs.readFileSync;
  const forbidden = new Set([join(f.data, 'cli-session.json'), join(f.instanceRoot, 'config/environment.env')]);
  let forbiddenReads = 0;
  const mock = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    if (typeof args[0] === 'string' && forbidden.has(args[0])) {
      forbiddenReads++;
      throw new Error('Synthetic credentials must not be read');
    }
    return Reflect.apply(originalRead, fs, args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(previewSourceReconnect(f.options).status, 'reviewable');
    assert.equal(forbiddenReads, 0);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); f.close(); }
});

test('missing, corrupt or non-quarantined restore context is rejected without creating a database', () => {
  const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => rmSync(join(f.instanceRoot, 'restore-report.json')),
    f => writeFileSync(join(f.instanceRoot, 'restore-report.json'), '{broken'),
    f => privateJson(join(f.instanceRoot, 'restore-report.json'), { ...f.report, startup: { ...f.report.startup, dataDir: '/wrong/data' } }),
    f => privateJson(join(f.instanceRoot, 'restore-report.json'), { ...f.report, schemaMigrations: ['unsupported'] }),
    f => privateJson(join(f.data, 'restore-quarantine.json'), { format: 'living-memory-restore-quarantine', version: 1,
      restoredAt: f.report.restoredAt, connectorsBlocked: false }),
    f => privateJson(join(f.data, 'instance-identity.json'), { format: 'living-memory-instance-identity', version: 1,
      instanceId: '90b927de-3c3e-4f54-b00f-9927a2fb90ca' }),
  ];
  for (const change of changes) {
    const f = fixture();
    try {
      change(f); const initial = inventory(f.base);
      assertCode(() => previewSourceReconnect(f.options), 'RESTORE_CONTEXT_INVALID');
      assert.deepEqual(inventory(f.base), initial);
      assert.ok(!inventory(f.base).some(path => path.includes('.sqlite')));
    } finally { f.close(); }
  }
});

test('missing or malformed registries, missing owner mappings and duplicate identity seeds fail closed', () => {
  for (const mode of ['broken', 'duplicate-seed', 'missing-registry', 'owner-missing'] as const) {
    const f = fixture();
    try {
      if (mode === 'broken') writeFileSync(join(f.data, 'source-identities.json'), '{broken');
      if (mode === 'missing-registry') rmSync(join(f.data, 'source-identities.json'));
      if (mode === 'owner-missing') {
        privateJson(join(f.data, 'source-identities.json'), { ...f.registry, entries: [f.registry.entries[1]] });
        privateJson(join(f.instanceRoot, 'restore-report.json'), { ...f.report, sources: 1 });
      }
      if (mode === 'duplicate-seed') privateJson(join(f.data, 'source-identities.json'), { ...f.registry, entries: [f.registry.entries[0],
        { ...f.registry.entries[1], identityHash: ownerHash.slice(0, 24) + 'c'.repeat(40) }] });
      const initial = inventory(f.base);
      assertCode(() => previewSourceReconnect(f.options), 'SOURCE_REGISTRY_INVALID');
      assert.deepEqual(inventory(f.base), initial);
    } finally { f.close(); }
  }
});

test('a proposed root already assigned to a member cannot acquire the owner identity', () => {
  const f = fixture();
  try {
    const initial = inventory(f.base);
    assertCode(() => previewSourceReconnect({ ...f.options, kgRoot: f.member }), 'SOURCE_IDENTITY_CONFLICT');
    assert.deepEqual(inventory(f.base), initial);
  } finally { f.close(); }
});

test('missing knowledge roots are rejected with a fixed error code', () => {
  const f = fixture();
  try {
    assertCode(() => previewSourceReconnect({ ...f.options, kgRoot: join(f.base, 'missing') }), 'KNOWLEDGE_SOURCE_INVALID');
  } finally { f.close(); }
});

test('modified hook scripts, managed markers and redirected hook paths produce reviewable conflicts without overwriting', () => {
  for (const mode of ['script', 'markers', 'symlink'] as const) {
    const f = fixture();
    try {
      applyHookInstall(planHookInstall(f.after, url));
      if (mode === 'script') writeFileSync(join(f.after, '_system/living_memory_hook.py'), '# Synthetic user-owned hook\n' + secret);
      if (mode === 'markers') {
        const path = join(f.after, 'AGENTS.md');
        writeFileSync(path, readFileSync(path, 'utf8').replace('<!-- living-memory:end -->', secret + '\n<!-- living-memory:end -->'));
      }
      if (mode === 'symlink') {
        rmSync(join(f.after, '_system'), { recursive: true });
        symlinkSync(join(f.before, '_system'), join(f.after, '_system'), 'dir');
      }
      const initial = inventory(f.base), result = previewSourceReconnect(f.options);
      assert.equal(result.status, 'blocked');
      assert.equal(result.hook.status, 'conflict');
      assert.equal(result.hook.code, 'HOOK_PLAN_CONFLICT');
      assert.equal(result.hook.runtimeConfiguration, 'unavailable');
      safeOutput(JSON.stringify(result));
      assert.deepEqual(inventory(f.base), initial);
    } finally { f.close(); }
  }
});

test('preview validates loopback URLs and requires explicit arguments', () => {
  const f = fixture();
  try {
    for (const serverUrl of ['https://127.0.0.1:4329', 'http://example.com', 'http://127.0.0.1:4329/path',
      `http://user:${secret}@127.0.0.1:4329`, `http://127.0.0.1:4329/?token=${secret}`]) {
      assertCode(() => previewSourceReconnect({ ...f.options, serverUrl }), 'INVALID_RECONNECT_ARGUMENT');
    }
    assertCode(() => previewSourceReconnect({ ...f.options, instanceRoot: '' }), 'INVALID_RECONNECT_ARGUMENT');
  } finally { f.close(); }
});

test('CLI rejects unknown, duplicate, apply and missing flags and emits only fixed safe errors', async () => {
  const f = fixture();
  try {
    const valid = ['--instance-root', f.instanceRoot, '--kg-root', f.after, '--url', url];
    for (const args of [[], ['--instance-root'], [...valid, '--apply'], [...valid, '--url', url], [...valid, '--unknown', secret]]) {
      let out = '', err = '';
      const code = await sourceReconnectPreviewMain(args, { stdout: text => { out += text; }, stderr: text => { err += text; } });
      assert.equal(code, 1);
      assert.equal(out, '');
      assert.equal(JSON.parse(err).error.code, 'INVALID_RECONNECT_ARGUMENT');
      safeOutput(err);
      assert.ok(!err.includes(f.instanceRoot));
    }
    const result = await runSourceReconnectPreviewCli(valid);
    safeOutput(JSON.stringify(result));
    assert.equal(typeof await runSourceReconnectPreviewCli(['--help']), 'string');
  } finally { f.close(); }
});

test('real preview CLI subprocess returns metadata without writes, credentials, concept bodies or hook preimages', () => {
  const f = fixture();
  try {
    const initial = inventory(f.base);
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/source-reconnect-preview.ts',
      '--instance-root', f.instanceRoot, '--kg-root', f.after, '--url', url, '--project-root', process.cwd()],
    { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const result = JSON.parse(stdout);
    assert.equal(result.format, 'living-memory-source-reconnect-preview');
    assert.equal(result.status, 'reviewable');
    safeOutput(stdout);
    assert.deepEqual(inventory(f.base), initial);
  } finally { f.close(); }
});


test('metadata-only reconnect preserves explicit schema choice for new and historical v3 report shapes', () => {
  const f = fixture();
  try {
    for (const selected of [
      { migrations: [], startup: {}, candidate: undefined, version: '2' },
      { migrations: ['learning-schema-v2'], startup: { learningSchemaVersion: 2 }, candidate: undefined, version: '2' },
      ...[[], ['learning-schema-v3'], ['learning-schema-v2', 'learning-schema-v3']].flatMap(migrations => [
        { migrations, startup: { learningSchemaVersion: 3 }, candidate: { schemaVersion: 3, runtimeReady: true }, version: '3' },
        { migrations, startup: {}, candidate: { schemaVersion: 3, runtimeReady: false }, version: '3' },
      ]),
    ]) {
      const report = { ...f.report, schemaMigrations: selected.migrations, startup: { ...f.report.startup, ...selected.startup },
        ...(selected.candidate === undefined ? {} : { learningSchemaCandidate: selected.candidate }) };
      privateJson(join(f.instanceRoot, 'restore-report.json'), report);
      const before = inventory(f.base), preview = previewSourceReconnect(f.options);
      assert.equal(preview.runtime.LM_LEARNING_SCHEMA_VERSION, selected.version);
      assert.equal(preview.runtime.LM_FEISHU_ENABLED, '0');
      assert.ok(preview.limitations.includes('STATIC_BUILD_COMPATIBILITY_NOT_CHECKED'));
      assert.deepEqual(inventory(f.base), before, 'preview cannot rewrite legacy false reports, open databases or apply changes');
    }
  } finally { f.close(); }
});

test('reconnect rejects ambiguous schema metadata, malformed candidates and unknown or reordered migrations', () => {
  const f = fixture();
  try {
    const v3 = { schemaVersion: 3, runtimeReady: true };
    const rejected = [
      { schemaMigrations: [], startup: { learningSchemaVersion: 3 } },
      { schemaMigrations: ['learning-schema-v3'] },
      { schemaMigrations: ['learning-schema-v2', 'learning-schema-v2'] },
      { schemaMigrations: [], startup: { learningSchemaVersion: null } },
      { schemaMigrations: [], startup: { learningSchemaVersion: '2' } },
      ...[null, {}, { schemaVersion: 2, runtimeReady: true }, { ...v3, runtimeReady: 'true' }, { ...v3, extra: true }]
        .map(candidate => ({ schemaMigrations: [], startup: { learningSchemaVersion: 3 }, learningSchemaCandidate: candidate })),
      { schemaMigrations: [], learningSchemaCandidate: v3 },
      { schemaMigrations: [], startup: { learningSchemaVersion: 2 }, learningSchemaCandidate: v3 },
      { schemaMigrations: [], startup: { learningSchemaVersion: '3' }, learningSchemaCandidate: v3 },
      ...[['learning-schema-v2'], ['learning-schema-v3', 'learning-schema-v2'], ['learning-schema-v3', 'learning-schema-v3'], ['unknown']]
        .map(schemaMigrations => ({ schemaMigrations, startup: { learningSchemaVersion: 3 }, learningSchemaCandidate: v3 })),
      { schemaMigrations: [], startup: { learningSchemaVersion: 2 }, learningSchemaCandidate: { schemaVersion: 3, runtimeReady: false } },
    ];
    for (const partial of rejected) {
      privateJson(join(f.instanceRoot, 'restore-report.json'), { ...f.report, ...partial, startup: { ...f.report.startup, ...partial.startup } });
      const before = inventory(f.base);
      assertCode(() => previewSourceReconnect(f.options), 'RESTORE_CONTEXT_INVALID');
      assert.deepEqual(inventory(f.base), before);
    }
  } finally { f.close(); }
});
