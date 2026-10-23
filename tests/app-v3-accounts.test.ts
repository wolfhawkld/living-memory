import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Accounts } from '../src/server/accounts.js';
import { Store } from '../src/server/store.js';
import { appV3Fixture, V3_NOW } from './helpers/app-v3-fixture.js';

const credentials = { username: 'owner', password: 'synthetic-owner-password' };
const memberCredentials = { username: 'member', password: 'synthetic-member-password' };
const headers = (session: { writeToken: string; sourceId: string }) => ({ 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId });
async function owner(f: Awaited<ReturnType<typeof appV3Fixture>>) {
  const response = await f.send('/api/auth/setup', { method: 'POST', protocol: null, body: credentials });
  assert.equal(response.status, 201, response.text);
  const session = (await f.send('/api/session', { cookie: response.cookie, protocol: null })).body;
  return { cookie: response.cookie, session, headers: headers(session) };
}

test('App3 preserves owner data and isolates restored unvisited and newly created member spaces', async () => {
  const f = await appV3Fixture({ accountsEnabled: true });
  try {
    const concept = f.app.livingMemory.getSource().index.concepts[0];
    f.app.livingMemory.store.addReview({ eventId: 'owner-existing-review', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review' });
    f.app.livingMemory.store.updateConfig(9, 1);
    assert.equal((await f.send('/api/session', { protocol: null })).status, 401);
    const auth = await owner(f); assert.equal(auth.session.learningProtocolVersion, 3);
    const accounts = new Accounts({ dataDir: f.dataDir, now: () => new Date(V3_NOW) });
    const unvisited = await accounts.createUser('unvisited', 'synthetic-unvisited-password'); accounts.close();
    const absentRoot = join(f.dataDir, 'users', unvisited.id, 'knowledge');
    assert.equal(existsSync(absentRoot), false);
    const login = await f.send('/api/auth/login', { method: 'POST', protocol: null, body: { username: 'unvisited', password: 'synthetic-unvisited-password' } });
    assert.equal(login.status, 200); assert.equal(existsSync(absentRoot), false);
    assert.equal((await f.send('/api/snapshot', { cookie: login.cookie, protocol: '2' })).status, 426);
    assert.equal(existsSync(absentRoot), false, 'old protocol is rejected before lazy namespace or directory creation');
    const unvisitedSession = (await f.send('/api/session', { cookie: login.cookie, protocol: null })).body;
    assert.ok(existsSync(absentRoot)); assert.notEqual(unvisitedSession.sourceId, auth.session.sourceId);
    const unvisitedSnapshot = (await f.send('/api/snapshot', { cookie: login.cookie })).body;
    assert.equal(unvisitedSnapshot.config.halfLifeDays, 7); assert.equal(unvisitedSnapshot.concepts.length, 0);

    const created = await f.send('/api/admin/users', { method: 'POST', cookie: auth.cookie, headers: auth.headers, body: memberCredentials });
    assert.equal(created.status, 201, created.text);
    const memberRoot = join(f.dataDir, 'users', created.body.user.id, 'knowledge');
    assert.ok(existsSync(memberRoot));
    writeFileSync(join(memberRoot, 'Alpha.md'), '---\ntype: concept\ntitle: Alpha\n---\nMEMBER_SOURCE_SENTINEL\n');
    const memberLogin = await f.send('/api/auth/login', { method: 'POST', protocol: null, body: memberCredentials });
    const member = (await f.send('/api/session', { cookie: memberLogin.cookie })).body;
    const memberHeaders = headers(member);
    assert.notEqual(member.sourceId, auth.session.sourceId); assert.notEqual(member.sourceId, unvisitedSession.sourceId);
    assert.equal((await f.send('/api/refresh', { method: 'POST', cookie: memberLogin.cookie, headers: memberHeaders, body: {} })).status, 200);
    const snapshot = (await f.send('/api/snapshot', { cookie: memberLogin.cookie })).body;
    const privateConcept = snapshot.concepts[0]; assert.notEqual(privateConcept.id, concept.id);
    const request = { eventId: 'member-written', conceptId: privateConcept.id, sourceRevision: privateConcept.source.revision,
      observedAt: V3_NOW, configRevision: 1, anchorEventId: null, answer: 'MEMBER_ANSWER_SENTINEL', rating: 'partial', exposure: 'unexposed', observedExposure: false };
    assert.equal((await f.send('/api/observations', { method: 'POST', cookie: memberLogin.cookie, headers: memberHeaders, body: request })).status, 201);
    const ownExport = await f.send('/api/export', { cookie: auth.cookie });
    assert.equal(ownExport.body.config.halfLifeDays, 9); assert.equal(ownExport.body.anchors[0].eventId, 'owner-existing-review');
    assert.doesNotMatch(ownExport.text, /MEMBER_ANSWER_SENTINEL|MEMBER_SOURCE_SENTINEL/);
    const privateExport = await f.send('/api/export', { cookie: memberLogin.cookie });
    assert.equal(privateExport.body.schemaVersion, 3); assert.equal(privateExport.body.observations[0].answer, request.answer);
    assert.equal((await f.send('/api/export', { cookie: memberLogin.cookie, headers: auth.headers })).status, 409);
    assert.equal((await f.send(`/api/concepts/${concept.id}/history`, { cookie: memberLogin.cookie })).status, 404);
    assert.equal((await f.send('/api/admin/users', { cookie: memberLogin.cookie })).status, 403);
    assert.equal((await f.send('/api/snapshot', { cookie: login.cookie })).body.observationsCount, 0);
    f.restart();
    const after = await f.send('/api/export', { cookie: memberLogin.cookie });
    assert.deepEqual(after.body.observations, privateExport.body.observations);
    assert.equal((await f.send('/api/export', { cookie: auth.cookie })).body.config.halfLifeDays, 9);
  } finally { await f.close(); }
});

test('App3 provisioning failure rolls back account creation and an explicit retry can create it normally', async () => {
  const f = await appV3Fixture({ accountsEnabled: true });
  try {
    const auth = await owner(f);
    writeFileSync(join(f.dataDir, 'users'), 'synthetic path obstacle');
    const failed = await f.send('/api/admin/users', { method: 'POST', cookie: auth.cookie, headers: auth.headers, body: memberCredentials });
    assert.equal(failed.status, 503); assert.equal(failed.body.error.code, 'WRITE_FAILED');
    assert.equal((await f.send('/api/admin/users', { cookie: auth.cookie })).body.users.length, 1);
    assert.equal((await f.send('/api/auth/login', { method: 'POST', body: memberCredentials })).status, 401);
    unlinkSync(join(f.dataDir, 'users'));
    const retry = await f.send('/api/admin/users', { method: 'POST', cookie: auth.cookie, headers: auth.headers, body: memberCredentials });
    assert.equal(retry.status, 201, retry.text); assert.ok(existsSync(join(f.dataDir, 'users', retry.body.user.id, 'knowledge')));
  } finally { await f.close(); }
});

test('App3 closes unpublished Stores after preparation or late account COMMIT failure and retains only an unauthorized empty space', async () => {
  const originalCreate = Accounts.prototype.createUser, originalRemember = Store.prototype.rememberConcepts;
  for (const fault of ['prepare', 'commit'] as const) {
    const f = await appV3Fixture({ accountsEnabled: true });
    let captured: Store<2 | 3> | undefined; let candidateId: string | undefined;
    try {
      const auth = await owner(f), ownerNamespace = auth.session.sourceId;
      Store.prototype.rememberConcepts = function(concepts) {
        if (this.namespace !== ownerNamespace) {
          captured = this;
          if (fault === 'prepare') throw new Error('SYNTHETIC_PREPARATION_FAILURE');
        }
        return originalRemember.call(this, concepts);
      };
      Accounts.prototype.createUser = function(username, password, provision) {
        return originalCreate.call(this, username, password, candidate => {
          candidateId = candidate.id; provision?.(candidate);
          if (fault === 'commit') {
            const db = (this as unknown as { db: DatabaseSync }).db;
            db.exec('CREATE TEMP TABLE test_parent(id INTEGER PRIMARY KEY); CREATE TEMP TABLE test_child(id INTEGER REFERENCES test_parent(id) DEFERRABLE INITIALLY DEFERRED); INSERT INTO test_child VALUES(1)');
          }
        });
      };
      const failed = await f.send('/api/admin/users', { method: 'POST', cookie: auth.cookie, headers: auth.headers, body: memberCredentials });
      assert.equal(failed.status, 503, failed.text); assert.equal(failed.body.error.code, 'WRITE_FAILED');
      assert.doesNotMatch(failed.text, /SYNTHETIC_PREPARATION_FAILURE|FOREIGN KEY|test_child|password/);
      assert.ok(captured); assert.ok(candidateId);
      assert.throws(() => captured!.getConfig(), /closed|open/i, 'unpublished Store connection is closed');
      assert.ok(existsSync(join(f.dataDir, 'users', candidateId, 'knowledge')));
      const reader = new Store({ schemaVersion: 3, dbPath: f.dbPath, namespace: captured.namespace, now: () => new Date(V3_NOW) });
      try { assert.equal(reader.getConfig().revision, 1); assert.deepEqual(reader.getObservations(), []); }
      finally { reader.close(); }
      assert.equal((await f.send('/api/admin/users', { cookie: auth.cookie })).body.users.length, 1);
      assert.equal((await f.send('/api/auth/login', { method: 'POST', body: memberCredentials })).status, 401);
      const accounts = new Accounts({ dataDir: f.dataDir, now: () => new Date(V3_NOW) });
      try { assert.throws(() => accounts.issueSession(candidateId!)); } finally { accounts.close(); }
    } finally {
      Accounts.prototype.createUser = originalCreate; Store.prototype.rememberConcepts = originalRemember;
      await f.close(); // A cached failed context would attempt to close the Store twice.
    }
  }
});
