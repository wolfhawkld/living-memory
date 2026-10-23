import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { DEFAULT_HALF_LIFE_DAYS, MODEL_VERSION } from '../src/shared/types.js';
import { initializeAnswerClearingSchemaV3 } from '../src/server/answer-clearing-schema.js';
import { initializeLearningSchemaV2 } from '../src/server/learning-schema.js';
import { assertLearningDatabaseV3Ready, ensureLearningNamespaceV3, type LearningNamespaceV3Preparation } from '../src/server/learning-namespace-v3.js';
import { StoreError } from '../src/server/store-error.js';
import { Store } from '../src/server/store.js';

const INSTANT = '2026-10-23T10:00:00.000Z';
const NAMESPACE = 'kg_synthetic_member';
function fixture(initialize = true) {
  const dir = mkdtempSync(join(tmpdir(), 'lm-namespace-v3-'));
  const dbPath = join(dir, 'learning.sqlite');
  const db = new DatabaseSync(dbPath);
  if (initialize) {
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    initializeAnswerClearingSchemaV3(db, { recordedAt: INSTANT });
    db.exec('COMMIT');
  }
  return { dir, dbPath, db, close() { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function code(expected: string) {
  return (error: unknown) => error instanceof StoreError && error.code === expected
    && error.status === 503 && error.message === expected;
}
function rowCounts(db: DatabaseSync) {
  return db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT count(*) AS n FROM main."${name}"`).get()!.n]);
}
function seed(db: DatabaseSync, target = NAMESPACE) {
  db.prepare('INSERT INTO namespaces(namespace,created_at) VALUES (?,?)').run(target, INSTANT);
  db.prepare('INSERT INTO config_history(namespace,revision,model_version,half_life_days,recorded_at) VALUES (?,1,?,7,?)')
    .run(target, MODEL_VERSION, INSTANT);
}

test('v3 gates reject missing, empty, version2, unknown and partial databases without creating or changing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-namespace-gates-'));
  try {
    const missing = join(dir, 'must-not-create', 'learning.sqlite');
    assert.throws(() => assertLearningDatabaseV3Ready(missing), code('LEARNING_SCHEMA_UNSUPPORTED_VERSION'));
    assert.throws(() => ensureLearningNamespaceV3({ dbPath: missing, namespace: NAMESPACE }), code('LEARNING_SCHEMA_UNSUPPORTED_VERSION'));
    assert.equal(existsSync(join(dir, 'must-not-create')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  for (const variant of ['empty', 'version2', 'unknown', 'partial'] as const) {
    const f = fixture(false);
    try {
      if (variant === 'version2') initializeLearningSchemaV2(f.db, { recordedAt: INSTANT });
      if (variant === 'unknown') f.db.exec('PRAGMA user_version=99');
      if (variant === 'partial') {
        f.db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
        initializeAnswerClearingSchemaV3(f.db, { recordedAt: INSTANT });
        f.db.exec('COMMIT; DROP TABLE layouts');
      }
      const before = readFileSync(f.dbPath);
      assert.throws(() => assertLearningDatabaseV3Ready(f.dbPath), code('LEARNING_SCHEMA_UNSUPPORTED_VERSION'));
      assert.throws(() => ensureLearningNamespaceV3({ dbPath: f.dbPath, namespace: NAMESPACE }), code('LEARNING_SCHEMA_UNSUPPORTED_VERSION'));
      assert.deepEqual(readFileSync(f.dbPath), before, variant);
    } finally { f.close(); }
  }
});

test('a read-only v3 gate does not prepare namespaces; explicit preparation creates exactly one default pair', () => {
  const f = fixture();
  try {
    const before = readFileSync(f.dbPath);
    assertLearningDatabaseV3Ready(f.dbPath);
    assert.deepEqual(readFileSync(f.dbPath), before);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM namespaces').get()!.n, 0);
    assert.throws(() => new Store<3>({ dbPath: f.dbPath, namespace: NAMESPACE, schemaVersion: 3 }), code('LEARNING_NAMESPACE_UNAVAILABLE'));
    let clockReads = 0;
    const result = ensureLearningNamespaceV3({ dbPath: f.dbPath, namespace: NAMESPACE,
      now: () => { clockReads++; return new Date('2026-10-23T18:00:00+08:00'); } });
    assert.deepEqual(result, { status: 'created', namespace: NAMESPACE });
    assert.equal(clockReads, 1);
    assert.deepEqual({ ...f.db.prepare('SELECT * FROM namespaces WHERE namespace=?').get(NAMESPACE) },
      { namespace: NAMESPACE, created_at: INSTANT });
    assert.deepEqual({ ...f.db.prepare('SELECT * FROM config_history WHERE namespace=?').get(NAMESPACE) }, {
      namespace: NAMESPACE, revision: 1, model_version: MODEL_VERSION, half_life_days: DEFAULT_HALF_LIFE_DAYS, recorded_at: INSTANT,
    });
    const store = new Store<3>({ dbPath: f.dbPath, namespace: NAMESPACE, schemaVersion: 3 });
    try { assert.equal(store.getConfig().halfLifeDays, DEFAULT_HALF_LIFE_DAYS); } finally { store.close(); }
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM observations').get()!.n, 0);
  } finally { f.close(); }
});

test('already-ready namespaces preserve nonconsecutive valid legacy configurations and timestamp bytes without reading the clock', () => {
  const f = fixture();
  try {
    const time = '2026-10-01T08:00:00+08:00';
    f.db.prepare('INSERT INTO namespaces(namespace,created_at) VALUES (?,?)').run(NAMESPACE, time);
    for (const [revision, halfLife] of [[3, 14], [8, 21.5]]) {
      f.db.prepare('INSERT INTO config_history(namespace,revision,model_version,half_life_days,recorded_at) VALUES (?,?,?,?,?)')
        .run(NAMESPACE, revision, MODEL_VERSION, halfLife, time);
    }
    const before = readFileSync(f.dbPath);
    assert.deepEqual(ensureLearningNamespaceV3({ dbPath: f.dbPath, namespace: NAMESPACE,
      now: () => { throw new Error('Clock must not be read'); } }), { status: 'already-ready', namespace: NAMESPACE });
    assert.deepEqual(readFileSync(f.dbPath), before);
    assert.deepEqual(f.db.prepare('SELECT revision,half_life_days,recorded_at FROM config_history WHERE namespace=? ORDER BY revision').all(NAMESPACE)
      .map(row => ({ ...row })), [{ revision: 3, half_life_days: 14, recorded_at: time }, { revision: 8, half_life_days: 21.5, recorded_at: time }]);
  } finally { f.close(); }
});

test('partial namespaces and orphaned configuration, learning, identity and activity rows are rejected without repair', () => {
  const variants: Array<(db: DatabaseSync) => void> = [
    db => db.prepare('INSERT INTO namespaces VALUES (?,?)').run(NAMESPACE, INSTANT),
    db => db.prepare('INSERT INTO config_history VALUES (?,1,?,7,?)').run(NAMESPACE, MODEL_VERSION, INSTANT),
    db => db.prepare('INSERT INTO anchors VALUES (?,?,?,?,?,?,?,?)').run(NAMESPACE, 'anchor', 'alpha', 'rev-a', INSTANT, INSTANT, 'review', '{}'),
    db => db.prepare('INSERT INTO identity_catalog VALUES (?,?,?,?,?)').run(NAMESPACE, 'alpha', 'Alpha', 'Alpha.md', 'rev-a'),
    db => db.prepare('INSERT INTO import_receipts VALUES (?,?,?,?)').run(NAMESPACE, 'operation', 'synthetic-old-credential', '{}'),
    db => db.prepare('INSERT INTO activity_settings VALUES (?,0,0,1)').run(NAMESPACE),
    db => db.prepare('INSERT INTO review_plans VALUES (?,1,5,?,?)').run(NAMESPACE, '{}', INSTANT),
  ];
  for (const prepare of variants) {
    const f = fixture();
    try {
      prepare(f.db);
      const bytes = readFileSync(f.dbPath), counts = rowCounts(f.db);
      assert.throws(() => ensureLearningNamespaceV3({ dbPath: f.dbPath, namespace: NAMESPACE,
        now: () => { throw new Error('Do not synthesize metadata for a partial namespace'); } }), code('LEARNING_NAMESPACE_UNAVAILABLE'));
      assert.deepEqual(rowCounts(f.db), counts);
      assert.deepEqual(readFileSync(f.dbPath), bytes);
    } finally { f.close(); }
  }
});

test('invalid stored configuration fields or namespace time are rejected instead of silently resetting metadata', () => {
  const updates = [
    "UPDATE namespaces SET created_at='not-a-time'",
    'UPDATE config_history SET revision=0',
    'UPDATE config_history SET revision=1.5',
    "UPDATE config_history SET model_version='unknown-model'",
    'UPDATE config_history SET half_life_days=0',
    'UPDATE config_history SET half_life_days=3651',
    "UPDATE config_history SET recorded_at='2026-10-01T08:00:00'",
    "UPDATE config_history SET recorded_at='2026-02-30T00:00:00Z'",
  ];
  for (const sql of updates) {
    const f = fixture();
    try {
      seed(f.db); f.db.exec(sql);
      const bytes = readFileSync(f.dbPath);
      assert.throws(() => ensureLearningNamespaceV3({ dbPath: f.dbPath, namespace: NAMESPACE }), code('LEARNING_NAMESPACE_UNAVAILABLE'));
      assert.deepEqual(readFileSync(f.dbPath), bytes);
    } finally { f.close(); }
  }
});

test('invalid namespace or new timestamp fails with fixed messages and no namespace/config side effects', () => {
  const f = fixture();
  try {
    const counts = rowCounts(f.db);
    for (const target of ['', ' leading', 'trailing ', 'bad\nnamespace', 'x'.repeat(257)]) {
      assert.throws(() => ensureLearningNamespaceV3({ dbPath: f.dbPath, namespace: target }), error => error instanceof StoreError
        && error.code === 'LEARNING_NAMESPACE_INVALID' && error.message === error.code && !error.message.includes(f.dbPath));
    }
    assert.throws(() => ensureLearningNamespaceV3({ dbPath: f.dbPath, namespace: NAMESPACE,
      now: () => new Date('invalid') }), code('LEARNING_NAMESPACE_TIME_INVALID'));
    assert.throws(() => ensureLearningNamespaceV3({ dbPath: f.dbPath, namespace: NAMESPACE,
      now: () => { throw new Error(`SYNTHETIC_PRIVATE ${f.dbPath}`); } }), code('LEARNING_NAMESPACE_PREPARE_FAILED'));
    assert.deepEqual(rowCounts(f.db), counts);
  } finally { f.close(); }
});

test('a late configuration insert failure rolls back the actual namespace insert and returns only a fixed error', t => {
  const f = fixture();
  const originalPrepare = DatabaseSync.prototype.prepare;
  let namespaceInserted = false;
  try {
    const before = rowCounts(f.db);
    t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (sql.startsWith('INSERT INTO main.namespaces')) {
        const run = statement.run.bind(statement);
        t.mock.method(statement, 'run', (...args: Parameters<typeof statement.run>) => {
          const result = run(...args); namespaceInserted = true; return result;
        });
      }
      if (sql.startsWith('INSERT INTO main.config_history')) t.mock.method(statement, 'run', () => {
        throw new Error(`SYNTHETIC_PRIVATE ${f.dbPath}`);
      });
      return statement;
    });
    assert.throws(() => ensureLearningNamespaceV3({ dbPath: f.dbPath, namespace: NAMESPACE, now: () => new Date(INSTANT) }), code('LEARNING_NAMESPACE_PREPARE_FAILED'));
    assert.equal(namespaceInserted, true);
    t.mock.restoreAll();
    assert.deepEqual(rowCounts(f.db), before);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM namespaces WHERE namespace=?').get(NAMESPACE)!.n, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM config_history WHERE namespace=?').get(NAMESPACE)!.n, 0);
  } finally { t.mock.restoreAll(); f.close(); }
});

test('a competing write lock remains owned by its connection and helper failure leaves no partial namespace', () => {
  const f = fixture();
  try {
    f.db.exec('BEGIN IMMEDIATE');
    f.db.prepare('INSERT INTO namespaces VALUES (?,?)').run('outer-owner', INSTANT);
    assert.throws(() => ensureLearningNamespaceV3({ dbPath: f.dbPath, namespace: NAMESPACE }), code('LEARNING_NAMESPACE_PREPARE_FAILED'));
    assert.equal(f.db.isTransaction, true);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM namespaces WHERE namespace='outer-owner'").get()!.n, 1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM namespaces WHERE namespace=?').get(NAMESPACE)!.n, 0);
    f.db.exec('ROLLBACK');
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM namespaces WHERE namespace='outer-owner'").get()!.n, 0);
    assert.equal(ensureLearningNamespaceV3({ dbPath: f.dbPath, namespace: NAMESPACE, now: () => new Date(INSTANT) }).status, 'created');
  } finally { f.close(); }
});

test('two real processes preparing the same new namespace serialize to one created pair and one unchanged ready result', { timeout: 25_000 }, async () => {
  const f = fixture();
  const children: ChildProcess[] = [];
  try {
    const module = new URL('../src/server/learning-namespace-v3.ts', import.meta.url).href;
    const script = `import {ensureLearningNamespaceV3} from ${JSON.stringify(module)};
      process.on('message', message => {
        if (message !== 'START') { process.exitCode=1; process.disconnect(); return; }
        try {
          const result=ensureLearningNamespaceV3({dbPath:process.argv[1],namespace:process.argv[2],now:()=>new Date(process.argv[3])});
          process.send({kind:'result',result}, error=>{if(error)process.exitCode=1;process.disconnect();});
        } catch(error) {
          process.send({kind:'error',code:typeof error.code==='string'?error.code:'CHILD_FAILED'},()=>{process.exitCode=1;process.disconnect();});
        }
      });
      process.send({kind:'ready'});`;
    const runs = [INSTANT, '2026-10-23T10:00:01.000Z'].map(clock => {
      const child = spawn(process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script, f.dbPath, NAMESPACE, clock],
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.push(child);
      let readyResolve!: () => void, readyReject!: (error: Error) => void;
      let resultResolve!: (result: LearningNamespaceV3Preparation) => void, resultReject!: (error: Error) => void;
      let exitResolve!: () => void, exitReject!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      const result = new Promise<LearningNamespaceV3Preparation>((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
      const exited = new Promise<void>((resolve, reject) => { exitResolve = resolve; exitReject = reject; });
      void result.catch(() => {}); void exited.catch(() => {});
      let sawReady = false, sawResult = false, stderr = '';
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fail = (error: Error) => { if (timer) clearTimeout(timer); readyReject(error); resultReject(error); exitReject(error); child.kill(); };
      timer = setTimeout(() => fail(new Error('namespace child timed out before READY/result/exit')), 12_000);
      child.stderr!.on('data', chunk => { stderr += chunk; });
      child.on('error', fail);
      child.on('message', (message: unknown) => {
        const value = message as { kind?: string; result?: LearningNamespaceV3Preparation; code?: string };
        if (value.kind === 'ready' && !sawReady) { sawReady = true; readyResolve(); return; }
        if (value.kind === 'result' && sawReady && !sawResult && value.result) {
          sawResult = true; resultResolve(value.result); return;
        }
        fail(new Error(value.kind === 'error' ? value.code ?? 'namespace child failed' : 'namespace child sent an invalid IPC sequence'));
      });
      child.on('exit', (status, signal) => {
        if (timer) clearTimeout(timer);
        if (status !== 0 || signal || !sawReady || !sawResult) {
          fail(new Error(`namespace child exit ${status}/${signal}, READY=${sawReady}, result=${sawResult}: ${stderr}`));
        } else exitResolve();
      });
      return { child, clock, ready, result, exited, fail };
    });
    await Promise.all(runs.map(run => run.ready));
    for (const run of runs) run.child.send('START', error => { if (error) run.fail(error); });
    const results = await Promise.all(runs.map(async run => ({ clock: run.clock, result: await run.result })));
    await Promise.all(runs.map(run => run.exited));
    assert.deepEqual(results.map(({ result }) => result.status).sort(), ['already-ready', 'created']);
    for (const { result } of results) assert.equal(result.namespace, NAMESPACE);
    const winner = results.find(({ result }) => result.status === 'created')!;
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM namespaces WHERE namespace=?').get(NAMESPACE)!.n, 1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM config_history WHERE namespace=?').get(NAMESPACE)!.n, 1);
    assert.equal(f.db.prepare('SELECT created_at FROM namespaces WHERE namespace=?').get(NAMESPACE)!.created_at, winner.clock);
    assert.deepEqual({ ...f.db.prepare('SELECT revision,model_version,half_life_days,recorded_at FROM config_history WHERE namespace=?').get(NAMESPACE) },
      { revision: 1, model_version: MODEL_VERSION, half_life_days: DEFAULT_HALF_LIFE_DAYS, recorded_at: winner.clock });
  } finally { for (const child of children) if (child.exitCode === null) child.kill(); f.close(); }
});
