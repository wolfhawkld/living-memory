import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDeferredChangeController,
  parseChangeNotification,
  subscribeToChanges,
  type ChangeEventSource,
} from '../src/web/change-sync.ts';

class FakeEventSource implements ChangeEventSource {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  emit(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent<string>);
  }

  close(): void {
    this.closed = true;
  }
}

test('change subscription handles unnamed frames, reconnects, and closes cleanly', () => {
  const source = new FakeEventSource();
  const changes: unknown[] = [];
  const connections: boolean[] = [];
  const unsubscribe = subscribeToChanges({
    createEventSource: () => source,
    onChange: (notification) => changes.push(notification),
    onConnected: (_notification, reconnected) => connections.push(reconnected),
  });

  source.emit({ sourceId: 'source-a', revision: 0, reason: 'connected' });
  source.emit({ sourceId: 'source-a', revision: 1, reason: 'review' });
  source.emit({ sourceId: 'source-a', revision: 2, reason: 'config' });
  source.emit({ sourceId: 'source-a', revision: 3, reason: 'retention' });
  source.emit({ sourceId: 'source-a', revision: 3, reason: 'named-event-is-ignored' });
  source.emit('not-json');
  source.emit({ sourceId: 'source-a', revision: 0, reason: 'connected' });

  assert.deepEqual(changes, [
    { sourceId: 'source-a', revision: 1, reason: 'review' },
    { sourceId: 'source-a', revision: 2, reason: 'config' },
    { sourceId: 'source-a', revision: 3, reason: 'retention' },
  ]);
  assert.deepEqual(connections, [false, true]);

  unsubscribe();
  assert.equal(source.closed, true);
  assert.equal(source.onmessage, null);
  assert.equal(source.onerror, null);
});

test('deferred change controller keeps the newest invalidation until a safe flush', () => {
  const controller = createDeferredChangeController<{ revision: number }>();
  assert.equal(controller.hasPending, false);
  controller.defer({ revision: 1 });
  controller.defer({ revision: 2 });
  assert.equal(controller.hasPending, true);
  const operation = controller.begin();
  assert.deepEqual(operation?.value, { revision: 2 });
  controller.defer({ revision: 3 });
  assert.equal(operation?.settle(true), true, 'a newer event remains eligible for a later flush');
  assert.deepEqual(controller.peek(), { revision: 3 });
  const failed = controller.begin();
  assert.deepEqual(failed?.value, { revision: 3 });
  assert.equal(failed?.settle(false), false, 'a failed read keeps the event without scheduling a retry');
  assert.deepEqual(controller.peek(), { revision: 3 });
  assert.deepEqual(controller.consume(), { revision: 3 });
  assert.equal(controller.hasPending, false);
});

test('change payload validation rejects namespace or revision drift', () => {
  assert.deepEqual(parseChangeNotification(JSON.stringify({ sourceId: 'a', revision: 4, reason: 'observation' })), {
    sourceId: 'a',
    revision: 4,
    reason: 'observation',
  });
  assert.equal(parseChangeNotification({ sourceId: '', revision: 1, reason: 'review' }), null);
  assert.equal(parseChangeNotification({ sourceId: 'a', revision: 1.5, reason: 'review' }), null);
  assert.equal(parseChangeNotification({ sourceId: 'a', revision: 1, reason: 'layout' }), null);
});
