import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSourceExposure, sourceExposureKey } from '../src/web/source-exposure.ts';

const concept = { id: 'shared-concept', source: { path: 'Math/Example.md', revision: 'v1' } };

test('viewing a concept only marks that source and content revision as exposed', () => {
  const keys = parseSourceExposure(JSON.stringify([sourceExposureKey('source-a', concept)]));
  assert.equal(keys.includes(sourceExposureKey('source-a', concept)), true);
  assert.equal(keys.includes(sourceExposureKey('source-b', concept)), false);
  assert.equal(keys.includes(sourceExposureKey('source-a', { ...concept, source: { ...concept.source, revision: 'v2' } })), false);
  assert.equal(keys.includes(sourceExposureKey('source-a', { ...concept, id: 'different-concept' })), false);
});

test('legacy unscoped markers and damaged session storage never imply known exposure', () => {
  for (const value of [null, 'bad-json', '{}', '["shared-concept"]', '[42]', '["[]"]']) {
    assert.deepEqual(parseSourceExposure(value), []);
  }
  const valid = sourceExposureKey('source-a', concept);
  assert.deepEqual(parseSourceExposure(JSON.stringify(['unscoped-old-id', valid, '["", "id", "v1"]'])), [valid]);
});
