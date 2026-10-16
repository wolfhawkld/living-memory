import assert from 'node:assert/strict';
import test from 'node:test';
import { createPerformanceFixture, PERFORMANCE_FIXTURE_ID } from '../src/web/performance-fixture';

test('performance fixture deterministically produces 300 concepts, 1000 unique valid edges and finite layouts', () => {
  const first = createPerformanceFixture(); const second = createPerformanceFixture();
  assert.deepEqual(first, second); assert.equal(first.snapshot.concepts.length, 300); assert.equal(first.snapshot.links.length, 1000);
  const ids = new Set(first.snapshot.concepts.map((concept) => concept.id));
  assert.equal(ids.size, 300); assert.equal(new Set(first.snapshot.links.map((link) => link.id)).size, 1000);
  assert.equal(new Set(first.snapshot.links.map((link) => [link.source, link.target].sort().join('|'))).size, 1000);
  for (const link of first.snapshot.links) { assert.ok(ids.has(link.source) && ids.has(link.target)); assert.notEqual(link.source, link.target); }
  for (const concept of first.snapshot.concepts) {
    assert.ok(Object.values(first.layout[concept.id]).every(Number.isFinite)); assert.equal(first.snapshot.states[concept.id].conceptId, concept.id);
  }
  assert.equal(first.snapshot.source.name, PERFORMANCE_FIXTURE_ID); assert.equal(first.snapshot.source.mode, 'demo');
  assert.equal(first.snapshot.observationsCount, 0); assert.equal(first.snapshot.asOf, '2026-01-01T00:00:00.000Z');
});

test('every fixture invocation owns fresh in-memory data instead of sharing mutable graph state', () => {
  const first = createPerformanceFixture(); first.snapshot.concepts[0].title = 'changed'; first.layout[first.snapshot.concepts[0].id].x = 999;
  const fresh = createPerformanceFixture(); assert.notEqual(fresh.snapshot.concepts[0].title, 'changed'); assert.notEqual(fresh.layout[fresh.snapshot.concepts[0].id].x, 999);
});
