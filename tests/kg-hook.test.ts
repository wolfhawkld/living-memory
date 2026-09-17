import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyHookInstall, planHookInstall } from '../src/integrations/install-kg-hook.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'living-memory hook '));
  mkdirSync(join(root, '_system'));
  writeFileSync(join(root, 'AGENTS.md'), '# 我的知识库\n\n保留我的操作规则。\n');
  writeFileSync(join(root, 'SCHEMA.md'), '# Schema\n');
  writeFileSync(join(root, '_system', 'OPERATIONS.md'), '# Operations\n');
  writeFileSync(join(root, 'concept.md'), '原始概念正文');
  return root;
}

test('hook installation preserves existing instructions and knowledge; reinstall is idempotent', () => {
  const root = fixture();
  try {
    const before = readFileSync(join(root, 'concept.md'), 'utf8');
    const plan = planHookInstall(root);
    assert.equal(plan.files.length, 4);
    applyHookInstall(plan);
    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    assert.ok(agents.startsWith('# 我的知识库\n\n保留我的操作规则。'));
    assert.ok(agents.includes('不代表用户已经重温或掌握'));
    assert.ok(!agents.includes(process.cwd()));
    assert.equal(readFileSync(join(root, 'concept.md'), 'utf8'), before);
    assert.ok(readFileSync(join(root, '.gitignore'), 'utf8').includes('/_system/living-memory.local.json'));
    assert.deepEqual(planHookInstall(root).files, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hook installer refuses a changed preimage or an unmanaged existing script', () => {
  const root = fixture();
  try {
    const plan = planHookInstall(root);
    writeFileSync(join(root, 'AGENTS.md'), '# User edited this concurrently\n');
    assert.throws(() => applyHookInstall(plan), /发生变化/);
    assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), '# User edited this concurrently\n');
    writeFileSync(join(root, '_system', 'living_memory_hook.py'), '# user-owned script\n');
    assert.throws(() => planHookInstall(root), /未覆盖/);
    assert.throws(() => planHookInstall(root, 'https://example.com'), /回环/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installed Python hook forwards arguments without shell evaluation and preserves CLI failure', () => {
  const root = fixture();
  try {
    applyHookInstall(planHookInstall(root));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const log = join(root, 'argv.json');
    writeFileSync(join(bin, 'npm'), '#!/usr/bin/env python3\nimport json,os,sys\nwith open(os.environ["LM_HOOK_TEST_LOG"], "w") as f: json.dump(sys.argv[1:],f)\nsys.exit(int(os.environ.get("LM_HOOK_TEST_EXIT", "0")))\n', { mode: 0o755 });
    const hook = join(root, '_system', 'living_memory_hook.py');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LM_HOOK_TEST_LOG: log };
    execFileSync('python3', [hook, 'query', '--operation-id', 'literal-$(false)'], { env });
    const argv = JSON.parse(readFileSync(log, 'utf8')) as string[];
    assert.equal(argv[argv.indexOf('--operation-id') + 1], 'literal-$(false)');
    assert.equal(argv[argv.indexOf('--source-root') + 1], root);
    assert.deepEqual(argv.slice(argv.indexOf('after'), argv.indexOf('after') + 2), ['after', 'query']);
    assert.ok(!argv.includes('review'));
    assert.throws(() => execFileSync('python3', [hook, 'ingest', '--operation-id', 'op-2'], {
      env: { ...env, LM_HOOK_TEST_EXIT: '7' }, stdio: 'pipe',
    }), (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === 7);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installer preserves edits inside managed files and refuses a redirected system directory', () => {
  const root = fixture();
  const other = fixture();
  try {
    applyHookInstall(planHookInstall(root));
    const agents = join(root, 'AGENTS.md');
    const before = readFileSync(agents, 'utf8');
    writeFileSync(agents, before.replace('<!-- living-memory:end -->', '用户的额外规则\n<!-- living-memory:end -->'));
    assert.throws(() => planHookInstall(root), /未覆盖/);
    writeFileSync(agents, before);
    const hook = join(root, '_system', 'living_memory_hook.py');
    writeFileSync(hook, `${readFileSync(hook, 'utf8')}\n# user edit\n`);
    assert.throws(() => planHookInstall(root), /未覆盖/);

    rmSync(join(root, '_system'), { recursive: true });
    symlinkSync(join(other, '_system'), join(root, '_system'), 'dir');
    assert.throws(() => planHookInstall(root), /符号链接/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
