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

test('a rejected old epoch cannot cancel a verified settings commit waiting for the real queue lock', async () => {
  const { createActivityQueue } = await import('../src/web/activity-queue.js');
  const gate = createActivitySettingsGate();
  gate.setScope('owner:source:session');
  const next = { enabled: true, epoch: 1, revision: 1 };
  const ticket = gate.beginCommit(next, true)!;
  const values = new Map<string, string>();
  let release!: () => void;
  const queue = createActivityQueue({
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } },
    withStorageLock<T>(_scope: string, action: () => T): Promise<T> {
      return new Promise<T>((resolve, reject) => { release = () => {
        try { resolve(action()); } catch (error) { reject(error); }
      }; });
    },
    withSyncLock: async (_scope, action) => action(),
    transport: { async append() { throw new Error('settings reconciliation must not send events'); } },
  });
  queue.setContext({ accountId: 'owner', sourceId: 'source', authenticated: true, mode: 'real', settings: next });
  const applying = queue.applySettings(next);
  assert.equal(gate.beginCommit({ enabled: true, epoch: 0, revision: 0 }, true), null);
  assert.equal(ticket.isCurrent(), true);
  release();
  assert.deepEqual(await applying, { applied: true });
  // This is the production gate decision used by the hook before publishing.
  const published = ticket.isCurrent() ? gate.snapshot() : null;
  assert.deepEqual(published, { settings: next, suspended: false });
  assert.equal(values.size, 1);
});

test('invalid settings leave an accepted commit current while every valid acceptance supersedes it', () => {
  const gate = createActivitySettingsGate(); gate.setScope('owner:source:session');
  const next = { enabled: true, epoch: 1, revision: 1 };
  const ticket = gate.beginCommit(next, true)!;
  assert.equal(gate.beginCommit({ ...next, epoch: -1 }, true), null);
  assert.equal(ticket.isCurrent(), true);
  assert.equal(gate.accept({ ...next, enabled: false }, true), false);
  assert.equal(ticket.isCurrent(), true);
  assert.equal(gate.accept(next, true), true);
  assert.equal(ticket.isCurrent(), false);
  const newer = gate.beginCommit({ enabled: false, epoch: 2, revision: 2 }, true)!;
  const newest = gate.beginCommit({ enabled: true, epoch: 3, revision: 3 }, true)!;
  assert.equal(newer.isCurrent(), false); assert.equal(newest.isCurrent(), true);
});

test('scope, control and unknown results invalidate commits without allowing a late success to resume capture', () => {
  for (const transition of ['scope', 'control', 'uncertain'] as const) {
    const gate = createActivitySettingsGate(); gate.setScope('owner:source:session');
    const next = { enabled: true, epoch: 0, revision: 0 };
    const ticket = gate.beginCommit(next, true)!;
    gate.setScope('owner:source:session');
    assert.equal(ticket.isCurrent(), true);
    if (transition === 'scope') gate.setScope('member:source:new-session');
    else if (transition === 'control') { gate.beginControl(); gate.endControl(); }
    else gate.markUncertain();
    assert.equal(ticket.isCurrent(), false);
    if (transition === 'scope') assert.deepEqual(gate.snapshot(), { settings: null, suspended: false });
    else assert.deepEqual(gate.snapshot(), { settings: next, suspended: true });
  }
});
