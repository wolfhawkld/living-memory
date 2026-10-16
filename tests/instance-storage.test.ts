import assert from 'node:assert/strict';
import test from 'node:test';
import { instanceStorage, instanceStorageKey } from '../src/web/instance-storage.js';
import { briefReviewCheckpointKey, clearBriefReviewCheckpoint, readBriefReviewCheckpoint, writeBriefReviewCheckpoint, type BriefReviewCheckpoint } from '../src/web/brief-review-checkpoint.js';
import { SOURCE_EXPOSURE_STORAGE_KEY, parseSourceExposure, sourceExposureKey } from '../src/web/source-exposure.js';
function memory() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

test('instance storage retains exact legacy key bytes and reversible encoded instance suffix', () => {
  for (const key of ['living-memory.brief-review-checkpoint.v1:source%2Fa', SOURCE_EXPOSURE_STORAGE_KEY]) {
    assert.equal(instanceStorageKey(key), key);
    assert.equal(instanceStorageKey(key, 'legacy'), key);
    assert.equal(instanceStorageKey(key, 'restored/中文'), `${key}:instance:restored%2F%E4%B8%AD%E6%96%87`);
    assert.notEqual(instanceStorageKey(key, 'restored/中文'), instanceStorageKey(key, 'restored%2F中文'));
  }
});

test('brief checkpoints retain sourceID payload and original bytes while restored instance starts empty', () => {
  const storage = memory(), legacy = instanceStorage(storage), restored = instanceStorage(storage, 'restored');
  const sourceId = 'same-source';
  const checkpoint: BriefReviewCheckpoint = { version: 1, savedAt: '2026-10-16T08:00:00.000Z', attempt: null,
    session: { id: 'original-session', sourceId, domainId: 'Math', index: 0, results: {}, reviews: {},
      items: [{ conceptId: 'same-concept', title: 'Concept', sourceRevision: 'same-revision', status: 'stale', elapsedDays: 10, estimated: false }] } };
  writeBriefReviewCheckpoint(sourceId, checkpoint, legacy);
  const key = briefReviewCheckpointKey(sourceId), original = storage.values.get(key);
  assert.ok(original);
  assert.equal(readBriefReviewCheckpoint(sourceId, restored), null);
  const next = { ...checkpoint, session: { ...checkpoint.session, id: 'restored-session' } };
  writeBriefReviewCheckpoint(sourceId, next, restored);
  assert.equal(readBriefReviewCheckpoint(sourceId, restored)?.session.sourceId, sourceId);
  assert.equal(readBriefReviewCheckpoint(sourceId, restored)?.session.id, 'restored-session');
  clearBriefReviewCheckpoint(sourceId, restored);
  assert.equal(readBriefReviewCheckpoint(sourceId, restored), null);
  assert.equal(storage.values.get(key), original);
  assert.equal(readBriefReviewCheckpoint(sourceId, legacy)?.session.id, 'original-session');
});

test('source exposure adapters remain frozen to instance and never copy old exposure into restored scope', () => {
  const storage = memory(), old = instanceStorage(storage), restored = instanceStorage(storage, 'restored');
  const key = sourceExposureKey('same-source', { id: 'same-concept', source: { path: 'Alpha.md', revision: 'same-revision' } });
  const bytes = JSON.stringify([key]);
  old.setItem(SOURCE_EXPOSURE_STORAGE_KEY, bytes);
  assert.deepEqual(parseSourceExposure(restored.getItem(SOURCE_EXPOSURE_STORAGE_KEY)), []);
  restored.setItem(SOURCE_EXPOSURE_STORAGE_KEY, bytes);
  restored.removeItem(SOURCE_EXPOSURE_STORAGE_KEY);
  assert.equal(old.getItem(SOURCE_EXPOSURE_STORAGE_KEY), bytes);
  // Late writes through an already-created wrapper retain their original key.
  old.setItem(SOURCE_EXPOSURE_STORAGE_KEY, JSON.stringify([key, key]));
  assert.equal(restored.getItem(SOURCE_EXPOSURE_STORAGE_KEY), null);
  assert.deepEqual(parseSourceExposure(old.getItem(SOURCE_EXPOSURE_STORAGE_KEY)), [key, key]);
});
