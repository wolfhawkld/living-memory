import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store, StoreError } from '../src/server/store.js';
import { DEFAULT_IMPORT_OPTIONS, type ImportCommitRequest } from '../src/shared/import-data.js';
import { MODEL_VERSION, type Concept, type ExportData, type ModelConfig } from '../src/shared/types.js';

type ConfigWriteReceipt = ModelConfig & {
  status: 'accepted' | 'duplicate';
  currentConfig: ModelConfig;
};

const concept: Concept = {
  id: 'concept-config-retry',
  title: 'Config retry',
  aliases: [],
  domain: 'Tests',
  summary: 'Config retry fixture',
  body: 'Config retry fixture',
  source: { path: 'Tests/ConfigRetry.md', revision: 'source-revision-1' },
};

const source: ExportData['source'] = {
  name: 'config-retry-tests',
  mode: 'local',
  conceptCount: 1,
  limit: 1,
  diagnostics: [],
};

function openStore(namespace: string, dataDir = mkdtempSync(join(tmpdir(), `living-memory-config-retry-${namespace}-`))): {
  store: Store;
  dataDir: string;
  cleanup: () => void;
} {
  const store = new Store({ dataDir, namespace, now: () => new Date('2026-01-10T12:00:00.000Z') });
  return {
    store,
    dataDir,
    cleanup() {
      try { store.close(); } catch { /* already closed by a restart test */ }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function writeConfig(store: Store, halfLifeDays: number, expectedRevision: number): ConfigWriteReceipt {
  return store.updateConfig(halfLifeDays, expectedRevision) as unknown as ConfigWriteReceipt;
}

function database(store: Store): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

function configRow(store: Store, revision: number): { model_version: string; half_life_days: number; recorded_at: string } {
  return database(store).prepare(`SELECT model_version, half_life_days, recorded_at
    FROM config_history WHERE namespace = ? AND revision = ?`).get(store.namespace, revision) as {
      model_version: string;
      half_life_days: number;
      recorded_at: string;
    };
}

test('the first CAS write is accepted and an exact retry is a duplicate receipt', () => {
  const fixture = openStore('accepted-duplicate');
  try {
    const accepted = writeConfig(fixture.store, 14, 1);
    assert.equal(accepted.status, 'accepted');
    assert.deepEqual(
      { modelVersion: accepted.modelVersion, halfLifeDays: accepted.halfLifeDays, revision: accepted.revision },
      { modelVersion: MODEL_VERSION, halfLifeDays: 14, revision: 2 },
    );
    assert.deepEqual(accepted.currentConfig, { modelVersion: MODEL_VERSION, halfLifeDays: 14, revision: 2 });

    const duplicate = writeConfig(fixture.store, 14, 1);
    assert.equal(duplicate.status, 'duplicate');
    assert.deepEqual(
      { modelVersion: duplicate.modelVersion, halfLifeDays: duplicate.halfLifeDays, revision: duplicate.revision },
      { modelVersion: MODEL_VERSION, halfLifeDays: 14, revision: 2 },
    );
    assert.deepEqual(duplicate.currentConfig, { modelVersion: MODEL_VERSION, halfLifeDays: 14, revision: 2 });
    assert.deepEqual(fixture.store.getConfigHistory(), [
      { modelVersion: MODEL_VERSION, halfLifeDays: 7, revision: 1 },
      { modelVersion: MODEL_VERSION, halfLifeDays: 14, revision: 2 },
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('an exact stale retry returns its historical config while preserving a later current config', () => {
  const fixture = openStore('later-version');
  try {
    writeConfig(fixture.store, 14, 1);
    const later = writeConfig(fixture.store, 21, 2);
    const before = fixture.store.getConfigHistory();
    const retry = writeConfig(fixture.store, 14, 1);

    assert.equal(retry.status, 'duplicate');
    assert.deepEqual(
      { modelVersion: retry.modelVersion, halfLifeDays: retry.halfLifeDays, revision: retry.revision },
      { modelVersion: MODEL_VERSION, halfLifeDays: 14, revision: 2 },
    );
    assert.deepEqual(retry.currentConfig, later.currentConfig);
    assert.deepEqual(fixture.store.getConfig(), { modelVersion: MODEL_VERSION, halfLifeDays: 21, revision: 3 });
    assert.deepEqual(fixture.store.getConfigHistory(), before);
  } finally {
    fixture.cleanup();
  }
});

test('a stale request conflicts when only the latest H matches but base+1 has a different H', () => {
  const fixture = openStore('current-h-conflict');
  try {
    writeConfig(fixture.store, 14, 1);
    writeConfig(fixture.store, 21, 2);
    const before = fixture.store.getConfigHistory();

    assert.throws(
      () => writeConfig(fixture.store, 21, 1),
      (error: unknown) => error instanceof StoreError && error.code === 'CONFIG_CONFLICT' && error.status === 409,
    );
    assert.deepEqual(fixture.store.getConfigHistory(), before);
    assert.deepEqual(fixture.store.getConfig(), { modelVersion: MODEL_VERSION, halfLifeDays: 21, revision: 3 });
  } finally {
    fixture.cleanup();
  }
});

test('a stale retry requires the current model version in the historical base+1 row', () => {
  const fixture = openStore('model-version-conflict');
  try {
    writeConfig(fixture.store, 14, 1);
    const rowBefore = configRow(fixture.store, 2);
    database(fixture.store).prepare(`UPDATE config_history SET model_version = ?
      WHERE namespace = ? AND revision = 2`).run('future-model-v2', fixture.store.namespace);

    assert.throws(
      () => writeConfig(fixture.store, 14, 1),
      (error: unknown) => error instanceof StoreError && error.code === 'CONFIG_CONFLICT' && error.status === 409,
    );
    const current = fixture.store.getConfig();
    assert.equal(current.halfLifeDays, 14);
    assert.equal(current.revision, 2);
    assert.equal(configRow(fixture.store, 2).half_life_days, rowBefore.half_life_days);
  } finally {
    fixture.cleanup();
  }
});

test('config retry state is namespace-isolated and an exact duplicate survives Store restart', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-config-retry-shared-'));
  const first = openStore('namespace-a', dataDir);
  const other = openStore('namespace-b', dataDir);
  let reopened: Store | null = null;
  try {
    const accepted = writeConfig(first.store, 14, 1);
    assert.equal(accepted.status, 'accepted');
    assert.equal(writeConfig(other.store, 14, 1).status, 'accepted');
    assert.equal(other.store.getConfig().revision, 2);

    first.store.close();
    reopened = new Store({ dataDir, namespace: 'namespace-a', now: () => new Date('2026-01-10T12:00:00.000Z') });
    const duplicate = writeConfig(reopened, 14, 1);
    assert.equal(duplicate.status, 'duplicate');
    assert.deepEqual(
      { modelVersion: duplicate.modelVersion, halfLifeDays: duplicate.halfLifeDays, revision: duplicate.revision },
      { modelVersion: MODEL_VERSION, halfLifeDays: 14, revision: 2 },
    );
    assert.deepEqual(reopened.getConfig(), { modelVersion: MODEL_VERSION, halfLifeDays: 14, revision: 2 });
    assert.deepEqual(other.store.getConfig(), { modelVersion: MODEL_VERSION, halfLifeDays: 14, revision: 2 });
  } finally {
    try { reopened?.close(); } catch { /* already closed */ }
    try { other.store.close(); } catch { /* already closed */ }
    try { first.store.close(); } catch { /* already closed */ }
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('config retries do not rewrite frozen observations or historical config recorded_at', () => {
  const fixture = openStore('frozen-history');
  try {
    const anchor = fixture.store.addReview({
      eventId: 'config-retry-anchor',
      conceptId: concept.id,
      sourceRevision: concept.source.revision,
      kind: 'review',
    });
    assert.equal(anchor.status, 'accepted');
    const observationInput = {
      eventId: 'config-retry-observation',
      conceptId: concept.id,
      sourceRevision: concept.source.revision,
      observedAt: '2026-01-10T12:00:00.000Z',
      configRevision: 1,
      anchorEventId: 'config-retry-anchor',
      answer: 'remembered',
      rating: 'partial' as const,
      exposure: 'unexposed' as const,
      observedExposure: false,
    };
    assert.equal(fixture.store.addObservation(observationInput, 'config-retry-anchor').status, 'accepted');
    const beforeObservation = fixture.store.getObservations();
    const beforeConfig = configRow(fixture.store, 1);

    assert.equal(writeConfig(fixture.store, 14, 1).status, 'accepted');
    assert.equal(writeConfig(fixture.store, 14, 1).status, 'duplicate');
    assert.deepEqual(fixture.store.getObservations(), beforeObservation);
    assert.deepEqual(configRow(fixture.store, 1), beforeConfig);
    assert.deepEqual(fixture.store.getObservations()[0], {
      ...beforeObservation[0],
      configRevision: 1,
      halfLifeDays: 7,
    });
  } finally {
    fixture.cleanup();
  }
});

test('a config insert failure rolls back the CAS transaction completely', () => {
  const fixture = openStore('insert-rollback');
  try {
    database(fixture.store).exec(`CREATE TRIGGER fail_config_insert
      BEFORE INSERT ON config_history
      WHEN NEW.namespace = 'insert-rollback' AND NEW.revision = 2
      BEGIN SELECT RAISE(ABORT, 'forced config failure'); END;`);

    assert.throws(
      () => writeConfig(fixture.store, 14, 1),
      (error: unknown) => error instanceof StoreError && error.code === 'WRITE_FAILED',
    );
    assert.deepEqual(fixture.store.getConfig(), { modelVersion: MODEL_VERSION, halfLifeDays: 7, revision: 1 });
    assert.deepEqual(fixture.store.getConfigHistory(), [
      { modelVersion: MODEL_VERSION, halfLifeDays: 7, revision: 1 },
    ]);
    assert.equal((database(fixture.store).prepare('SELECT COUNT(*) AS count FROM config_history WHERE namespace = ?').get(fixture.store.namespace) as { count: number }).count, 1);

    database(fixture.store).exec('DROP TRIGGER fail_config_insert');
    assert.equal(writeConfig(fixture.store, 14, 1).status, 'accepted');
  } finally {
    fixture.cleanup();
  }
});

test('restored config history permits an exact historical retry', () => {
  const donor = openStore('config-retry-donor');
  const target = openStore('config-retry-target');
  try {
    writeConfig(donor.store, 14, 1);
    const data = donor.store.exportData(source, [concept]);
    const options = { ...DEFAULT_IMPORT_OPTIONS };
    const preview = target.store.previewImport(data, options, source, [concept]);
    assert.equal(preview.canImport, true, JSON.stringify(preview.issues));
    const request: ImportCommitRequest = {
      data,
      options,
      importId: 'config-retry-restore',
      previewToken: preview.token,
      confirmed: true,
    };
    const receipt = target.store.commitImport(request, source, [concept], () => 'backup-config-retry');
    assert.equal(receipt.status, 'accepted');
    assert.deepEqual(target.store.getConfigHistory(), data.configHistory);

    const duplicate = writeConfig(target.store, 14, 1);
    assert.equal(duplicate.status, 'duplicate');
    assert.deepEqual(
      { modelVersion: duplicate.modelVersion, halfLifeDays: duplicate.halfLifeDays, revision: duplicate.revision },
      { modelVersion: MODEL_VERSION, halfLifeDays: 14, revision: 2 },
    );
    assert.deepEqual(duplicate.currentConfig, { modelVersion: MODEL_VERSION, halfLifeDays: 14, revision: 2 });
    assert.deepEqual(target.store.getConfigHistory(), data.configHistory);
  } finally {
    target.cleanup();
    donor.cleanup();
  }
});
