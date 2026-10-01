import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDeviceSession } from '../src/cli/device-session.js';

test('private CLI device credential only targets its own service and rejects expired or broadly readable files', () => {
  const root = mkdtempSync(join(tmpdir(), 'lm-device-test-'));
  const file = join(root, 'session.json');
  const token = 'a'.repeat(64);
  try {
    assert.equal(readDeviceSession(file, 'http://127.0.0.1:4317'), undefined);
    writeFileSync(file, JSON.stringify({ version: 1, baseUrl: 'http://127.0.0.1:4317', sessionToken: token, expiresAt: '2030-01-01T00:00:00Z' }), { mode: 0o600 });
    assert.equal(readDeviceSession(file, 'http://127.0.0.1:4317', 0), token);
    assert.equal(readDeviceSession(file, 'http://127.0.0.1:5000', 0), undefined);
    assert.throws(() => readDeviceSession(file, 'http://127.0.0.1:4317', Date.parse('2031-01-01T00:00:00Z')), /过期/);
    if (process.platform !== 'win32') {
      chmodSync(file, 0o644);
      assert.throws(() => readDeviceSession(file, 'http://127.0.0.1:4317'), /私有/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
