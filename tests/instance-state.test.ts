import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readInstanceId, isRestoreQuarantined } from '../src/server/instance-state.js';

test('only a missing instance file means legacy and any existing malformed identity fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-instance-state-'));
  try {
    assert.equal(readInstanceId(dir), 'legacy');
    for (const value of [null, false, 0, {}, { format: 'living-memory-instance-identity', version: 1, instanceId: '-'.repeat(36) }]) {
      writeFileSync(join(dir, 'instance-identity.json'), JSON.stringify(value), { mode: 0o600 });
      assert.throws(() => readInstanceId(dir));
    }
    writeFileSync(join(dir, 'instance-identity.json'), JSON.stringify({ format: 'living-memory-instance-identity', version: 1, instanceId: '12345678-1234-4234-8234-123456789abc' }), { mode: 0o600 });
    assert.equal(readInstanceId(dir), '12345678-1234-4234-8234-123456789abc');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('quarantine cannot be disabled by null, malformed or incomplete restored state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-instance-quarantine-'));
  try {
    assert.equal(isRestoreQuarantined(dir), false);
    for (const value of [null, false, 0, {}, { format: 'living-memory-restore-quarantine', version: 1, connectorsBlocked: false }]) {
      writeFileSync(join(dir, 'restore-quarantine.json'), JSON.stringify(value), { mode: 0o600 });
      assert.equal(isRestoreQuarantined(dir), true);
    }
    const state = { format: 'living-memory-restore-quarantine', version: 1, restoredAt: '2026-10-16T00:00:00Z', connectorsBlocked: true };
    writeFileSync(join(dir, 'restore-quarantine.json'), JSON.stringify(state), { mode: 0o600 }); assert.equal(isRestoreQuarantined(dir), true);
    writeFileSync(join(dir, 'restore-quarantine.json'), JSON.stringify({ ...state, connectorsBlocked: false }), { mode: 0o600 }); assert.equal(isRestoreQuarantined(dir), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
