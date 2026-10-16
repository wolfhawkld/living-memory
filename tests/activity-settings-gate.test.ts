import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createActivitySettingsGate } from '../src/web/activity-settings-gate.js';

test('late settings cannot roll back a known epoch, revision or consent value', () => {
  const gate = createActivitySettingsGate(); gate.setScope('owner:source:session');
  assert.equal(gate.accept({ enabled: true, epoch: 0, revision: 0 }, true), true);
  gate.beginControl(); gate.endControl();
  assert.equal(gate.accept({ enabled: false, epoch: 1, revision: 1 }, true), true);
  assert.equal(gate.accept({ enabled: true, epoch: 0, revision: 0 }, true), false);
  assert.equal(gate.accept({ enabled: true, epoch: 1, revision: 1 }, true), false);
  assert.deepEqual(gate.snapshot(), { settings: { enabled: false, epoch: 1, revision: 1 }, suspended: false });
});

test('unknown control results suspend capture until a verified server setting arrives after the control finishes', () => {
  const gate = createActivitySettingsGate(); gate.setScope('owner:source:session');
  gate.accept({ enabled: true, epoch: 0, revision: 0 }, true); gate.beginControl();
  gate.accept({ enabled: true, epoch: 0, revision: 0 }, true);
  assert.equal(gate.snapshot().suspended, true);
  gate.endControl(); assert.equal(gate.snapshot().suspended, true);
  gate.accept({ enabled: true, epoch: 1, revision: 1 }, true);
  assert.equal(gate.snapshot().suspended, false);
});

test('a new account, source or session forgets the previous setting without inventing consent or an epoch', () => {
  const gate = createActivitySettingsGate(); gate.setScope('owner:source:session');
  gate.accept({ enabled: true, epoch: 4, revision: 7 }, true); gate.beginControl();
  gate.setScope('member:source:new-session');
  assert.deepEqual(gate.snapshot(), { settings: null, suspended: false });
  assert.equal(gate.accept({ enabled: true, epoch: -1, revision: 0 }), false);
});
