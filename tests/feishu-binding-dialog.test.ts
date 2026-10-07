import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FeishuBindingStatus, FeishuChannelState } from '../src/shared/feishu-binding.js';
import { FeishuBindingDialog, createFeishuBindingGate, feishuBindingCanIssue, feishuBindingPending, feishuBindingShouldPoll } from '../src/web/FeishuBindingDialog.js';

const now = Date.parse('2026-10-02T00:00:00Z');
function status(overrides: Partial<FeishuBindingStatus> = {}): FeishuBindingStatus {
  return { scope: { appId: 'app-test', tenantKey: 'tenant-test' }, channelState: 'connected', binding: null,
    request: { id: 'request-test', status: 'pending', expiresAt: new Date(now + 10_000).toISOString(), confirmedAt: null }, ...overrides };
}

test('binding dialog SSR is accessible, names current account, and describes current browsing and review entry points', () => {
  const html = renderToStaticMarkup(createElement(FeishuBindingDialog, {
    accountLabel: 'synthetic-user', sourceId: 'synthetic-space', writeToken: 'secret-session-token', onClose: () => undefined,
  }));
  assert.match(html, /<dialog[^>]*aria-labelledby=/);
  assert.match(html, /synthetic-user/);
  assert.match(html, /「知识 卡片」点击浏览，或「知识 待复习」查看候选/);
  assert.match(html, /「知识 复习 3」或「知识 复习 5」开始小批次复习/);
  assert.match(html, /脑中自评可保存，单独确认已重温才更新记忆时间/);
  assert.match(html, /读取绑定状态中/);
  assert.doesNotMatch(html, /secret-session-token|synthetic-space|textarea|LM-/);
});

test('new read or mutation invalidates previous read and its AbortSignal', () => {
  const gate = createFeishuBindingGate();
  const first = gate.begin();
  const copyCheckpoint = gate.checkpoint();
  const second = gate.begin();
  assert.equal(first.signal.aborted, true);
  assert.equal(first.current(), false);
  assert.equal(copyCheckpoint(), false);
  assert.equal(second.signal.aborted, false);
  assert.equal(second.current(), true);
});

test('close or identity cleanup discards a late mutation result even when transport cannot abort it', async () => {
  const gate = createFeishuBindingGate();
  const mutation = gate.begin();
  let resolve!: () => void;
  const response = new Promise<void>((done) => { resolve = done; });
  let applied = false;
  const completion = response.then(() => { if (mutation.current()) applied = true; });
  gate.invalidate();
  resolve();
  await completion;
  assert.equal(applied, false);
  assert.equal(mutation.signal.aborted, true);
  assert.equal(gate.begin().current(), true);
});

test('pending command visibility ends exactly at the server expiry without a client TTL assumption', () => {
  const value = status();
  assert.equal(feishuBindingPending(value, now + 9_999), true);
  assert.equal(feishuBindingPending(value, now + 10_000), false);
  assert.equal(feishuBindingPending(value, now + 60_000), false);
  assert.equal(feishuBindingPending(status({ request: { ...value.request!, expiresAt: 'invalid' } }), now), false);
});

test('confirmed, cancelled, expired and invalidated server responses hide the command immediately', () => {
  const value = status();
  for (const requestStatus of ['confirmed', 'cancelled', 'expired', 'invalidated'] as const) {
    assert.equal(feishuBindingPending(status({ request: { ...value.request!, status: requestStatus } }), now), false);
  }
  assert.equal(feishuBindingPending(status({ binding: {
    id: 'binding-test', appId: 'app-test', tenantKey: 'tenant-test', openId: 'actor-test', boundAt: new Date(now).toISOString(),
  } }), now), false);
});

test('only a connected channel and unbound user can issue; pending requests may be explicitly replaced', () => {
  for (const channelState of ['disabled', 'starting', 'reconnecting', 'error', 'stopped'] as FeishuChannelState[]) {
    assert.equal(feishuBindingCanIssue(status({ channelState })), false);
  }
  assert.equal(feishuBindingCanIssue(status()), true);
  assert.equal(feishuBindingCanIssue(status({ request: null })), true);
  assert.equal(feishuBindingCanIssue(null), false);
  assert.equal(feishuBindingCanIssue(status({ scope: null })), false);
  assert.equal(feishuBindingCanIssue(status({ binding: {
    id: 'binding-test', appId: 'app-test', tenantKey: 'tenant-test', openId: 'actor-test', boundAt: new Date(now).toISOString(),
  } })), false);
});

test('binding stylesheet works without the semantic overrides supplied only by the light theme', () => {
  const css = readFileSync(new URL('../src/web/feishu-binding.css', import.meta.url), 'utf8');
  const references = [...css.matchAll(/var\((--ui-[\w-]+)\s*([,)])/g)];
  assert.ok(references.length > 0);
  assert.deepEqual(references.filter((match) => match[2] !== ',').map((match) => match[1]), [],
    'each semantic override requires a dark fallback when the default theme does not define it');
});

test('automatic polling requires a visible page, no mutation, and an unexpired pending server request', () => {
  assert.equal(feishuBindingShouldPoll(status(), now, true, false), true);
  assert.equal(feishuBindingShouldPoll(status(), now, false, false), false);
  assert.equal(feishuBindingShouldPoll(status(), now, true, true), false);
  assert.equal(feishuBindingShouldPoll(status(), now + 10_000, true, false), false);
  assert.equal(feishuBindingShouldPoll(status({ request: null }), now, true, false), false);
  for (const requestStatus of ['confirmed', 'cancelled', 'expired', 'invalidated'] as const) {
    assert.equal(feishuBindingShouldPoll(status({ request: { ...status().request!, status: requestStatus } }), now, true, false), false);
  }
  // A reconnecting channel can still query an existing request, but expiry still stops it even if offline.
  assert.equal(feishuBindingShouldPoll(status({ channelState: 'reconnecting' }), now, true, false), true);
  assert.equal(feishuBindingShouldPoll(status({ channelState: 'error' }), now + 10_000, true, false), false);
});
