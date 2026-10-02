import assert from 'node:assert/strict';
import test from 'node:test';
import { offlineProbeCommand, runOfflineProbe } from '../scripts/feishu-probe-offline.js';

test('offline probe runs only synthetic protocol examples and labels real platform verification incomplete', () => {
  const report = runOfflineProbe();
  assert.equal(report.mode, 'offline');
  assert.equal(report.platformVerified, false);
  assert.equal(report.authentication, 'not-performed');
  assert.equal(report.knowledgeAccessed, false);
  assert.equal(report.learningWrites, 0);
  assert.equal(report.transport, 'none');
  assert.equal(report.passed, report.total);
  assert.ok(report.total >= 10);
  assert.equal(report.duplicateReceiptReused, true);
});

test('offline command rejects live, file and credential arguments without echoing their values', () => {
  for (const args of [['--send'], ['--live'], ['--source', '/private/synthetic-path'], ['--secret', 'synthetic-secret']]) {
    const output: string[] = [];
    assert.equal(offlineProbeCommand(args, (text) => output.push(text)), 2);
    assert.equal(output.length, 1);
    assert.ok(!output[0].includes('synthetic-secret'));
    assert.ok(!output[0].includes('/private/synthetic-path'));
    assert.throws(() => JSON.parse(output[0]));
  }
});

test('offline command exposes a working help path and machine-readable synthetic report', () => {
  const help: string[] = [];
  assert.equal(offlineProbeCommand(['--help'], (text) => help.push(text)), 0);
  assert.match(help[0], /feishu:probe:offline/);
  const output: string[] = [];
  assert.equal(offlineProbeCommand([], (text) => output.push(text)), 0);
  const report = JSON.parse(output[0]);
  assert.equal(report.mode, 'offline');
  assert.equal(report.platformVerified, false);
  assert.equal(report.card.schema, '2.0');
});
